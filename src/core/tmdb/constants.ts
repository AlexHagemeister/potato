// Every TMDB tuning value lives here.

export const TMDB_API_BASE = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";

/** TMDB serves at most 500 pages of any list. */
export const TMDB_MAX_PAGE = 500;

/** Release years discover accepts in an era filter. Outside this range the client throws. */
export const TMDB_YEAR_RANGE = { min: 1800, max: 9999 } as const;

/** Language for titles, synopses, and genre names. */
export const TMDB_LANGUAGE = "en-US";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long each kind of response stays fresh in the cache. */
export const TMDB_TTL_MS = {
  /** Title details (metadata, IMDb ID, trailer). These rarely change. */
  details: 7 * DAY_MS,
  /** Streaming availability for one title. Catalogs change often. */
  titleProviders: 12 * HOUR_MS,
  /** Discover and recommendation pages. */
  discover: 12 * HOUR_MS,
  /** The provider list for a country. */
  providerList: 12 * HOUR_MS,
  /** Genre lists. These almost never change. */
  genres: 7 * DAY_MS,
  search: 1 * HOUR_MS,
} as const;

/** Bumped when a cached value's shape changes, so old entries are ignored rather than misread. */
export const TMDB_CACHE_VERSION = 1;

/** Retries after an HTTP 429 or 5xx response or a timeout, before giving up. */
export const TMDB_MAX_RETRIES = 3;
/** One attempt (response and body) gives up after this long and counts as retryable. */
export const TMDB_REQUEST_TIMEOUT_MS = 8000;
/** First backoff when the response carries no Retry-After header. Doubles each retry. */
export const TMDB_BASE_BACKOFF_MS = 1000;
/** No single wait is longer than this, whatever Retry-After says. */
export const TMDB_MAX_BACKOFF_MS = 10_000;

/** Parallel TMDB calls when a helper fans out over many titles. */
export const TMDB_FANOUT_CONCURRENCY = 8;

/**
 * TMDB-side vote floors for the discover queries behind each pool. They keep
 * junk out of the pools. The deck engine re-filters and orders each pool by
 * its own thresholds (IMDb votes when known), so these only shape what TMDB
 * returns.
 */
export const DISCOVER_VOTE_FLOORS = {
  /** Popular: enough votes that the title is real, not a placeholder entry. */
  popularMin: 50,
  /** Top rated: well-known titles only. */
  topRatedMin: 1000,
  /** Deep cuts: a band of fewer votes, with a minimum average. */
  deepCutsMin: 100,
  deepCutsMax: 999,
  deepCutsMinAverage: 7.0,
} as const;
