// The TMDB client: the only code that talks to TMDB (CLAUDE.md architecture
// rule 4). Every response goes through the cache store. A title is always
// addressed by (media type, TMDB ID) (rule 1).

import type { CacheStore } from "../cache/cache-store";
import { PostgresCacheStore } from "../cache/postgres-cache-store";
import { mapWithConcurrency } from "../concurrency";
import { formatTitleKey } from "../title-id";
import type { Candidate, MediaType, TitleId } from "../types";
import {
  DISCOVER_VOTE_FLOORS,
  TMDB_CACHE_VERSION,
  TMDB_FANOUT_CONCURRENCY,
  TMDB_LANGUAGE,
  TMDB_TTL_MS,
} from "./constants";
import { buildPath, tmdbGet, type FetchFn, type Params, type SleepFn } from "./http";
import {
  normalizeDetailsCore,
  normalizeListProvider,
  normalizeProviders,
  normalizeRegions,
  normalizeSummary,
  type DetailsCore,
  type RawProvider,
  type RawTitle,
  type RawWatchProviders,
} from "./normalize";
import type {
  CountryProviders,
  DiscoverFilters,
  Genre,
  ProviderListEntry,
  ProvidersByCountry,
  ResultPage,
  TitleDetails,
  TitleSummary,
  WatchProvider,
  WatchRegion,
} from "./types";

/** The discover-backed pools. "for you" comes from recommendations instead. */
export type DiscoverPool = "popular" | "top_rated" | "deep_cuts";

/** Filters TMDB recommendations cannot apply server-side. They are applied to each page after the fetch. */
export type RecommendationFilters = Pick<DiscoverFilters, "genreIds" | "era">;

export interface TmdbClientOptions {
  /** TMDB API read access token (v4 bearer token). */
  token: string;
  cache: CacheStore;
  fetch?: FetchFn;
  sleep?: SleepFn;
  now?: () => Date;
  maxRetries?: number;
}

export type TmdbClient = ReturnType<typeof createTmdbClient>;

/** TMDB serves at most 500 pages of any list. */
const MAX_PAGE = 500;

/**
 * The ways of watching that count as "on my streaming services": by
 * subscription, free, or free with ads. Rent and buy do not count.
 */
export const STREAMING_MONETIZATION = ["flatrate", "free", "ads"] as const;

/** IDs of the services that stream a title in one country, in TMDB's display order, without duplicates. */
function streamingProviderIds(country: CountryProviders | undefined): number[] {
  if (!country) return [];
  return [...new Set(STREAMING_MONETIZATION.flatMap((kind) => country[kind].map((p) => p.id)))];
}

