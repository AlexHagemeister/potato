// The one place that sends HTTP requests to TMDB. It retries HTTP 429 and
// 5xx responses and timeouts with bounded backoff, honoring Retry-After (TMDB publishes no
// fixed rate limit, so the module reacts to 429 instead of pacing itself).

import {
  TMDB_API_BASE,
  TMDB_BASE_BACKOFF_MS,
  TMDB_MAX_BACKOFF_MS,
  TMDB_MAX_RETRIES,
  TMDB_REQUEST_TIMEOUT_MS,
} from "./constants";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

export interface TmdbHttpOptions {
  token: string;
  fetch: FetchFn;
  sleep: SleepFn;
  /** Current time in ms, for HTTP-date Retry-After values. */
  now: () => number;
  maxRetries?: number;
  /** Per-attempt timeout. Defaults to TMDB_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type Params = Record<string, string | number | boolean | undefined>;

/** Builds a path with its query string, keys sorted, undefined values left out. Also the stable part of cache keys. */
export function buildPath(path: string, params: Params = {}): string {
  const query = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value !== undefined) query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * GET a TMDB path (with query string). Resolves to the parsed JSON body, or
 * null on 404. Throws TmdbError for any other failure after retries.
 */
export async function tmdbGet(opts: TmdbHttpOptions, pathWithQuery: string): Promise<unknown | null> {
  const maxRetries = opts.maxRetries ?? TMDB_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? TMDB_REQUEST_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    let body: unknown;
    try {
      res = await opts.fetch(`${TMDB_API_BASE}${pathWithQuery}`, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) body = await res.json();
    } catch (err) {
      if (!isTimeout(err)) throw err;
      if (attempt >= maxRetries) {
        throw new TmdbError(`TMDB timed out after ${timeoutMs} ms for ${pathWithQuery.split("?")[0]}`, 0, pathWithQuery);
      }
      await opts.sleep(retryDelayMs(null, attempt, opts.now()));
      continue;
    }

    if (res.ok) return body;
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      const detail = await res.text().catch(() => "");
      throw new TmdbError(
        `TMDB ${res.status} for ${pathWithQuery.split("?")[0]}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        res.status,
        pathWithQuery,
      );
    }

    await res.body?.cancel();
    await opts.sleep(retryDelayMs(res.headers.get("retry-after"), attempt, opts.now()));
  }
}

/** True for the abort that AbortSignal.timeout raises. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * How long to wait before retry number `attempt + 1`. Retry-After may be
 * seconds or an HTTP date. Without it, back off exponentially. Always capped.
 */
export function retryDelayMs(retryAfter: string | null, attempt: number, nowMs: number): number {
  const fallback = TMDB_BASE_BACKOFF_MS * 2 ** attempt;
  let ms = fallback;
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      ms = Math.max(0, seconds * 1000);
    } else {
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) ms = Math.max(0, at - nowMs);
    }
  }
  return Math.min(ms, TMDB_MAX_BACKOFF_MS);
}
