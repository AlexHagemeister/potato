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
  getTitleState,
  markSeen,
  passTitle,
  restoreTitleState,
  saveDeckChoice,
  skipTitle,
  watchlistTitle,
  type ActionOutcome,
  type CoreError,
  type Result,
  type TitleRecord,
  type UndoInput,
} from "@/core/library";
import type { TitleId } from "@/core/types";
import { getCurrentUserForRequest } from "@/lib/current-user";

export type SortKind = "pass" | "skip" | "watchlist" | "seen";

export type DeckActionResult =
  | { ok: true; outcome: ActionOutcome }
  /**
   * `stale` means the title changed elsewhere (another device, the AI connection) and nothing was saved.
   * `current` is the title's row as it is now, when it could be read, so a card can show where the title is.
   */
  | { ok: false; error: string; stale?: boolean; current?: TitleRecord | null };

/**
 * A card write refused because the title is Seen already, marked elsewhere (issues 65 and 74). One message per
 * button, each true for that tap. A Seen title always has a rating but may have no review.
 */
const ALREADY_SEEN = "you already marked this Seen somewhere else";
const STALE_SORT: Record<Exclude<SortKind, "seen">, string> = {
  pass: `Not passed: ${ALREADY_SEEN}, so it stays on your Seen list.`,
  skip: `Not skipped: ${ALREADY_SEEN}, so it stays on your Seen list.`,
  watchlist: `Not added to your Watchlist: ${ALREADY_SEEN}, so it stays on your Seen list.`,
};
const STALE_SEEN = `Not saved: ${ALREADY_SEEN}, and the rating there stays.`;
const STALE_SEEN_TYPED = `${STALE_SEEN} Copy your review if you want to keep it.`;

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

/**
 * Runs one write as the signed-in user. For a card write, `stale` is the message for core's wrong_state, which a
 * card write returns only when the title is Seen already. The result then carries the title's row as it is now.
 * Undo passes no `stale`: its wrong_state means its own compare-and-set refused.
 */
async function run(
  fn: (userId: string) => Promise<Result<ActionOutcome>>,
  card: { ref: TitleId; stale: string } | null,
): Promise<DeckActionResult> {
  const undo = card === null;
  const user = await getCurrentUserForRequest();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const result = await fn(user.id);
    if (result.ok) return { ok: true, outcome: result.value };
    if (card && result.error.code === "wrong_state") {
      const now = await getTitleState(user.id, card.ref).catch(() => null);
      return { ok: false, error: card.stale, stale: true, ...(now?.ok ? { current: now.value } : {}) };
    }
    return { ok: false, error: messageFor(result.error, undo) };
  } catch (err) {
    console.error("deck action failed:", err);
    return { ok: false, error: undo ? "Couldn't undo. Try again." : "Couldn't save. Try again." };
  }
}

/**
 * Pass, Skip, or Watchlist on a card. Core refuses to move a Seen title, so a card never erases a rating and
 * review (issues 43 and 74). A Seen title's card shows no sort buttons, so a refusal here means the card is
 * stale: the title was marked Seen elsewhere.
 */
export async function sortCardAction(kind: Exclude<SortKind, "seen">, ref: TitleId): Promise<DeckActionResult> {
  return run(
    (userId) => {
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
    },
    { ref, stale: STALE_SORT[kind] ?? STALE_SORT.pass },
  );
}

/** Seen it, with the rating and the optional review. Core validates both. */
export async function markSeenAction(ref: TitleId, rating: number, review: string | null): Promise<DeckActionResult> {
  const typed = typeof review === "string" && review.trim() !== "";
  return run((userId) => markSeen(userId, ref, { rating, review }), { ref, stale: typed ? STALE_SEEN_TYPED : STALE_SEEN });
}

/** Undo: puts the title back the way it was before the sort, if nothing changed it since. */
export async function undoSortAction(ref: TitleId, outcome: UndoInput): Promise<DeckActionResult> {
  return run((userId) => restoreTitleState(userId, ref, outcome), null);
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
