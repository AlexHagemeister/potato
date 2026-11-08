// The deck engine (CLAUDE.md architecture rule 5). A pure function: the same
// input always gives the same output. It reads no clock, no randomness, no
// database, and never mutates its input.
//
// Bad input fails closed or throws. A malformed candidate is skipped, and a
// malformed state row keeps its title hidden, so one bad row cannot sink the
// deck. A bad argument (mode, now, ratedCount) is a caller bug, so it throws a
// RangeError.

import { tryFormatTitleKey } from "../title-id";
import {
  DISCOVERY_MODES,
  LIST_STATUSES,
  type Candidate,
  type DeckFilters,
  type DiscoveryMode,
  type PoolName,
  type TitleId,
  type TitleStatus,
  type UserTitleState,
} from "../types";
import {
  BLEND_ORDER,
  BLEND_WEIGHTS,
  DEEP_CUTS_MIN_SCORE,
  FOR_YOU_MIN_RATINGS,
  VOTE_THRESHOLDS,
} from "./constants";

export interface DeckInput {
  /** The user's title_status rows. Raw Drizzle rows fit as is. Rows for titles outside the pools are harmless. */
  states: readonly UserTitleState[];
  /** The user's streaming services (TMDB watch provider IDs). */
  userProviderIds: readonly number[];
  filters: DeckFilters;
  mode: DiscoveryMode;
  /** Must be a valid Date. Every skip's return time is judged against it, so an invalid one throws. */
  now: Date;
  /** How many titles the user has rated. Gates "for you". A whole number, 0 or more. */
  ratedCount: number;
  /** Candidates per source. A missing pool counts as empty. "for_you" arrives already in taste order. */
  pools: Partial<Record<PoolName, readonly Candidate[]>>;
}

/** A card in the deck, tagged with the pool it came from (the first pool it appeared in, for a blend). */
export type DeckCard = Candidate & { source: PoolName };

export type DeckResult =
  | { kind: "cards"; cards: DeckCard[] }
  | { kind: "locked"; mode: "for_you"; ratedCount: number; required: number; remaining: number };

/** The rating a title is judged by, and the votes behind it, from one source. */
interface Quality {
  source: "imdb" | "tmdb";
  score: number;
  votes: number;
}

/**
 * A candidate with its identity key and sort signals computed once, before
 * filtering and sorting. Every number here is finite or -Infinity, never NaN
 * (see `signal`), so the comparators below are total orders.
 */
interface Entry {
  card: DeckCard;
  key: string;
  q: Quality;
  popularity: number;
  tmdbAverage: number;
  /** -1 for a title without IMDb data, so it sorts after any title with IMDb votes. */
  imdbVotes: number;
  tmdbVotes: number;
}

export function buildDeck(input: DeckInput): DeckResult {
  // These can arrive from a URL, an API body, or a DB count, so check them before trusting the types.
  if (!(DISCOVERY_MODES as readonly string[]).includes(input.mode)) {
    throw new RangeError(`buildDeck: unknown discovery mode ${JSON.stringify(input.mode)}`);
  }
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new RangeError(`buildDeck: now must be a valid Date, got ${String(input.now)}`);
  }
  const { ratedCount } = input;
  if (typeof ratedCount !== "number" || !Number.isSafeInteger(ratedCount) || ratedCount < 0) {
    throw new RangeError(`buildDeck: ratedCount must be a whole number, 0 or more, got ${String(ratedCount)}`);
  }

  if (input.mode === "for_you" && !isForYouUnlocked(ratedCount)) return forYouLock(ratedCount);

  const hidden = hiddenKeys(input.states, input.now);
  const passes = createFilterMatcher(input.filters, input.userProviderIds);

  const ordered = (pool: PoolName): Entry[] => {
    const entries: Entry[] = [];
    for (const c of input.pools[pool] ?? []) {
      const key = tryFormatTitleKey(c);
      // A malformed row (bad media type or ID) is skipped, not allowed to sink the whole deck.
      if (key === null || hidden.has(key) || !passes(c)) continue;
      entries.push(toEntry(c, pool, key));
    }
    return orderPool(pool, entries);
  };

  const active = activePools(input.mode, ratedCount);
  return {
    kind: "cards",
    cards: interleave(
      active.map(({ pool }) => ordered(pool)),
      active.map(({ weight }) => weight),
      (e) => e.key,
    ).map((e) => e.card),
  };
}

