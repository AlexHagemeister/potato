"use server";

// Server actions for the Lists tab. Thin glue (CLAUDE.md rule 3): each one
// resolves the user from the session cookie, never from client input, calls
// core, and words core's typed errors for the screen. Core checks every input
// (the title, the rating, the review, the undo state, the cursor). No action
// takes a clock or a user id from the client.

import {
  getTitleState,
  moveTitle,
  readChangedElsewhere,
  removeRatingReview,
  restoreTitleState,
  updateRatingReview,
  type ActionOutcome,
  type CoreError,
  type Result,
  type TitleRecord,
  type UndoInput,
} from "@/core/library";
import { normalizeFilterChoice, toDeckFilters, type FilterChoice } from "@/core/filters";
import { getAllLists, getListRows, type ListRowsPage } from "@/core/lists";
import type { ListStatus, TitleId } from "@/core/types";
import { getCurrentUserForRequest } from "@/lib/current-user";

export type ActionResult<T> =
  | { ok: true; value: T }
  /**
   * `stale` means the title changed elsewhere (another device, the AI connection): reload the lists. The refusals
   * of a removal and of the rating sheet's saves also carry `current`, the title's row as it is now, when it could
   * be read.
   */
  | { ok: false; error: string; stale?: boolean; current?: TitleRecord | null };

const SIGNED_OUT = "You're signed out. Sign in again to save.";
const STALE = "This title changed somewhere else. Your lists are up to date now.";
const NOT_REMOVED_CHANGED = "Not removed: the rating or review changed somewhere else. Open Edit rating to see it.";
const NOT_REMOVED_GONE = "Not removed: this title changed somewhere else and isn't on your Seen list now.";

/*
 * A rating sheet's save refused because the title changed elsewhere (issue 79). The sheet stays open with what the
 * user typed, so each message says what happened and where the title is now, worded from the row read after the
 * refusal. The title card's Edit rating uses the same action as the Lists tab, so the edit's words hold on both.
 */
const NOT_SAVED_CHANGED = "Not saved: this title changed somewhere else.";
const COPY_REVIEW = "Copy your review if you want to keep it.";

/** Where a title is now, for a message. Skipped counts as no list, as VISION words it. */
function whereNow(current: TitleRecord | null): string {
  switch (current?.status) {
    case "watchlist":
      return "It's on your Watchlist now.";
    case "passed":
      return "It's on your Passed list now.";
    case "seen":
      return "It's on your Seen list now.";
    default:
      return "It isn't on any of your lists now.";
  }
}

/** Edit rating, refused: the title is no longer Seen. */
function editRefused(current: TitleRecord | null | undefined): string {
  // Unread, or Seen again by the time it was read: say only that it changed.
  if (current === undefined || current?.status === "seen") return NOT_SAVED_CHANGED;
  return `Not saved: this title left your Seen list somewhere else. ${whereNow(current)}`;
}

/** Watchlist to Seen, refused: the title is no longer on the Watchlist. */
function markSeenRefused(current: TitleRecord | null | undefined): string {
  if (current === undefined || current?.status === "watchlist") return NOT_SAVED_CHANGED;
  // The same words as Seen it on a card, refused for the same reason.
  if (current?.status === "seen") return "Not saved: you already marked this Seen somewhere else, and the rating there stays.";
  return `Not saved: this title left your Watchlist somewhere else. ${whereNow(current)}`;
}

/** A refusal message, with the reminder to copy the review when the sheet holds one. */
function withCopy(message: string, review: unknown): string {
  return typeof review === "string" && review.trim() !== "" ? `${message} ${COPY_REVIEW}` : message;
}

/** Presentation only: the words the screen shows for each core error. */
function failure(error: CoreError): { ok: false; error: string; stale?: boolean } {
  switch (error.code) {
    case "invalid_user":
    case "unknown_user":
      return { ok: false, error: SIGNED_OUT };
    case "wrong_state":
    case "stale_value":
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

/**
 * Runs one action as the signed-in user. With `stale`, a refusal that means the title changed elsewhere (core
 * decides which do) is worded by `stale.message` from the title's row as it is now, and carries that row.
 */
async function run<T>(
  fn: (userId: string) => Promise<Result<T>>,
  outage = "Couldn't save. Try again.",
  stale?: { ref: TitleId; message: (current: TitleRecord | null | undefined) => string },
): Promise<ActionResult<T>> {
  try {
    // The session read is a database read too, so it sits inside the try.
    const user = await getCurrentUserForRequest();
    if (!user) return { ok: false, error: SIGNED_OUT };
    const result = await fn(user.id);
    if (result.ok) return result;
    const changed = stale ? await readChangedElsewhere(user.id, stale.ref, result.error) : null;
    if (stale && changed) {
      const { current } = changed;
      return { ok: false, error: stale.message(current), stale: true, ...(current !== undefined ? { current } : {}) };
    }
    return failure(result.error);
  } catch (err) {
    console.error("lists action failed:", err);
    return { ok: false, error: outage };
  }
}

/** Watchlist to Seen, with a rating and an optional review. A blank review saves none. */
export async function markSeenAction(ref: TitleId, rating: number, review: string): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => moveTitle(userId, ref, { from: "watchlist", to: "seen", rating, review }), undefined, {
    ref,
    message: (current) => withCopy(markSeenRefused(current), review),
  });
}

/** Passed to Watchlist. */
export async function addToWatchlistAction(ref: TitleId): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => moveTitle(userId, ref, { from: "passed", to: "watchlist" }));
}

/** Edits a Seen title's rating and review. A blank review clears it. */
export async function editRatingAction(ref: TitleId, rating: number, review: string): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => updateRatingReview(userId, ref, { rating, review }), undefined, {
    ref,
    message: (current) => withCopy(editRefused(current), review),
  });
}

/**
 * Removes a Seen title's rating and review, after the user confirmed it (issue 43). `rating` and `review` are what
 * the screen showed: core removes them only while the title still has exactly those.
 */
export async function removeRatingAction(ref: TitleId, rating: number, review: string | null): Promise<ActionResult<ActionOutcome>> {
  try {
    const user = await getCurrentUserForRequest();
    if (!user) return { ok: false, error: SIGNED_OUT };
    const result = await removeRatingReview(user.id, ref, { rating, review });
    if (result.ok) return result;
    const code = result.error.code;
    if (code === "stale_value" || code === "wrong_state" || code === "not_found") {
      // Refused because the title changed elsewhere. Send where it is now, so the screen can show it with the reason.
      const now = await getTitleState(user.id, ref).catch(() => null);
      const error = code === "stale_value" ? NOT_REMOVED_CHANGED : NOT_REMOVED_GONE;
      return { ok: false, error, stale: true, ...(now?.ok ? { current: now.value } : {}) };
    }
    if (code === "invalid_user" || code === "unknown_user") return { ok: false, error: SIGNED_OUT };
    // The screen sends back what it showed, so any other refusal is a bug, not something the user can fix.
    console.error("remove rating rejected:", result.error);
    return { ok: false, error: "Couldn't remove. Try again." };
  } catch (err) {
    console.error("remove rating failed:", err);
    return { ok: false, error: "Couldn't remove. Try again." };
  }
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
