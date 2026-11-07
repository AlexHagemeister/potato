// Search tuning values.

/**
 * Longest query the service accepts, after trimming. Real titles are far
 * shorter. The query becomes part of a TMDB cache key, so a cap keeps runaway
 * input out of the cache table's index.
 */
export const SEARCH_QUERY_MAX_LENGTH = 200;
