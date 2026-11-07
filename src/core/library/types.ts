// Shapes the library core takes and returns. A title is always the pair
// (media type, TMDB ID) (CLAUDE.md architecture rule 1).

import type { Candidate, DeckFilters, ListStatus, TitleId, TitleStatus } from "../types";

/** The rating scale (Alex's ruling on issue 3): half a star to 5 stars, in half steps. */
export const RATING_MIN = 0.5;
export const RATING_MAX = 5;

/** Longest review the core accepts, in UTF-16 code units. A guard against runaway input, not a style rule. */
export const REVIEW_MAX_LENGTH = 10_000;

/** The one visibility reviews can have today (CLAUDE.md rule 6, VISION invariant 9). */
export type ReviewVisibility = "private";

/** One title_status row, as the core hands it out. */
export interface TitleRecord extends TitleId {
  status: TitleStatus;
  /** Set exactly when status is "seen". */
  rating: number | null;
  /** Only ever set when status is "seen". */
  review: string | null;
  reviewVisibility: ReviewVisibility;
  /** Set exactly when status is "skipped": the moment the title returns to the deck. */
  skipUntil: Date | null;
  /** When the user first acted on this title. Status changes keep it. */
  createdAt: Date;
  /** When the row last changed (status, rating, or review). */
  updatedAt: Date;
}

/**
 * A TitleRecord after a trip through JSON (an API response, the UI's undo
 * stack, an MCP call): dates may be ISO strings. restoreTitleState accepts it.
 */
export type TitleRecordInput = Omit<TitleRecord, "skipUntil" | "createdAt" | "updatedAt"> & {
  skipUntil: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/**
 * What every action returns. `previous` is the row before the action, or null
 * when there was none. `current` is the row after, or null when the action
 * removed it. Passing the whole outcome to restoreTitleState undoes the action
 * (VISION invariant 2), as long as the row is still `current`.
 */
export interface ActionOutcome {
  previous: TitleRecord | null;
  current: TitleRecord | null;
}

/** An ActionOutcome after a trip through JSON, as restoreTitleState accepts it. */
export interface UndoInput {
  previous: TitleRecord | TitleRecordInput | null;
  current: TitleRecord | TitleRecordInput | null;
}

/** Options every write takes. `now` exists so tests can fix the clock. */
export interface ActionOptions {
  now?: Date;
}

/** The two list moves VISION names (Your lists). */
export type MoveRequest =
  | { from: "watchlist"; to: "seen"; rating: number; review?: string | null }
  | { from: "passed"; to: "watchlist" };

/** A rating and review edit. An absent field is left as it is. A null review clears it. */
export interface RatingReviewPatch {
  rating?: number;
  review?: string | null;
}

/** List orderings. Rating sorts apply to the Seen list only. */
export const LIST_SORTS = [
  "updated_desc",
  "updated_asc",
  "created_desc",
  "created_asc",
  "rating_desc",
  "rating_asc",
] as const;
export type ListSort = (typeof LIST_SORTS)[number];

export const DEFAULT_LIST_SORT: ListSort = "updated_desc";
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/**
 * Looks up TMDB metadata for many titles at once. The result is keyed by
 * formatTitleKey ("movie:603"). A title missing from the map has unknown
 * metadata. The app layer passes the TMDB module's lookup in, so this module
 * never imports the TMDB module (CLAUDE.md rule 4 keeps one owner per service).
 */
export type TitleDetailsLookup = (
  refs: readonly TitleId[],
  context?: DetailsLookupContext,
) => Promise<ReadonlyMap<string, Candidate>>;

/** What a details lookup needs beyond the titles. */
export interface DetailsLookupContext {
  /**
   * Set when a filter reads streaming availability ("on my services"): the
   * user's country. The lookup must then fill each candidate's providerIds for
   * this country, or leave them undefined (unknown) when it cannot.
   */
  country?: string;
}

export interface ListOptions {
  /** The same filters the deck uses (VISION: "The filters that shape the deck also work on each list"). */
  filters?: DeckFilters;
  sort?: ListSort;
  /** The `nextCursor` from the previous page. Opaque. */
  cursor?: string | null;
  limit?: number;
  /** Required when a filter needs metadata (genre, era, on my services). When given, each entry carries its details. */
  lookupDetails?: TitleDetailsLookup;
}

export interface ListEntry extends TitleRecord {
  /** Present when a details lookup ran and knew the title. */
  details?: Candidate;
}

export interface ListPage {
  status: ListStatus;
  entries: ListEntry[];
  /** Pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}
