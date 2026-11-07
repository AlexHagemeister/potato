"use server";

// Server actions behind the deck's four buttons and its Undo. Thin glue
// (CLAUDE.md rule 3): each resolves the user from the session cookie, never
// from client input, calls the library core, and words core's typed errors
// for the screen. Every check (the title, the rating, the review, the undo's
// compare-and-set) lives in core.
//
// Server actions from one page run one at a time, in order, so an Undo always
// reaches the server after the sort it undoes.

import {
  markSeen,
  passTitle,
  restoreTitleState,
  saveDeckChoice,
  skipTitle,
  watchlistTitle,
  type ActionOutcome,
  type CoreError,
  type Result,
  type UndoInput,
} from "@/core/library";
import type { TitleId } from "@/core/types";
import { getCurrentUserForRequest } from "@/lib/current-user";

export type SortKind = "pass" | "skip" | "watchlist" | "seen";

export type DeckActionResult =
  | { ok: true; outcome: ActionOutcome }
  /** `stale` means the title changed elsewhere (another device, the AI connection) and nothing was saved. */
  | { ok: false; error: string; stale?: boolean };

/** Seen it on a title that is already Seen: core keeps the rating and review there (issue 65). */
const ALREADY_SEEN = "You already marked this Seen somewhere else. Your rating and review there are kept.";

const SIGNED_OUT = "You're signed out. Sign in again to save.";

/** Presentation only: the words the screen shows for each core error. */
function messageFor(error: CoreError, undo: boolean): string {
  switch (error.code) {
    case "invalid_user":
    case "unknown_user":
      return SIGNED_OUT;
    case "invalid_rating":
      return "Pick a rating from half a star to 5 stars.";
    case "invalid_review":
      return "That review can't be saved. Try shortening it.";
    case "wrong_state":
    case "not_found":
      if (undo) return "Couldn't undo: this title changed since.";
      break;
  }
  console.error("deck action rejected:", error);
  return undo ? "Couldn't undo. Try again." : "Couldn't save. Try again.";
}

async function run(undo: boolean, fn: (userId: string) => Promise<Result<ActionOutcome>>): Promise<DeckActionResult> {
  const user = await getCurrentUserForRequest();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const result = await fn(user.id);
    if (result.ok) return { ok: true, outcome: result.value };
    // Of the sorts, only Seen it refuses a title's current state: the title is Seen already.
    if (!undo && result.error.code === "wrong_state") return { ok: false, error: ALREADY_SEEN, stale: true };
    return { ok: false, error: messageFor(result.error, undo) };
  } catch (err) {
    console.error("deck action failed:", err);
    return { ok: false, error: undo ? "Couldn't undo. Try again." : "Couldn't save. Try again." };
  }
}

/** Pass, Skip, or Watchlist on a card. */
export async function sortCardAction(kind: Exclude<SortKind, "seen">, ref: TitleId): Promise<DeckActionResult> {
  return run(false, (userId) => {
    switch (kind) {
      case "pass":
        return passTitle(userId, ref);
      case "skip":
        return skipTitle(userId, ref);
      case "watchlist":
        return watchlistTitle(userId, ref);
      default:
        return Promise.resolve({ ok: false, error: { code: "invalid_move", message: `unknown sort: ${String(kind)}` } });
    }
  });
}

/** Seen it, with the rating and the optional review. Core validates both. */
export async function markSeenAction(ref: TitleId, rating: number, review: string | null): Promise<DeckActionResult> {
  return run(false, (userId) => markSeen(userId, ref, { rating, review }));
}

/** Undo: puts the title back the way it was before the sort, if nothing changed it since. */
export async function undoSortAction(ref: TitleId, outcome: UndoInput): Promise<DeckActionResult> {
  return run(true, (userId) => restoreTitleState(userId, ref, outcome));
}

/** Saves the Discover mode and filters to the profile, so they follow the user across devices. Core validates the choice. */
export async function saveDeckChoiceAction(choice: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const failed = { ok: false as const, error: "Couldn't save your mode and filters. Try again." };
  const user = await getCurrentUserForRequest();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const result = await saveDeckChoice(user.id, choice);
    if (result.ok) return { ok: true };
    if (result.error.code === "unknown_user" || result.error.code === "invalid_user") return { ok: false, error: SIGNED_OUT };
    console.error("deck choice rejected:", result.error);
    return failed;
  } catch (err) {
    console.error("deck choice save failed:", err);
    return failed;
  }
}
