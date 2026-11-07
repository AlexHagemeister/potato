// Every deck-service tuning value lives here. Together they bound the TMDB
// work one getDeck call can do (see the bound in service.ts).

/**
 * Titles taken from each pool per getDeck call, before the engine filters and
 * orders them. In the blend, a pool takes `blend` times its blend weight
 * (rounded up). One title costs one details lookup, so this bounds the details
 * lookups per call: 20 for a single mode, 8 * 4 = 32 for the blend at even weights.
 */
export const POOL_QUOTA = { single: 20, blend: 8 } as const;

/**
 * TMDB list pages (discover or recommendations) one stream may read per call.
 * A user who has already sorted the first pages of a pool skips past them
 * without a details lookup, but no further than this per call.
 */
export const MAX_PAGES_PER_STREAM = 3;

/**
 * With a minimum IMDb rating, the most take rounds one getDeck call runs. A
 * TMDB list summary carries no IMDb rating, so the minimum drops titles only
 * after their details are read. On narrow filters one round of POOL_QUOTA
 * titles can deal nothing. Each extra round takes another POOL_QUOTA per pool
 * from where the last stopped, while the page is short of
 * MIN_RATING_PAGE_TARGET cards. This caps a call's details lookups at
 * POOL_QUOTA times this (60 for a single mode, 96 for the blend). List
 * lookups keep their own MAX_PAGES_PER_STREAM budget across rounds.
 */
export const MIN_RATING_TAKE_ROUNDS = 3;

/** With a minimum IMDb rating, a page with this many cards stops taking more rounds. Matches the Discover queue's low-water mark. */
export const MIN_RATING_PAGE_TARGET = 5;

/** How many of the user's highest-rated Seen titles seed "for you". One recommendations stream each. */
export const FOR_YOU_SEED_COUNT = 5;

/** Parallel details lookups when enriching a page. */
export const DETAILS_CONCURRENCY = 8;

/**
 * When a page's details lookups count as a TMDB outage: at least this many
 * failed, and they are most of the page's lookups. getDeck then throws and the
 * cursor stays put. Fewer failures skip just those titles, so one title TMDB
 * always fails on cannot block the deck. The floor also means a page of one or
 * two titles skips them even in an outage, which only happens at the end of a
 * narrow deck.
 */
export const DETAILS_OUTAGE_MIN_FAILURES = 3;

/**
 * How long a "the IMDb ratings table has rows" answer is trusted before the
 * service asks again. Only a yes is kept: an empty table is asked about on
 * every lookup that finds no ratings, so the first daily load shows at once.
 */
export const RATINGS_PROBE_TTL_MS = 60 * 60 * 1000;

/**
 * The credit every place that shows streaming availability must carry
 * (CLAUDE.md architecture rule 7). TMDB's watch-provider data comes from
 * JustWatch, and TMDB revokes API access for non-compliance.
 */
export const JUSTWATCH_ATTRIBUTION = {
  text: "Streaming availability from JustWatch",
  url: "https://www.justwatch.com",
} as const;

/**
 * Titles one hiddenTitles call may check. The Discover screen sends its queued
 * cards, which stay well under this (a few pages of at most POOL_QUOTA titles).
 */
export const MAX_HIDDEN_CHECK = 100;
