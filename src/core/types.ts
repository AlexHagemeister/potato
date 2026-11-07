// Shared core types. A title is always the pair (media type, TMDB ID)
// (CLAUDE.md architecture rule 1), so every title-shaped type extends TitleId.

import type { TITLE_STATUSES } from "../db/schema";
import type { MediaType, TitleId } from "./title-id";

export type { MediaType, TitleId };

/**
 * A user's one status for a title (CLAUDE.md architecture rule 2). The schema's
 * TITLE_STATUSES is the one list. This is a type-only import, so the deck pulls
 * no database code in at runtime.
 */
export type TitleStatus = (typeof TITLE_STATUSES)[number];

/** Statuses that put a title on one of the user's lists. A listed title never returns to the deck (VISION invariant 3). */
export const LIST_STATUSES = ["watchlist", "passed", "seen"] as const satisfies readonly TitleStatus[];
export type ListStatus = (typeof LIST_STATUSES)[number];

/**
 * The part of a user's title_status row the deck needs. A skipped row always
 * carries the moment it returns to the deck, matching the schema check
 * (skip_until is not null exactly when status = 'skipped'). skipUntil may be
 * an ISO string, since rows can cross a JSON boundary (API, cache, MCP).
 */
export type UserTitleState =
  | (TitleId & { status: ListStatus })
  | (TitleId & { status: "skipped"; skipUntil: Date | string });

/** The discovery modes a deck can be ordered by (VISION: Shaping the deck). */
export const DISCOVERY_MODES = ["blend", "popular", "deep_cuts", "top_rated", "for_you"] as const;
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number];

/** The single modes, each backed by its own candidate pool. `blend` mixes them. */
export type PoolName = Exclude<DiscoveryMode, "blend">;

/** IMDb's rating and vote count for a title. Both come from the same dataset row, so they arrive together. */
export interface ImdbRating {
  rating: number;
  votes: number;
}

/** A title the deck may show, with the metadata the deck engine sorts and filters on. */
export interface Candidate extends TitleId {
  title: string;
  /** Release year (movie) or first air year (series). Null when TMDB has no date. */
  year: number | null;
  genreIds: number[];
  /** TMDB popularity score. */
  popularity: number;
  /** TMDB vote average, 0 to 10. */
  tmdbVoteAverage: number;
  tmdbVoteCount: number;
  /** Absent when the title has no IMDb mapping or no row in the IMDb dataset. */
  imdb?: ImdbRating;
  /**
   * TMDB watch provider IDs for streaming in the user's country: by
   * subscription, free, or with ads (not rent or buy). Undefined means unknown (no availability data). An empty array
   * means known and streaming nowhere.
   */
  providerIds?: number[];
}

/** Filters decide which titles can appear (VISION: Shaping the deck). An absent or empty field means "no filter". */
export interface DeckFilters {
  mediaTypes?: MediaType[];
  /** Matches a title in any of these genres. */
  genreIds?: number[];
  /** Inclusive year bounds. A missing or null bound is unbounded (null is the usual JSON shape for a cleared bound). */
  era?: { fromYear?: number | null; toYear?: number | null };
  /** Only titles streaming on at least one of the user's services. */
  onMyServices?: boolean;
}