/** A pool the deck deals from, with its turns per round. */
export interface ActivePool {
  pool: PoolName;
  weight: number;
}

/**
 * The pools a deck in this mode deals from, in turn order, each with its
 * weight. A single mode is its own pool with weight 1 (a locked "for you"
 * never gets this far in buildDeck). The blend takes BLEND_ORDER, leaves out
 * zero-weight pools, and adds "for you" once the user has rated enough. The
 * deck service fetches exactly these pools, so the rule lives here once.
 */
export function activePools(mode: DiscoveryMode, ratedCount: number): ActivePool[] {
  if (mode !== "blend") return [{ pool: mode, weight: 1 }];
  const forYouUnlocked = isForYouUnlocked(ratedCount);
  return (
    BLEND_ORDER
      // `!== 0`, not `> 0`, so a negative or NaN weight reaches interleave's check and throws.
      .filter((pool) => BLEND_WEIGHTS[pool] !== 0 && (pool !== "for_you" || forYouUnlocked))
      .map((pool) => ({ pool, weight: BLEND_WEIGHTS[pool] }))
  );
}

/** True when "for you" is unlocked for a user with this many ratings. */
export function isForYouUnlocked(ratedCount: number): boolean {
  return ratedCount >= FOR_YOU_MIN_RATINGS;
}

/** True when a deck in this mode deals from "for you" once it is unlocked: its own mode, or the blend unless its weight is 0. */
export function dealsForYou(mode: DiscoveryMode): boolean {
  return mode === "for_you" || (mode === "blend" && BLEND_WEIGHTS.for_you !== 0);
}

/** The "for you" lock for a user with this many ratings, as buildDeck returns it. */
export function forYouLock(ratedCount: number): Extract<DeckResult, { kind: "locked" }> {
  return {
    kind: "locked",
    mode: "for_you",
    ratedCount,
    required: FOR_YOU_MIN_RATINGS,
    remaining: Math.max(0, FOR_YOU_MIN_RATINGS - ratedCount),
  };
}

/** A filter check with the user's provider set built once, for checking many titles. */
export type FilterMatcher = (c: Candidate) => boolean;

/**
 * Builds the filter check once for many titles. The deck uses it, and the
 * Lists screens apply the same filters (VISION: "The filters that shape the
 * deck also work on each list"). Unknown or malformed metadata fails any
 * filter that needs it.
 */
export function createFilterMatcher(filters: DeckFilters, userProviderIds: readonly number[]): FilterMatcher {
  const userProviders: ReadonlySet<number> = new Set(userProviderIds);
  return (c) => passesFilters(c, filters, userProviders);
}

/** Whether one title passes the filters. To check many titles, build one matcher with createFilterMatcher. */
export function matchesFilters(c: Candidate, filters: DeckFilters, userProviderIds: readonly number[]): boolean {
  return createFilterMatcher(filters, userProviderIds)(c);
}

/** Whether the deck may show a title now. */
export type VisibilityCheck = (id: unknown) => boolean;

/**
 * The deck's hiding rule, built once for many titles: a title is visible
 * unless it is on a list or skipped until later. buildDeck applies the same
 * rule. The deck service uses it to drop hidden titles before it spends TMDB
 * calls on their details. A malformed identity is never visible.
 */
export function createVisibilityCheck(states: readonly UserTitleState[], now: Date): VisibilityCheck {
  const hidden = hiddenKeys(states, now);
  return (id) => {
    const key = tryFormatTitleKey(id);
    return key !== null && !hidden.has(key);
  };
}

