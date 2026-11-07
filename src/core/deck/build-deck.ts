// The deck engine (CLAUDE.md architecture rule 5). A pure function: the same
// input always gives the same output. It reads no clock, no randomness, no
// database, and never mutates its input.

import { formatTitleKey } from "../title-id";
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
  const eligible = (c: Candidate) =>
    !hidden.has(formatTitleKey(c)) && passesFilters(c, input.filters, userProviders);

  const ordered = (pool: PoolName): DeckCard[] =>
    orderPool(pool, (input.pools[pool] ?? []).filter(eligible)).map((c) => ({ ...c, source: pool }));

  if (input.mode !== "blend") {
    return { kind: "cards", cards: interleave([ordered(input.mode)], [1]) };
  }

  const blendPools = BLEND_ORDER.filter(
    (pool) => BLEND_WEIGHTS[pool] > 0 && (pool !== "for_you" || forYouUnlocked),
  );
  return {
    kind: "cards",
    cards: interleave(
      blendPools.map(ordered),
      blendPools.map((pool) => BLEND_WEIGHTS[pool]),
    ),
  };
}

/** Keys of titles the deck must not show: anything on a list, and skipped titles before their return time. */
function hiddenKeys(states: readonly UserTitleState[], now: Date): Set<string> {
  const hidden = new Set<string>();
  for (const state of states) {
    if (state.status !== "skipped" || now.getTime() < state.skipUntil.getTime()) {
      hidden.add(formatTitleKey(state));
    }
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

/**
 * The rating a title is judged by, and the votes behind it. IMDb when the
 * title has IMDb data (the score Alex trusts, VISION invariant 5), else TMDB.
 */
function quality(c: Candidate): { score: number; votes: number; thresholds: (typeof VOTE_THRESHOLDS)["imdb" | "tmdb"] } {
  return c.imdb
    ? { score: c.imdb.rating, votes: c.imdb.votes, thresholds: VOTE_THRESHOLDS.imdb }
    : { score: c.tmdbVoteAverage, votes: c.tmdbVoteCount, thresholds: VOTE_THRESHOLDS.tmdb };
}

/** Orders one pool by its own signal. Returns a new array. Ties keep pool order (Array.prototype.sort is stable). */
function orderPool(pool: PoolName, candidates: Candidate[]): Candidate[] {
  switch (pool) {
    case "popular":
      return [...candidates].sort((a, b) => b.popularity - a.popularity);

    case "top_rated":
      return candidates
        .filter((c) => {
          const q = quality(c);
          return q.votes >= q.thresholds.topRatedMin;
        })
        .sort(byQuality);

    case "deep_cuts":
      return candidates
        .filter((c) => {
          const q = quality(c);
          return (
            q.votes >= q.thresholds.deepCutsMin &&
            q.votes < q.thresholds.topRatedMin &&
            q.score >= DEEP_CUTS_MIN_SCORE
          );
        })
        .sort(byQuality);

    case "for_you":
      return [...candidates];
  }
}

/** Higher quality score first, then higher TMDB vote average, then more votes. */
function byQuality(a: Candidate, b: Candidate): number {
  const qa = quality(a);
  const qb = quality(b);
  return qb.score - qa.score || b.tmdbVoteAverage - a.tmdbVoteAverage || qb.votes - qa.votes;
}

/**
 * Weighted round robin across ordered lists. Each round, list i gives up to
 * weights[i] cards. A title already dealt is skipped without costing its list
 * the turn, so the first appearance wins. An exhausted list drops out and the
 * rest keep turning. Exported for tests only.
 */
export function interleave(lists: DeckCard[][], weights: number[]): DeckCard[] {
  const out: DeckCard[] = [];
  const dealt = new Set<string>();
  const cursors = lists.map(() => 0);

  const nextFresh = (i: number): DeckCard | undefined => {
    const list = lists[i];
    while (cursors[i] < list.length) {
      const card = list[cursors[i]++];
      const key = formatTitleKey(card);
      if (!dealt.has(key)) {
        dealt.add(key);
        return card;
      }
    }
    return undefined;
  };

  let dealtThisRound = true;
  while (dealtThisRound) {
    dealtThisRound = false;
    for (let i = 0; i < lists.length; i++) {
      for (let turn = 0; turn < weights[i]; turn++) {
        const card = nextFresh(i);
        if (!card) break;
        out.push(card);
        dealtThisRound = true;
      }
    }
  }
  return out;
}
