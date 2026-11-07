// The result type every core function with user-facing input returns. Callers
// (the UI, the API, a future MCP) get a result they can switch on instead of a
// thrown exception. Anything thrown is a bug or an outage (a bad connection, a
// broken invariant), never bad input.

import type { TitleStatus } from "./types";

export type CoreError =
  /** The user id is empty or not a string. */
  | { code: "invalid_user" }
  /** No user has this id. */
  | { code: "unknown_user" }
  /** The media type is not movie or tv, or the TMDB ID is not a positive integer that fits the database. */
  | { code: "invalid_title"; message: string }
  /** The rating is not 0.5 to 5 in half steps. */
  | { code: "invalid_rating"; rating: unknown }
  /** The review is not a string or null, is too long, or holds a character the database cannot store. */
  | { code: "invalid_review"; message: string }
  /** The edit names no field to change. */
  | { code: "empty_patch" }
  /** The move is not one the lists allow. */
  | { code: "invalid_move"; message: string }
  /** The title has no row for this user. */
  | { code: "not_found" }
  /**
   * The title's row is not in the state this action applies to: a list move
   * from the wrong list, a rating edit on a title that is not seen, or an undo
   * whose row has changed since the action it would undo. `status` is where
   * the title is now. `expected` lists the statuses that would have worked
   * (empty when the action needed no row at all).
   */
  | { code: "wrong_state"; status: TitleStatus; expected: TitleStatus[] }
  /** A state passed to restoreTitleState is malformed or names another title. */
  | { code: "invalid_snapshot"; message: string }
  /** A list status, sort, cursor, limit, or filter is invalid. */
  | { code: "invalid_list_query"; message: string }
  /** A filter needs title metadata and no details lookup was passed. */
  | { code: "details_lookup_required" }
  /** A settings value is invalid. */
  | { code: "invalid_settings"; message: string }
  /** The country is well formed, but TMDB has no streaming data for it. */
  | { code: "unknown_country"; country: string }
  /** The change saves more streaming services than one user may keep. */
  | { code: "too_many_services"; max: number }
  /** A deck request's mode, filters, or cursor is invalid, or the cursor belongs to another mode or filters. */
  | { code: "invalid_deck_query"; message: string }
  /** TMDB has no title with this (media type, TMDB ID). */
  | { code: "unknown_title" };

export type Result<T> = { ok: true; value: T } | { ok: false; error: CoreError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: CoreError): Result<T> {
  return { ok: false, error };
}

/** A user id is a non-empty string (Better Auth's text ids). */
export function validateUserId(userId: unknown): Result<string> {
  return typeof userId === "string" && userId.length > 0 ? ok(userId) : fail({ code: "invalid_user" });
}