export function createTmdbClient(options: TmdbClientOptions) {
  const now = options.now ?? (() => new Date());
  const http = {
    token: options.token,
    fetch: options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: () => now().getTime(),
    maxRetries: options.maxRetries,
  };
  const cache = options.cache;

  const cacheKey = (kind: string, pathWithQuery: string) => `tmdb:v${TMDB_CACHE_VERSION}:${kind}:${pathWithQuery}`;

  /** The cached entry, fresh or expired, or undefined. A failing cache is treated as a miss, so TMDB still answers. */
  async function readCacheEntry<T>(key: string): Promise<{ data: T; fresh: boolean } | undefined> {
    try {
      const entry = await cache.get(key);
      if (entry) return { data: entry.data as T, fresh: entry.expiresAt.getTime() > now().getTime() };
    } catch (err) {
      console.warn(`tmdb cache read failed for ${key}:`, err);
    }
    return undefined;
  }

  /** The fresh cached value, or undefined. */
  async function readCache<T>(key: string): Promise<T | undefined> {
    const entry = await readCacheEntry<T>(key);
    return entry?.fresh ? entry.data : undefined;
  }

  async function writeCache(key: string, data: unknown, ttlMs: number): Promise<void> {
    try {
      await cache.set(key, data, new Date(now().getTime() + ttlMs));
    } catch (err) {
      console.warn(`tmdb cache write failed for ${key}:`, err);
    }
  }

  /** Cache-through GET. A 404 resolves to null and is not cached. */
  async function cached<T>(kind: string, ttlMs: number, path: string, params: Params, map: (raw: unknown) => T): Promise<T | null> {
    const pathWithQuery = buildPath(path, params);
    const key = cacheKey(kind, pathWithQuery);
    const hit = await readCache<T>(key);
    if (hit !== undefined) return hit;
    const raw = await tmdbGet(http, pathWithQuery);
    if (raw === null) return null;
    const value = map(raw);
    await writeCache(key, value, ttlMs);
    return value;
  }

  const titlePath = (id: TitleId) => {
    formatTitleKey(id); // validates the pair, throws on a bad media type or ID
    return `/${id.mediaType}/${id.tmdbId}`;
  };
  const detailsKey = (id: TitleId) => cacheKey("details", buildPath(titlePath(id), { language: TMDB_LANGUAGE }));
  const providersKey = (id: TitleId) => cacheKey("providers", `${titlePath(id)}/watch/providers`);

  /** Full-details fetches in flight, by title key, so parallel callers on a cold cache share one request. */
  const inflight = new Map<string, Promise<{ core: DetailsCore; providers: ProvidersByCountry } | null>>();

  /**
   * Details and providers come from one request (append_to_response) but are
   * cached apart: details for 7 days, providers for 12 hours. When only the
   * providers have gone stale, only they are refetched.
   *
   * Expired entries are a fallback (judgment call 16): if a refetch fails,
   * the expired copy is served instead of failing the card. `providers` is
   * undefined when availability is unknown (needProviders false, or a failed
   * refresh with nothing cached).
   */
  async function loadDetails(id: TitleId, needProviders: boolean): Promise<{ core: DetailsCore; providers?: ProvidersByCountry } | null> {
    const [core, providers] = await Promise.all([
      readCacheEntry<DetailsCore>(detailsKey(id)),
      needProviders ? readCacheEntry<ProvidersByCountry>(providersKey(id)) : Promise.resolve(undefined),
    ]);

    if (core?.fresh) {
      if (!needProviders || providers?.fresh) return { core: core.data, providers: providers?.data };
      let fresh: ProvidersByCountry | null = null;
      try {
        fresh = await refreshProviders(id, providers?.data);
      } catch (err) {
        console.warn(`tmdb providers refresh failed for ${formatTitleKey(id)}, availability unknown:`, err);
      }
      return { core: core.data, providers: fresh ?? providers?.data };
    }

    const key = formatTitleKey(id);
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchDetails(id).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      return await pending;
    } catch (err) {
      if (core === undefined) throw err;
      console.warn(`tmdb details refetch failed for ${key}, serving stale:`, err);
      return { core: core.data, providers: providers?.data };
    }
  }

  /** One request for a title's details and providers, both written to the cache. Null when TMDB has no such title. */
  async function fetchDetails(id: TitleId): Promise<{ core: DetailsCore; providers: ProvidersByCountry } | null> {
    const raw = (await tmdbGet(
      http,
      buildPath(titlePath(id), {
        language: TMDB_LANGUAGE,
        append_to_response: "external_ids,videos,watch/providers",
        // Trailers in English plus those with no language set.
        include_video_language: "en,null",
      }),
    )) as RawTitle | null;
    if (raw === null) return null;
    const normalized = normalizeDetailsCore(raw, id.mediaType);
    if (normalized === null) return null;
    const freshProviders = normalizeProviders(raw["watch/providers"]);
    await Promise.all([
      writeCache(detailsKey(id), normalized, TMDB_TTL_MS.details),
      writeCache(providersKey(id), freshProviders, TMDB_TTL_MS.titleProviders),
    ]);
    return { core: normalized, providers: freshProviders };
  }

  /** Everything a card shows. Null when TMDB has no such title. */
  async function getTitleDetails(mediaType: MediaType, tmdbId: number): Promise<TitleDetails | null> {
    const loaded = await loadDetails({ mediaType, tmdbId }, true);
    if (!loaded) return null;
    return { ...loaded.core, providersByCountry: loaded.providers ?? {} };
  }

  /**
   * Where a title streams, all countries. Null when TMDB has no such title.
   * An expired entry is served if the refresh fails.
   */
  async function getTitleProviders(id: TitleId): Promise<ProvidersByCountry | null> {
    const entry = await readCacheEntry<ProvidersByCountry>(providersKey(id));
    if (entry?.fresh) return entry.data;
    return refreshProviders(id, entry?.data);
  }

  /**
   * Fetches a title's providers and caches them. If the fetch throws and an
   * expired copy exists, returns that instead. A 404 resolves to null.
   */
  async function refreshProviders(id: TitleId, stale: ProvidersByCountry | undefined): Promise<ProvidersByCountry | null> {
    let raw: RawWatchProviders | null;
    try {
      raw = (await tmdbGet(http, `${titlePath(id)}/watch/providers`)) as RawWatchProviders | null;
    } catch (err) {
      if (stale === undefined) throw err;
      console.warn(`tmdb providers refresh failed for ${formatTitleKey(id)}, serving stale:`, err);
      return stale;
    }
    if (raw === null) return null;
    const providers = normalizeProviders(raw);
    await writeCache(providersKey(id), providers, TMDB_TTL_MS.titleProviders);
    return providers;
  }

  /** One discover page for a pool, filtered server-side by TMDB. */
  async function discover(pool: DiscoverPool, filters: DiscoverFilters, page = 1): Promise<ResultPage<TitleSummary>> {
    const { mediaType } = filters;
    formatTitleKey({ mediaType, tmdbId: 1 }); // validates the media type
    const params: Params = {
      language: TMDB_LANGUAGE,
      page: clampPage(page),
      include_adult: false,
      ...poolParams(pool),
      ...filterParams(filters),
    };
    const result = await cached("discover", TMDB_TTL_MS.discover, `/discover/${mediaType}`, params, (raw) =>
      toPage(raw, () => mediaType),
    );
    return result ?? emptyPage(page);
  }

  /**
   * Titles TMDB recommends from a seed title, for the "for you" pool. TMDB
   * applies no filters to recommendations, so genre and era are applied here.
   * Availability is not known from this endpoint (see attachProviderIds).
   * An unknown seed gives an empty page.
   */
  async function recommendations(seed: TitleId, filters: RecommendationFilters = {}, page = 1): Promise<ResultPage<TitleSummary>> {
    const result = await cached(
      "recommendations",
      TMDB_TTL_MS.discover,
      `${titlePath(seed)}/recommendations`,
      { language: TMDB_LANGUAGE, page: clampPage(page) },
      (raw) => toPage(raw, (r) => mediaTypeOf(r.media_type) ?? seed.mediaType),
    );
    const base = result ?? emptyPage(page);
    return { ...base, results: base.results.filter((t) => matchesLocalFilters(t, filters)) };
  }

  /** Movies and series matching a free-text query. People and other result kinds are dropped. */
  async function searchTitles(query: string, page = 1): Promise<ResultPage<TitleSummary>> {
    const q = query.trim().replace(/\s+/g, " ");
    if (q === "") return emptyPage(1);
    const result = await cached(
      "search",
      TMDB_TTL_MS.search,
      "/search/multi",
      { query: q.toLowerCase(), language: TMDB_LANGUAGE, page: clampPage(page), include_adult: false },
      (raw) => toPage(raw, (r) => mediaTypeOf(r.media_type)),
    );
    return result ?? emptyPage(page);
  }

  async function getGenres(mediaType: MediaType): Promise<Genre[]> {
    formatTitleKey({ mediaType, tmdbId: 1 });
    const genres = await cached("genres", TMDB_TTL_MS.genres, `/genre/${mediaType}/list`, { language: TMDB_LANGUAGE }, (raw) =>
      ((raw as { genres?: { id?: number; name?: string }[] }).genres ?? [])
        .filter((g): g is Genre => Number.isSafeInteger(g.id) && typeof g.name === "string")
        .map((g) => ({ id: g.id, name: g.name })),
    );
    return genres ?? [];
  }

  /**
   * The streaming services available in a country, for movies and series
   * together, in TMDB's display order for that country.
   */
  async function getProviderList(country: string): Promise<ProviderListEntry[]> {
    const region = checkCountry(country);
    const lists = await Promise.all(
      (["movie", "tv"] as const).map(async (mediaType) => {
        const list = await cached(
          "provider-list",
          TMDB_TTL_MS.providerList,
          `/watch/providers/${mediaType}`,
          { language: TMDB_LANGUAGE, watch_region: region },
          (raw) =>
            ((raw as { results?: RawProvider[] }).results ?? [])
              .map((p) => normalizeListProvider(p, region))
              .filter((p): p is WatchProvider => p !== null),
        );
        return { mediaType, list: list ?? [] };
      }),
    );
    const merged = new Map<number, ProviderListEntry>();
    for (const { mediaType, list } of lists) {
      for (const p of list) {
        const existing = merged.get(p.id);
        if (existing) {
          existing.mediaTypes.push(mediaType);
          existing.displayPriority = Math.min(existing.displayPriority, p.displayPriority);
        } else {
          merged.set(p.id, { ...p, mediaTypes: [mediaType] });
        }
      }
    }
    return [...merged.values()].sort((a, b) => a.displayPriority - b.displayPriority || a.name.localeCompare(b.name));
  }

  /**
   * The countries TMDB has streaming data for, sorted by English name. Never
   * empty: TMDB always lists some, so a 404 or an empty list means the lookup
   * failed. That throws and is not cached, because settings code reads an
   * empty list as "no country is valid". If the refetch fails and an expired
   * list is cached, that list is served.
   */
  async function getWatchRegions(): Promise<WatchRegion[]> {
    const pathWithQuery = buildPath("/watch/providers/regions", { language: TMDB_LANGUAGE });
    const key = cacheKey("watch-regions", pathWithQuery);
    const entry = await readCacheEntry<WatchRegion[]>(key);
    const usable = entry && entry.data.length > 0 ? entry : undefined;
    if (usable?.fresh) return usable.data;
    try {
      const raw = await tmdbGet(http, pathWithQuery);
      const regions = raw === null ? [] : normalizeRegions(raw);
      if (regions.length === 0) throw new Error("TMDB returned no watch regions");
      await writeCache(key, regions, TMDB_TTL_MS.watchRegions);
      return regions;
    } catch (err) {
      if (!usable) throw err;
      console.warn("tmdb watch regions refetch failed, serving stale:", err);
      return usable.data;
    }
  }

  /**
   * IMDb IDs for many titles, keyed by formatTitleKey. Discover and search
   * results carry no IMDb ID, so this reads each title's details (cached for
   * 7 days, and needed anyway when the card shows). Null when TMDB has no
   * mapping or no such title. A title whose lookup fails also gets null, so
   * one bad title does not sink the batch.
   */
  async function resolveImdbIds(ids: readonly TitleId[]): Promise<Map<string, string | null>> {
    const unique = [...new Map(ids.map((id) => [formatTitleKey(id), id])).values()];
    const out = new Map<string, string | null>();
    await mapWithConcurrency(unique, TMDB_FANOUT_CONCURRENCY, async (id) => {
      try {
        const loaded = await loadDetails(id, false);
        out.set(formatTitleKey(id), loaded?.core.imdbId ?? null);
      } catch (err) {
        console.warn(`tmdb imdb id lookup failed for ${formatTitleKey(id)}:`, err);
        out.set(formatTitleKey(id), null);
      }
    });
    return out;
  }

  /**
   * Returns copies of the candidates with providerIds set to the services
   * that stream each title in `country` (subscription, free, or with ads;
   * not rent or buy), the field the deck's "on my services" filter reads.
   * A title TMDB does not know, or whose lookup fails with nothing cached,
   * keeps providerIds undefined (unknown). A title with no listing in the
   * country gets [] (known, streaming nowhere).
   *
   * It reads through the same details path as resolveImdbIds, so on a cold
   * cache one request per title serves both helpers, in either order or in
   * parallel.
   */
  async function attachProviderIds<T extends Candidate>(candidates: readonly T[], country: string): Promise<T[]> {
    const region = checkCountry(country);
    return mapWithConcurrency(candidates, TMDB_FANOUT_CONCURRENCY, async (c) => {
      let providers: ProvidersByCountry | undefined;
      try {
        providers = (await loadDetails(c, true))?.providers;
      } catch (err) {
        console.warn(`tmdb providers lookup failed for ${formatTitleKey(c)}:`, err);
      }
      if (providers === undefined) return { ...c };
      return { ...c, providerIds: streamingProviderIds(providers[region]) };
    });
  }

  return {
    getTitleDetails,
    getTitleProviders,
    discover,
    recommendations,
    searchTitles,
    getGenres,
    getProviderList,
    getWatchRegions,
    resolveImdbIds,
    attachProviderIds,
  };
}