/**
 * Whether the deck may show one title whose row is `row` at `now`, by the
 * same rule (createVisibilityCheck). No row: shown. The card's user state
 * (cardUserState) and the deck's Undo (afterUndo) both ask it.
 */
export function rowVisible(
  ref: TitleId,
  row: { status: TitleStatus; skipUntil?: Date | string | null } | null,
  now: Date,
): boolean {
  if (row === null) return true;
  return createVisibilityCheck([{ mediaType: ref.mediaType, tmdbId: ref.tmdbId, status: row.status, skipUntil: row.skipUntil }], now)(ref);
}

/**
 * An ISO 8601 date-time with an explicit offset ("Z" or "+05:30"), as
 * toISOString and Postgres row_to_json write them. A string without an offset
 * parses in the host's local time zone, so it does not count as a time.
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The moment a skipped title returns, in epoch ms, or NaN when the value names no unambiguous moment. */
function returnTime(raw: unknown): number {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "string" && ISO_WITH_OFFSET.test(raw)) return Date.parse(raw);
  return Number.NaN;
}

/**
 * Keys of titles the deck must not show: anything on a list, and skipped titles
 * before their return time. A skipped row whose return time is missing or does
 * not parse stays hidden, as does a row with an unknown status: a title that
 * stays away too long is cheaper than one that comes back by mistake.
 */
function hiddenKeys(states: readonly UserTitleState[], now: Date): Set<string> {
  const hidden = new Set<string>();
  const listStatuses: readonly string[] = LIST_STATUSES;
  for (const state of states) {
    const key = tryFormatTitleKey(state);
    if (key === null) continue; // Matches no valid candidate anyway.
    if (listStatuses.includes(state.status)) {
      hidden.add(key); // VISION invariant 3: a listed title never returns.
    } else if (state.status === "skipped") {
      const returnsAt = returnTime(state.skipUntil);
      if (Number.isNaN(returnsAt) || now.getTime() < returnsAt) hidden.add(key);
    } else {
      hidden.add(key); // Unknown status: fail closed.
    }
  }
  return hidden;
}

function passesFilters(c: Candidate, filters: DeckFilters, userProviders: ReadonlySet<number>): boolean {
  if (filters.mediaTypes?.length && !filters.mediaTypes.includes(c.mediaType)) return false;

  if (filters.genreIds?.length) {
    const genres: unknown = c.genreIds;
    if (!Array.isArray(genres) || !filters.genreIds.some((g) => genres.includes(g))) return false;
  }

  const { fromYear, toYear } = filters.era ?? {};
  const hasFrom = typeof fromYear === "number";
  const hasTo = typeof toYear === "number";
  if (hasFrom || hasTo) {
    // Null, missing, or NaN: the year is unknown, so it cannot be shown as inside the era.
    if (typeof c.year !== "number" || !Number.isFinite(c.year)) return false;
    if (hasFrom && c.year < fromYear) return false;
    if (hasTo && c.year > toYear) return false;
  }

  if (filters.onMyServices) {
    // Unknown availability cannot be shown as "on my services".
    const providers: unknown = c.providerIds;
    if (!Array.isArray(providers) || !providers.some((p) => userProviders.has(p))) return false;
  }

  if (typeof filters.minImdbRating === "number") {
    // IMDb's rating only (VISION invariant 5), never TMDB's. No rating, or a malformed one, cannot be shown as meeting it.
    const rating: unknown = c.imdb?.rating;
    if (typeof rating !== "number" || !Number.isFinite(rating) || rating < filters.minImdbRating) return false;
  }

  return true;
}

