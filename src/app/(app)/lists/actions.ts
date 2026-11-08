"use server";

// Server actions for the Lists tab. Thin glue (CLAUDE.md rule 3): each one
// resolves the user from the session cookie, never from client input, calls
// core, and words core's typed errors for the screen. Core checks every input
// (the title, the rating, the review, the undo state, the cursor). No action
// takes a clock or a user id from the client.

import {
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
import { COPY_REVIEW, STALE_SEEN } from "../_deck/stale-copy";

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
const NOT_REMOVED_CHANGED = "Not removed: the rating or review changed since you opened this. Open Edit rating to see it.";
const NOT_REMOVED_GONE = "Not removed: this title changed somewhere else and isn't on your Seen list now.";

/*
 * A rating sheet's save refused because the title changed elsewhere (issues 79 and 103). The sheet stays open with
 * what the user typed, so each message says what happened and where the title is now, worded from the row read
 * after the refusal. The title card's Edit rating uses the same action as the Lists tab, so the edit's words hold on
 * both, and Watchlist to Seen shares the card's Seen it words (stale-copy.ts).
 */
const NOT_SAVED_CHANGED = "Not saved: this title changed somewhere else.";

/** Where a title is now, for a message, when it is on no list or a list other than Seen. Skipped counts as no list, as VISION words it. */
function whereNow(current: TitleRecord | null): string {
  switch (current?.status) {
    case "watchlist":
      return "It's on your Watchlist now.";
    case "passed":
      return "It's on your Passed list now.";
    default:
      return "It isn't on any of your lists now.";
  }
}

/** Whether the sheet holds a review the user typed, so the message reminds them to copy it. */
function typedReview(review: unknown): boolean {
  return typeof review === "string" && review.trim() !== "";
}

/** A refusal message, with the reminder to copy the review when the sheet holds one. */
function withCopy(message: string, typed: boolean): string {
  return typed ? `${message} ${COPY_REVIEW}` : message;
}

/**
 * Edit rating, refused. Either the title left Seen, or it is still Seen with a rating or review other than the
 * sheet opened with (issue 103): another device or the AI connection changed it. The sheet still holds what it
 * opened with, so its next Save is refused too, and the user sees the new rating by opening Edit again.
 */
function editRefused(current: TitleRecord | null | undefined, typed: boolean): string {
  if (current === undefined) return withCopy(NOT_SAVED_CHANGED, typed);
  if (current?.status === "seen") {
    // "Edit rating" names the card's button and the sheet's heading, as NOT_REMOVED_CHANGED does.
    const reopen = typed
      ? `${COPY_REVIEW} Then cancel and open Edit rating again to see the new one.`
      : "Cancel and open Edit rating again to see the new one.";
    return `Not saved: your rating or review changed since you opened this. ${reopen}`;
  }
  return withCopy(`Not saved: this title left your Seen list somewhere else. ${whereNow(current)}`, typed);
}

/** Watchlist to Seen, refused: the title is no longer on the Watchlist. */
function markSeenRefused(current: TitleRecord | null | undefined, typed: boolean): string {
  if (current === undefined || current?.status === "watchlist") return withCopy(NOT_SAVED_CHANGED, typed);
  // The same words as Seen it on a card, refused for the same reason.
  if (current?.status === "seen") return withCopy(STALE_SEEN, typed);
  return withCopy(`Not saved: this title left your Watchlist somewhere else. ${whereNow(current)}`, typed);
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
      return { ok: false, error: "Pick a rating from half a star to 10 stars." };
    case "invalid_review":
      return { ok: false, error: "That review can't be saved. It may be too long." };
    default:
      // The rest carry developer wording, not screen copy.
      console.error("lists action rejected:", error);
      return { ok: false, error: "Couldn't save that. Try again." };
  }
}

/** How run words a refusal that means the title changed elsewhere, from the title's row as it is now. */
interface StaleWording {
  ref: TitleId;
  message: (current: TitleRecord | null | undefined) => string;
}

/**
 * Runs one action as the signed-in user. With `stale`, a refusal that means the title changed elsewhere (core
 * decides which do) is worded by `stale.message` from the title's row as it is now, and carries that row.
 */
async function run<T>(
  fn: (userId: string) => Promise<Result<T>>,
  { outage = "Couldn't save. Try again.", stale }: { outage?: string; stale?: StaleWording } = {},
): Promise<ActionResult<T>> {
  try {
    // The session read is a database read too, so it sits inside the try.
    const user = await getCurrentUserForRequest();
    if (!user) return { ok: false, error: SIGNED_OUT };
    const result = await fn(user.id);
    if (result.ok) return result;
    const changed = stale && (await readChangedElsewhere(user.id, stale.ref, result.error));
    if (!changed) return failure(result.error);
    const { current } = changed;
    return { ok: false, error: stale.message(current), stale: true, ...(current !== undefined ? { current } : {}) };
  } catch (err) {
    console.error("lists action failed:", err);
    return { ok: false, error: outage };
  }
}

/** Watchlist to Seen, with a rating and an optional review. A blank review saves none. */
export async function markSeenAction(ref: TitleId, rating: number, review: string): Promise<ActionResult<ActionOutcome>> {
  const typed = typedReview(review);
  return run((userId) => moveTitle(userId, ref, { from: "watchlist", to: "seen", rating, review }), {
    stale: { ref, message: (current) => markSeenRefused(current, typed) },
  });
}

/** Passed to Watchlist. */
export async function addToWatchlistAction(ref: TitleId): Promise<ActionResult<ActionOutcome>> {
  return run((userId) => moveTitle(userId, ref, { from: "passed", to: "watchlist" }));
}

/**
 * Edits a Seen title's rating and review. A blank review clears it. `shown` is the rating and review the sheet
 * opened with: core saves the edit only while the title still has exactly those (issue 103), so a sheet left open
 * never overwrites a rating or review written elsewhere since.
 */
export async function editRatingAction(
  ref: TitleId,
  rating: number,
  review: string,
  shown: { rating: number; review: string | null },
): Promise<ActionResult<ActionOutcome>> {
  const typed = typedReview(review);
  return run((userId) => updateRatingReview(userId, ref, { rating, review }, shown), {
    stale: { ref, message: (current) => editRefused(current, typed) },
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
    // Refused because the title changed elsewhere (core decides): send where it is now, so the screen can show it.
    const changed = await readChangedElsewhere(user.id, ref, result.error);
    if (changed) {
      const { current } = changed;
      const error = result.error.code === "stale_value" ? NOT_REMOVED_CHANGED : NOT_REMOVED_GONE;
      return { ok: false, error, stale: true, ...(current !== undefined ? { current } : {}) };
    }
    const code = result.error.code;
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
  return run((userId) => getAllLists(userId, { filters: filtersFrom(choice) }), { outage: "Couldn't load your lists. Try again." });
}

/** The next page of a list, under the same filters as the page before. */
export async function loadMoreAction(
  status: ListStatus,
  cursor: string,
  choice: FilterChoice,
): Promise<ActionResult<ListRowsPage>> {
  return run((userId) => getListRows(userId, status, { cursor, filters: filtersFrom(choice) }), { outage: "Couldn't load more. Try again." });
}
