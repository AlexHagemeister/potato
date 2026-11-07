// The deck engine (CLAUDE.md architecture rule 5). A pure function: the same
// input always gives the same output. It reads no clock, no randomness, no
// database, and never mutates its input.

import { formatTitleKey, type TitleId } from "../title-id";
import type { Candidate, DeckFilters, DiscoveryMode, PoolName, UserTitleState } from "../types";
import {
  BLEND_ORDER,
  BLEND_WEIGHTS,
  DEEP_CUTS_MIN_SCORE,
  FOR_YOU_MIN_RATINGS,
  VOTE_THRESHOLDS,
} from "./constants";

export interface DeckInput {
  /** The user's title_status rows. Rows for titles outside the pools are harmless. */
  states: readonly UserTitleState[];
  /** The user's streaming services (TMDB watch provider IDs). */
  userProviderIds: readonly number[];
  filters: DeckFilters;
  mode: DiscoveryMode;
  now: Date;
  /** How many titles the user has rated. Gates "for you". */
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

/** A candidate with its identity key and quality computed once, before filtering and sorting. */
interface Entry {
  card: DeckCard;
  key: string;
  q: Quality;
}

export function buildDeck(input: DeckInput): DeckResult {
  const forYouUnlocked = input.ratedCount >= FOR_YOU_MIN_RATINGS;

  if (input.mode === "for_you" && !forYouUnlocked) {
    return {
      kind: "locked",
      mode: "for_you",
      ratedCount: input.ratedCount,
      required: FOR_YOU_MIN_RATINGS,
      remaining: FOR_YOU_MIN_RATINGS - input.ratedCount,
    };
  }

  const hidden = hiddenKeys(input.states, input.now);
  const userProviders = new Set(input.userProviderIds);

  const ordered = (pool: PoolName): Entry[] => {
    const entries: Entry[] = [];
    for (const c of input.pools[pool] ?? []) {
      const key = titleKeyOrNull(c);
      // A malformed row (bad media type or ID) is skipped, not allowed to sink the whole deck.
      if (key === null || hidden.has(key) || !passesFilters(c, input.filters, userProviders)) continue;
      entries.push({ card: { ...c, source: pool }, key, q: quality(c) });
    }
    return orderPool(pool, entries);
  };

  const pools: PoolName[] =
    input.mode === "blend"
      ? BLEND_ORDER.filter((pool) => BLEND_WEIGHTS[pool] > 0 && (pool !== "for_you" || forYouUnlocked))
      : [input.mode];
  const weights = input.mode === "blend" ? pools.map((pool) => BLEND_WEIGHTS[pool]) : [1];

  return {
    kind: "cards",
    cards: interleave(pools.map(ordered), weights, (e) => e.key).map((e) => e.card),
  };
}

/**
 * Whether a title passes the user's filters. The deck uses it, and the Lists
 * screens apply the same filters (VISION: "The filters that shape the deck also
 * work on each list").
 */
export function matchesFilters(c: Candidate, filters: DeckFilters, userProviderIds: readonly number[]): boolean {
  return passesFilters(c, filters, new Set(userProviderIds));
}

/** formatTitleKey, but null instead of a throw for a malformed row. */
function titleKeyOrNull(id: TitleId): string | null {
  try {
    return formatTitleKey(id);
  } catch {
    return null;
  }
}

/**
 * Keys of titles the deck must not show: anything on a list, and skipped titles
 * before their return time. A skipped row whose return time does not parse
 * stays hidden: a skip that holds too long is cheaper than one that ends early.
 */
function hiddenKeys(states: readonly UserTitleState[], now: Date): Set<string> {
  const hidden = new Set<string>();
  for (const state of states) {
    const key = titleKeyOrNull(state);
    if (key === null) continue; // Matches no valid candidate anyway.
    if (state.status !== "skipped") {
      hidden.add(key);
      continue;
    }
    const returnsAt = new Date(state.skipUntil).getTime();
    if (Number.isNaN(returnsAt) || now.getTime() < returnsAt) hidden.add(key);
  }
  return hidden;
}

function passesFilters(c: Candidate, filters: DeckFilters, userProviders: ReadonlySet<number>): boolean {
  if (filters.mediaTypes?.length && !filters.mediaTypes.includes(c.mediaType)) return false;

  if (filters.genreIds?.length && !filters.genreIds.some((g) => c.genreIds.includes(g))) return false;

  const { fromYear, toYear } = filters.era ?? {};
  if (fromYear !== undefined || toYear !== undefined) {
    if (c.year === null) return false;
    if (fromYear !== undefined && c.year < fromYear) return false;
    if (toYear !== undefined && c.year > toYear) return false;
  }

  if (filters.onMyServices) {
    // Unknown availability cannot be shown as "on my services".
    if (!c.providerIds?.some((p) => userProviders.has(p))) return false;
  }

  return true;
}

/** IMDb when the title has IMDb data (the score Alex trusts, VISION invariant 5), else TMDB. */
function quality(c: Candidate): Quality {
  return c.imdb
    ? { source: "imdb", score: c.imdb.rating, votes: c.imdb.votes }
    : { source: "tmdb", score: c.tmdbVoteAverage, votes: c.tmdbVoteCount };
}

/** Orders one pool by its own signal. Returns a new array. Ties keep pool order (Array.prototype.sort is stable). */
function orderPool(pool: PoolName, entries: Entry[]): Entry[] {
  switch (pool) {
    case "popular":
      return entries.sort((a, b) => b.card.popularity - a.card.popularity);

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
 * Higher quality score first, then higher TMDB vote average, then more votes.
 * The vote tiebreak compares like with like: IMDb votes when both titles have
 * them, else TMDB vote counts, which every title has.
 */
function byQuality(a: Entry, b: Entry): number {
  const votes =
    a.q.source === "imdb" && b.q.source === "imdb"
      ? b.q.votes - a.q.votes
      : b.card.tmdbVoteCount - a.card.tmdbVoteCount;
  return b.q.score - a.q.score || b.card.tmdbVoteAverage - a.card.tmdbVoteAverage || votes;
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
