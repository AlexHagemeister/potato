"use server";

// Server actions for the Lists tab. Thin glue (CLAUDE.md rule 3): each one
// resolves the user from the session cookie, never from client input, calls
// core, and words core's typed errors for the screen. Core checks every input
// (the title, the rating, the review, the undo state, the cursor). No action
// takes a clock or a user id from the client.

import {
  moveTitle,
  removeRatingReview,
  restoreTitleState,
  updateRatingReview,
  type ActionOutcome,
  type CoreError,
  type Result,
  type UndoInput,
} from "@/core/library";
import { normalizeFilterChoice, toDeckFilters, type FilterChoice } from "@/core/filters";
import { getAllLists, getListRows, type ListRowsPage } from "@/core/lists";
import type { ListStatus, TitleId } from "@/core/types";
import { getCurrentUserForRequest } from "@/lib/current-user";

export type ActionResult<T> =
  | { ok: true; value: T }
  /** `stale` means the title changed elsewhere (another device, the AI connection): reload the lists. */
  | { ok: false; error: string; stale?: boolean };

const SIGNED_OUT = "You're signed out. Sign in again to save.";
const STALE = "This title changed somewhere else. Your lists are up to date now.";

/** Presentation only: the words the screen shows for each core error. */
function failure(error: CoreError): { ok: false; error: string; stale?: boolean } {
  switch (error.code) {
    case "invalid_user":
    case "unknown_user":
      return { ok: false, error: SIGNED_OUT };
    case "wrong_state":
    case "not_found":
      return { ok: false, error: STALE, stale: true };
    case "invalid_rating":
      return { ok: false, error: "Pick a rating from half a star to 5 stars." };
    case "invalid_review":
      return { ok: false, error: "That review can't be saved. It may be too long." };
    default:
      // The rest carry developer wording, not screen copy.
      console.error("lists action rejected:", error);
      return { ok: false, error: "Couldn't save that. Try again." };
  }
}

async function run<T>(
  fn: (userId: string) => Promise<Result<T>>,
  outage = "Couldn't save. Try again.",
): Promise<ActionResult<T>> {
  try {
    // The session read is a database read too, so it sits inside the try.
    const user = await getCurrentUserForRequest();
    if (!user) return { ok: false, error: SIGNED_OUT };
    const result = await fn(user.id);
    return result.ok ? result : failure(result.error);
  } catch (err) {
    console.error("lists action failed:", err);
    return { ok: false, error: outage };
  }
}

/** Watchlist to Seen, with a rating and an optional review. A blank review saves none. */
export async function markSeenAction(ref: TitleId, rating: number, review: string): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => moveTitle(userId, ref, { from: "watchlist", to: "seen", rating, review }));
}

/** Passed to Watchlist. */
export async function addToWatchlistAction(ref: TitleId): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => moveTitle(userId, ref, { from: "passed", to: "watchlist" }));
}

/** Edits a Seen title's rating and review. A blank review clears it. */
export async function editRatingAction(ref: TitleId, rating: number, review: string): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => updateRatingReview(userId, ref, { rating, review }));
}

/**
 * Removes a Seen title's rating and review, after the user confirmed it (issue 43). `rating` and `review` are what
 * the screen showed: core removes them only while the title still has exactly those.
 */
export async function removeRatingAction(ref: TitleId, rating: number, review: string | null): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => removeRatingReview(userId, ref, { rating, review }));
}

/** Undoes one of the actions above, if the title has not changed since. */
export async function undoAction(ref: TitleId, outcome: UndoInput): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => restoreTitleState(userId, ref, outcome));
}

/** The filters for a choice from the client. Core cleans the choice, and the server's clock dates the era. */
const filtersFrom = (choice: unknown) => toDeckFilters(normalizeFilterChoice(choice), new Date());

/** The first page of every list under these filters. */
export async function loadListsAction(choice: FilterChoice): Promise<ActionResult<Record<ListStatus, ListRowsPage>>> {
  return run((userId) => getAllLists(userId, { filters: filtersFrom(choice) }), "Couldn't load your lists. Try again.");
}

/** The next page of a list, under the same filters as the page before. */
export async function loadMoreAction(
  status: ListStatus,
  cursor: string,
  choice: FilterChoice,
): Promise<ActionResult<ListRowsPage>> {
  return run((userId) => getListRows(userId, status, { cursor, filters: filtersFrom(choice) }), "Couldn't load more. Try again.");
}