/** A sort signal as a number the comparators can trust: a finite value as is, anything else (NaN, Infinity, missing) sorts last. */
function signal(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/**
 * Computes each sort signal once. Quality is IMDb when the title has IMDb data
 * (the score Alex trusts, VISION invariant 5), else TMDB. A bad score sorts
 * last, and bad votes fail every vote threshold.
 */
function toEntry(c: Candidate, pool: PoolName, key: string): Entry {
  const q: Quality = c.imdb
    ? { source: "imdb", score: signal(c.imdb.rating), votes: signal(c.imdb.votes) }
    : { source: "tmdb", score: signal(c.tmdbVoteAverage), votes: signal(c.tmdbVoteCount) };
  return {
    card: { ...c, source: pool },
    key,
    q,
    popularity: signal(c.popularity),
    tmdbAverage: signal(c.tmdbVoteAverage),
    imdbVotes: c.imdb ? signal(c.imdb.votes) : -1,
    tmdbVotes: signal(c.tmdbVoteCount),
  };
}

/** Higher first. Plain comparisons, not subtraction: -Infinity minus -Infinity is NaN. */
function desc(a: number, b: number): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

/**
 * Orders one pool by its own signal. Sorts the freshly built entries array, never input.
 * Popular ties keep pool order (Array.prototype.sort is stable). Top rated and
 * deep cuts use a total order, so their pool order never matters.
 */
function orderPool(pool: PoolName, entries: Entry[]): Entry[] {
  switch (pool) {
    case "popular":
      return entries.sort((a, b) => desc(a.popularity, b.popularity));

    case "top_rated":
      return entries.filter(({ q }) => q.votes >= VOTE_THRESHOLDS[q.source].topRatedMin).sort(byQuality);

    case "deep_cuts":
      return entries
        .filter(({ q }) => {
          const t = VOTE_THRESHOLDS[q.source];
          return q.votes >= t.deepCutsMin && q.votes < t.topRatedMin && q.score >= DEEP_CUTS_MIN_SCORE;
        })
        .sort(byQuality);

    case "for_you":
      return entries;
  }
}

/**
 * One lexicographic total order, so the result never depends on pool order:
 * 1. higher quality score
 * 2. higher TMDB vote average
 * 3. more IMDb votes, titles without IMDb data last
 * 4. more TMDB votes
 * 5. title key ascending, so even full ties come out the same every time
 * Each key compares like with like (IMDb votes only with IMDb votes).
 */
function byQuality(a: Entry, b: Entry): number {
  return (
    desc(a.q.score, b.q.score) ||
    desc(a.tmdbAverage, b.tmdbAverage) ||
    desc(a.imdbVotes, b.imdbVotes) ||
    desc(a.tmdbVotes, b.tmdbVotes) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * Weighted round robin across ordered lists. Each round, list i gives up to
 * weights[i] items. Weights are whole turns per round, so each must be a
 * non-negative integer. An item whose key was already dealt is skipped without
 * costing its list the turn, so the first appearance wins. An exhausted list
 * drops out and the rest keep turning.
 */
export function interleave<T>(lists: readonly (readonly T[])[], weights: readonly number[], keyOf: (item: T) => string): T[] {
  if (weights.length !== lists.length) {
    throw new RangeError(`interleave: ${lists.length} lists but ${weights.length} weights`);
  }
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) {
      throw new RangeError(`interleave: weight ${w} is not a non-negative integer`);
    }
  }

  const out: T[] = [];
  const dealt = new Set<string>();
  const cursors = lists.map(() => 0);

  const nextFresh = (i: number): T | undefined => {
    const list = lists[i];
    while (cursors[i] < list.length) {
      const item = list[cursors[i]++];
      const key = keyOf(item);
      if (!dealt.has(key)) {
        dealt.add(key);
        return item;
      }
    }
    return undefined;
  };

  let dealtThisRound = true;
  while (dealtThisRound) {
    dealtThisRound = false;
    for (let i = 0; i < lists.length; i++) {
      for (let turn = 0; turn < weights[i]; turn++) {
        const item = nextFresh(i);
        if (item === undefined) break;
        out.push(item);
        dealtThisRound = true;
      }
    }
  }
  return out;
}