/** A client using TMDB_API_READ_TOKEN from the environment. */
export function createTmdbClientFromEnv(cache: CacheStore): TmdbClient {
  const token = process.env.TMDB_API_READ_TOKEN;
  if (!token) throw new Error("TMDB_API_READ_TOKEN is not set");
  return createTmdbClient({ token, cache });
}

let appClient: TmdbClient | undefined;

/** The app's TMDB client: environment token, Postgres cache (tmdb_cache). Created on first use. */
export function getTmdb(): TmdbClient {
  appClient ??= createTmdbClientFromEnv(new PostgresCacheStore());
  return appClient;
}

function poolParams(pool: DiscoverPool): Params {
  switch (pool) {
    case "popular":
      return { sort_by: "popularity.desc", "vote_count.gte": DISCOVER_VOTE_FLOORS.popularMin };
    case "top_rated":
      return { sort_by: "vote_average.desc", "vote_count.gte": DISCOVER_VOTE_FLOORS.topRatedMin };
    case "deep_cuts":
      return {
        sort_by: "vote_average.desc",
        "vote_count.gte": DISCOVER_VOTE_FLOORS.deepCutsMin,
        "vote_count.lte": DISCOVER_VOTE_FLOORS.deepCutsMax,
        "vote_average.gte": DISCOVER_VOTE_FLOORS.deepCutsMinAverage,
      };
  }
}

