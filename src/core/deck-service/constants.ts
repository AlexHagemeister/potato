// Every deck-service tuning value lives here. Together they bound the TMDB
// work one getDeck call can do (see the bound in service.ts).

/**
 * Titles taken from each pool per getDeck call, before the engine filters and
 * orders them. One title costs one details lookup, so this bounds the details
 * lookups per call: 20 for a single mode, 8 * 4 = 32 for the blend.
 */
export const POOL_QUOTA = { single: 20, blend: 8 } as const;

/**
 * TMDB list pages (discover or recommendations) one stream may read per call.
 * A user who has already sorted the first pages of a pool skips past them
 * without a details lookup, but no further than this per call.
 */
export const MAX_PAGES_PER_STREAM = 3;

/** How many of the user's highest-rated Seen titles seed "for you". One recommendations stream each. */
export const FOR_YOU_SEED_COUNT = 5;

/** Parallel details lookups when enriching a page. */
export const DETAILS_CONCURRENCY = 8;

/** TMDB serves at most 500 pages of any list. */
export const MAX_LIST_PAGE = 500;

/** Era bounds the deck accepts. TMDB's discover rejects years outside this range. */
export const ERA_YEAR_RANGE = { min: 1800, max: 9999 } as const;

/**
 * The credit every place that shows streaming availability must carry
 * (CLAUDE.md architecture rule 7). TMDB's watch-provider data comes from
 * JustWatch, and TMDB revokes API access for non-compliance.
 */
export const JUSTWATCH_ATTRIBUTION = {
  text: "Streaming availability from JustWatch",
  url: "https://www.justwatch.com",
} as const;
