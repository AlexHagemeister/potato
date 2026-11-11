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
 * The shuffle: how many of a TMDB list's first pages a new deck draws from in
 * a seeded order, before it reads the rest in TMDB's order. A page holds 20
 * titles, so 15 pages is the top 300 of each list (per pool and media type).
 * Every title in the window already clears its pool's TMDB-side floors, so a
 * wide window costs variety nothing in quality. Wider means less chance of a
 * familiar opening card, and a first card from further down the ranking.
 *
 * A cursor stores a step through this order, not the order itself. Changing
 * this value, FOR_YOU_SHUFFLE_WINDOW_PAGES, SHUFFLE_FRONT_BIAS, or the shuffle
 * in ../deck/shuffle.ts remaps the decks in flight, so bump CURSOR_VERSION
 * (cursor.ts) in the same change. The client then restarts each deck once.
 */
export const SHUFFLE_WINDOW_PAGES = 15;

/**
 * The same window for a "for you" recommendations list, kept narrow. TMDB
 * orders that list by closeness to the seed title and it has no quality
 * floor, so its order is the taste signal: 3 pages keeps a new deck inside
 * each seed title's closest 60, where a wide window would open most decks on
 * loosely related titles.
 */
export const FOR_YOU_SHUFFLE_WINDOW_PAGES = 3;

/**
 * How strongly the shuffle leans toward a list's first pages: page n is drawn
 * with weight n to the power of minus this. 0 is an even shuffle of the
 * window. At 0.5 the first page is about four times as likely to open a deck
 * as the fifteenth, so the best-known titles still turn up early, just not
 * always first. Changing it needs a CURSOR_VERSION bump (see SHUFFLE_WINDOW_PAGES).
 */
export const SHUFFLE_FRONT_BIAS = 0.5;

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
 * narrow deck. Under "on my services" the same rule counts a title whose
 * availability is unknown (its providers lookup failed) as a failure, since
 * the filter has to leave it out (issue 104).
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