function filterParams(filters: DiscoverFilters): Params {
  const params: Params = {};
  if (filters.genreIds?.length) {
    // "|" is OR in TMDB discover: a title in any of the genres matches, like the deck filter.
    params.with_genres = uniqueSorted(filters.genreIds).join("|");
  }
  const dateField = filters.mediaType === "movie" ? "primary_release_date" : "first_air_date";
  const { fromYear, toYear } = filters.era ?? {};
  if (fromYear !== undefined) params[`${dateField}.gte`] = `${checkYear(fromYear)}-01-01`;
  if (toYear !== undefined) params[`${dateField}.lte`] = `${checkYear(toYear)}-12-31`;
  if (filters.providerIds?.length) {
    if (!filters.watchRegion) throw new Error("discover: watchRegion is required with providerIds");
    params.with_watch_providers = uniqueSorted(filters.providerIds).join("|");
    params.watch_region = checkCountry(filters.watchRegion);
    params.with_watch_monetization_types = STREAMING_MONETIZATION.join("|");
  } else if (filters.watchRegion) {
    params.watch_region = checkCountry(filters.watchRegion);
  }
  return params;
}

function matchesLocalFilters(t: TitleSummary, filters: RecommendationFilters): boolean {
  if (filters.genreIds?.length && !filters.genreIds.some((g) => t.genreIds.includes(g))) return false;
  const { fromYear, toYear } = filters.era ?? {};
  if (fromYear !== undefined || toYear !== undefined) {
    if (t.year === null) return false;
    if (fromYear !== undefined && t.year < fromYear) return false;
    if (toYear !== undefined && t.year > toYear) return false;
  }
  return true;
}

