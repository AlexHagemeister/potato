// Typed errors for the library core. Callers (the UI, the API, a future MCP)
// get a result they can switch on instead of a thrown exception. Anything
// thrown is a bug or an outage (a bad connection, a broken invariant), never
// bad input.

import type { TitleStatus } from "../types";

export type LibraryError =
  /** The user id is empty or not a string. */
  | { code: "invalid_user" }
  /** No user has this id. */
  | { code: "unknown_user" }
  /** The media type is not movie or tv, or the TMDB ID is not a positive integer. */
  | { code: "invalid_title"; message: string }
  /** The rating is not 0.5 to 5 in half steps. */
  | { code: "invalid_rating"; rating: unknown }
  /** The review is not a string or null, or is too long. */
  | { code: "invalid_review"; message: string }
  /** The edit names no field to change. */
  | { code: "empty_patch" }
  /** The move is not one the lists allow. */
  | { code: "invalid_move"; message: string }
  /** The title has no row for this user. */
  | { code: "not_found" }
  /** The title's row is in a status this action does not apply to. */
  | { code: "wrong_state"; status: TitleStatus; expected: TitleStatus[] }
  /** A state passed to restoreTitleState is malformed or names another title. */
  | { code: "invalid_snapshot"; message: string }
  /** A list status, sort, cursor, limit, or filter is invalid. */
  | { code: "invalid_list_query"; message: string }
  /** A filter needs title metadata and no details lookup was passed. */
  | { code: "details_lookup_required" }
  /** A settings value is invalid. */
  | { code: "invalid_settings"; message: string };

export type LibraryResult<T> = { ok: true; value: T } | { ok: false; error: LibraryError };

export function ok<T>(value: T): LibraryResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: LibraryError): LibraryResult<T> {
  return { ok: false, error };
}
