// The one place that sends HTTP requests to TMDB. It retries HTTP 429 and 5xx
// responses, network errors, and timeouts with bounded backoff, honoring
// Retry-After (TMDB publishes no fixed rate limit, so the module reacts to 429
// instead of pacing itself). Every failure surfaces as TmdbError.

import {
  TMDB_API_BASE,
  TMDB_BASE_BACKOFF_MS,
  TMDB_MAX_BACKOFF_MS,
  TMDB_MAX_RETRIES,
  TMDB_REQUEST_TIMEOUT_MS,
} from "./constants";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

/** Every failure tmdbGet reports. `status` is the HTTP status, or 0 when no response arrived (network error or timeout). */
export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
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
 * null on 404. Every other failure throws TmdbError:
 * - HTTP 429 and 5xx, network errors (a reset socket, a DNS failure), and
 *   timeouts are retried with bounded backoff, then thrown;
 * - other HTTP errors, and a 2xx body that is not JSON, throw at once.
 */
export async function tmdbGet(opts: TmdbHttpOptions, pathWithQuery: string): Promise<unknown | null> {
  const maxRetries = opts.maxRetries ?? TMDB_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? TMDB_REQUEST_TIMEOUT_MS;
  const route = pathWithQuery.split("?")[0];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    let text = "";
    try {
      res = await opts.fetch(`${TMDB_API_BASE}${pathWithQuery}`, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) text = await res.text();
    } catch (err) {
      // fetch and the body read throw only when no full response arrived:
      // a timeout or a network failure (TypeError "fetch failed" in Node and
      // Bun). Both are worth another try.
      const what = isTimeout(err) ? `timed out after ${timeoutMs} ms` : `network error (${errorText(err)})`;
      if (attempt >= maxRetries) {
        throw new TmdbError(`TMDB ${what} for ${route}, after ${attempt + 1} attempts`, 0, pathWithQuery, { cause: err });
      }
      await opts.sleep(retryDelayMs(null, attempt, opts.now()));
      continue;
    }

    if (res.ok) {
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        throw new TmdbError(`TMDB sent a body that is not JSON for ${route}`, res.status, pathWithQuery, { cause: err });
      }
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      const detail = await res.text().catch(() => "");
      throw new TmdbError(
        `TMDB ${res.status} for ${route}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
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

/** A short description of a network error, with the system code (ECONNRESET and so on) when there is one. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err.cause as { code?: unknown } | undefined)?.code ?? (err as { code?: unknown }).code;
  return typeof code === "string" ? `${err.message}: ${code}` : err.message;
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