function toPage(raw: unknown, mediaTypeFor: (r: RawTitle) => MediaType | null): ResultPage<TitleSummary> {
  const body = raw as { page?: number; total_pages?: number; results?: RawTitle[] };
  const results: TitleSummary[] = [];
  for (const r of body.results ?? []) {
    const mediaType = mediaTypeFor(r);
    if (!mediaType) continue;
    const summary = normalizeSummary(r, mediaType);
    if (summary) results.push(summary);
  }
  return { results, page: body.page ?? 1, totalPages: Math.min(body.total_pages ?? 0, MAX_PAGE) };
}

function mediaTypeOf(value: unknown): MediaType | null {
  return value === "movie" || value === "tv" ? value : null;
}

function emptyPage(page: number): ResultPage<TitleSummary> {
  return { results: [], page, totalPages: 0 };
}

function clampPage(page: number): number {
  if (!Number.isSafeInteger(page)) return 1;
  return Math.min(Math.max(page, 1), MAX_PAGE);
}

function uniqueSorted(ids: readonly number[]): number[] {
  for (const id of ids) if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid TMDB ID: ${id}`);
  return [...new Set(ids)].sort((a, b) => a - b);
}

function checkCountry(country: string): string {
  if (!/^[A-Z]{2}$/.test(country)) throw new Error(`Invalid country code: ${country}`);
  return country;
}

function checkYear(year: number): number {
  if (!Number.isSafeInteger(year) || year < 1800 || year > 9999) throw new Error(`Invalid year: ${year}`);
  return year;
}
