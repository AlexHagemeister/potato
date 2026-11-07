// Every deck tuning value lives here, so retuning is a one-line edit.

import type { PoolName } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A skipped card returns to the deck after this many days (Alex's ruling on issue 4). */
export const SKIP_DAYS = 14;

/** The moment a title skipped at `now` returns to the deck: exactly SKIP_DAYS * 24 hours later. */
export function skipUntilFrom(now: Date): Date {
  return new Date(now.getTime() + SKIP_DAYS * DAY_MS);
}

/** Rated titles a user needs before "for you" unlocks (VISION: Shaping the deck). */
export const FOR_YOU_MIN_RATINGS = 10;

/**
 * Turns per round in the default blend (Alex's ruling on issue 5: an even
 * blend, with "for you" as an equal fourth once unlocked). A weight of 2 gives
 * that pool two cards per round. A weight of 0 leaves it out of the blend.
 */
export const BLEND_WEIGHTS: Readonly<Record<PoolName, number>> = {
  popular: 1,
  deep_cuts: 1,
  top_rated: 1,
  for_you: 1,
};

/** The order pools take their turns within a blend round. */
export const BLEND_ORDER: readonly PoolName[] = ["popular", "deep_cuts", "top_rated", "for_you"];

/**
 * Vote thresholds. A threshold always gates votes from the same source as the
 * rating it trusts: IMDb vote counts run far higher than TMDB's, so each
 * source has its own numbers.
 *
 * Top rated needs at least `topRatedMin` votes. Deep cuts sit in the band from
 * `deepCutsMin` up to (not including) `topRatedMin`, so a title is never both.
 */
export const VOTE_THRESHOLDS = {
  imdb: { deepCutsMin: 1_000, topRatedMin: 25_000 },
  tmdb: { deepCutsMin: 100, topRatedMin: 1_000 },
} as const;

/** A deep cut must be good, not just obscure: its quality score (0 to 10) must reach this. */
export const DEEP_CUTS_MIN_SCORE = 7.0;
