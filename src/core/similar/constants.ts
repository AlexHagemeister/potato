// Tuning for the similar-titles row ("You might also like" on a title's card).
// Each value is a judgment call recorded in the PR that set it.

/** The most titles the row shows. */
export const SIMILAR_LIMIT = 12;

/** Pages of TMDB recommendations read for the title being viewed (20 titles a page). */
export const SIMILAR_REC_PAGES = 2;

/**
 * A Seen title counts as one the user liked from this rating up (out of 10).
 * Only liked titles boost a recommendation or appear in its reason line, so
 * the row never says "because you liked" a title the user rated low.
 */
export const FAVORITE_MIN_RATING = 8;

/** How many liked titles are checked for agreement. One TMDB recommendations page each, shared with the For you deck's cache. */
export const FAVORITE_COUNT = 5;

/**
 * Cheap gates on TMDB's own numbers, applied before any details lookup:
 * below this many TMDB votes a recommendation is obscure filler, and below
 * this TMDB average it would almost never clear the IMDb floor (TMDB averages
 * run lower than IMDb's).
 */
export const MIN_TMDB_VOTES = 50;
export const MIN_TMDB_AVERAGE = 6;

/**
 * How many top candidates get a details lookup (for the IMDb rating and the
 * franchise). Bounds the TMDB work per row. Two full pages, since the IMDb
 * floor drops many of them.
 */
export const DETAILS_CAP = 40;

/**
 * The IMDb floor: a title rated below this, or with fewer votes, is left out.
 * Skipped when the ratings can't be read. TMDB's recommendation lists carry
 * many middling titles (Inception's opens with Paycheck and The Dark Tower),
 * so the floor sits at 7.
 */
export const IMDB_FLOOR = 7;
export const IMDB_MIN_VOTES = 1000;

/** The IMDb rating that earns the full quality boost. Few titles rate higher. */
export const IMDB_TOP = 9;

/**
 * Score weights. A candidate's base score is its closeness: 1 for TMDB's first
 * recommendation, falling toward 0 down the list. Each liked title that also
 * recommends it adds AGREEMENT_WEIGHT, counted up to MAX_AGREEMENT. Its IMDb
 * rating adds up to QUALITY_WEIGHT, from 0 at the floor to the full weight at
 * IMDB_TOP. Quality weighs as much as TMDB's order, because that order is a
 * weak signal on its own (walked on Inception and Severance, 2026-11-19).
 */
export const AGREEMENT_WEIGHT = 0.5;
export const MAX_AGREEMENT = 3;
export const QUALITY_WEIGHT = 1;
