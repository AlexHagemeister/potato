// The countries TMDB has streaming data for (JustWatch's coverage), for the
// country picker. Kept in its own file beside the client, so it adds to the
// TMDB module without touching client.ts.

import type { CacheStore } from "../cache/cache-store";
import { TMDB_CACHE_VERSION, TMDB_LANGUAGE, TMDB_TTL_MS } from "./constants";
import { buildPath, tmdbGet, type FetchFn, type SleepFn } from "./http";

export interface WatchRegion {
  /** ISO 3166-1 alpha-2 code ("US"). */
  code: string;
  /** English name ("United States"). */
  name: string;
}

export interface WatchRegionOptions {
  token: string;
  cache: CacheStore;
  fetch?: FetchFn;
  sleep?: SleepFn;
  now?: () => Date;
}

/** TMDB's watch-provider countries, sorted by English name. Cached for as long as a provider list. */
export async function getWatchRegions(options: WatchRegionOptions): Promise<WatchRegion[]> {
  const now = options.now ?? (() => new Date());
  const pathWithQuery = buildPath("/watch/providers/regions", { language: TMDB_LANGUAGE });
  const key = `tmdb:v${TMDB_CACHE_VERSION}:regions:${pathWithQuery}`;

  try {
    const entry = await options.cache.get(key);
    if (entry && entry.expiresAt.getTime() > now().getTime()) return entry.data as WatchRegion[];
  } catch (err) {
    console.warn(`tmdb cache read failed for ${key}:`, err);
  }

  const raw = await tmdbGet(
    {
      token: options.token,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      now: () => now().getTime(),
    },
    pathWithQuery,
  );
  const regions = normalizeRegions(raw);

  try {
    await options.cache.set(key, regions, new Date(now().getTime() + TMDB_TTL_MS.providerList));
  } catch (err) {
    console.warn(`tmdb cache write failed for ${key}:`, err);
  }
  return regions;
}

/** Keeps entries with a valid two-letter code, one per code, sorted by name. */
export function normalizeRegions(raw: unknown): WatchRegion[] {
  const results = (raw as { results?: { iso_3166_1?: unknown; english_name?: unknown }[] } | null)?.results ?? [];
  const byCode = new Map<string, WatchRegion>();
  for (const r of results) {
    if (typeof r.iso_3166_1 !== "string" || !/^[A-Z]{2}$/.test(r.iso_3166_1)) continue;
    const name = typeof r.english_name === "string" && r.english_name.trim() ? r.english_name.trim() : r.iso_3166_1;
    byCode.set(r.iso_3166_1, { code: r.iso_3166_1, name });
  }
  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}
