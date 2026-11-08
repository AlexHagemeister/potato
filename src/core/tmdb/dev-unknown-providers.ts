// Development-only test seam (issue 30): makes chosen titles' streaming
// availability unknown, the state a TMDB outage leaves when nothing is
// cached, so a walk in the running app can see how a card shows it. TMDB is
// called from the server, so a browser test harness can't intercept it.
//
// For each listed title it hides the cached providers entry and fails the
// providers request, which runs the client's real "refresh failed, nothing
// cached" path. It writes nothing. A title whose details are not cached yet
// still loads its providers with the details (one request): open it once,
// then again, to see the unknown state.
//
// It must never work in a production build, on Vercel, or against any
// database but potato_dev: the same three checks as the dev login, plus an
// explicit opt-in variable set only on the dev server's command line.

import { DEV_DATABASE_NAME, databaseNameFromUrl } from "../auth/dev-user";
import type { CacheEntry, CacheStore } from "../cache/cache-store";
import { formatTitleKey, parseTitleKey } from "../title-id";
import type { FetchFn } from "./http";

/** The opt-in variable: title keys, comma-separated ("movie:603,tv:1399"). */
export const DEV_UNKNOWN_PROVIDERS_VAR = "POTATO_DEV_TMDB_UNKNOWN_PROVIDERS";

export interface DevUnknownProvidersEnv {
  /**
   * The caller must pass the literal `process.env.NODE_ENV`, which Next.js
   * replaces with "production" when it builds, so a production build can't
   * turn the seam on by setting NODE_ENV at runtime.
   */
  nodeEnv: string | undefined;
  /** process.env.VERCEL_ENV. Vercel sets it on every deployment, preview included. */
  vercelEnv: string | undefined;
  /** process.env.DATABASE_URL. */
  databaseUrl: string | undefined;
  /** process.env[DEV_UNKNOWN_PROVIDERS_VAR]. */
  titles: string | undefined;
}

/**
 * The title keys whose availability the seam makes unknown, or null when the
 * seam is off. Off unless NODE_ENV is 'development', VERCEL_ENV is unset,
 * DATABASE_URL names potato_dev, and the opt-in variable lists at least one
 * valid title key. Malformed keys are ignored.
 */
export function devUnknownProviderTitles(env: DevUnknownProvidersEnv): ReadonlySet<string> | null {
  if (env.nodeEnv !== "development" || env.vercelEnv) return null;
  if (databaseNameFromUrl(env.databaseUrl) !== DEV_DATABASE_NAME) return null;
  const keys = new Set<string>();
  for (const part of (env.titles ?? "").split(",")) {
    const id = parseTitleKey(part.trim());
    if (id) keys.add(formatTitleKey(id));
  }
  return keys.size > 0 ? keys : null;
}

/** The title key a providers cache key or providers request path is about, or null. */
function providersTitle(s: string): string | null {
  const m = /\/(movie|tv)\/(\d+)\/watch\/providers(?:$|\?)/.exec(s);
  return m ? `${m[1]}:${m[2]}` : null;
}

/** Wraps a cache store and fetch so the listed titles' providers are never cached and never load. */
export function withUnknownProviders(
  titles: ReadonlySet<string>,
  cache: CacheStore,
  fetchFn: FetchFn,
): { cache: CacheStore; fetch: FetchFn } {
  const hidden = (key: string) => key.includes(":providers:") && titles.has(providersTitle(key) ?? "");
  return {
    cache: {
      get: async (key) => (hidden(key) ? null : cache.get(key)),
      getMany: async (keys) => {
        const visible = keys.filter((k) => !hidden(k));
        if (cache.getMany) return cache.getMany(visible);
        const out = new Map<string, CacheEntry>();
        for (const k of visible) {
          const entry = await cache.get(k);
          if (entry) out.set(k, entry);
        }
        return out;
      },
      set: (key, data, expiresAt) => cache.set(key, data, expiresAt),
    },
    fetch: async (input, init) => {
      const title = providersTitle(new URL(input).pathname);
      if (title && titles.has(title)) {
        throw new TypeError(`fetch failed (${DEV_UNKNOWN_PROVIDERS_VAR} simulates a TMDB outage for ${title})`);
      }
      return fetchFn(input, init);
    },
  };
}
