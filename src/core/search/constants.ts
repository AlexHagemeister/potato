// Search tuning values.

/**
 * Longest query the service accepts, after trimming. Real titles are far
 * shorter. The query becomes part of a TMDB cache key, so a cap keeps runaway
 * input out of the cache table's index.
 */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/**
 * Most TMDB search pages one search request reads. TMDB's search finds people
 * too, and they are dropped, so a page can hold no titles; the service reads
 * on until it has one, up to this many pages (#46). Each page is one TMDB
 * call (cached like any search), so this bounds what one request can cost.
 */
export const SEARCH_PAGES_PER_REQUEST = 3;

/**
 * Most titles one status read (getStatuses) takes. A screen asks only for the
 * titles sorted since it read its results, usually one, so this only bounds
 * the input.
 */
export const SEARCH_STATUS_MAX_TITLES = 100;
