"use server";

// Server actions behind the deck's four buttons and its Undo. Thin glue
// (CLAUDE.md rule 3): each resolves the user from the session cookie, never
// from client input, calls the library core, and words core's typed errors
// for the screen. Every check (the title, the rating, the review, the undo's
// compare-and-set) lives in core.
//
// Server actions from one page run one at a time, in order, so on a title card
// an Undo always reaches the server after the sort it undoes. Discover sends
// its sorts and its mode and filters through routes instead (src/app/api/deck/
// sort and choice, issue 106), which call the functions here. Its Undo waits
// for the sort's answer before it is sent.

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
import type { TitleId, TitleStatus } from "@/core/types";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { ALREADY_SEEN, COPY_REVIEW, STALE_SEEN } from "./stale-copy";

export type SortKind = "pass" | "skip" | "watchlist" | "seen";

export type DeckActionResult =
  | { ok: true; outcome: ActionOutcome }
  /**
   * `stale` means the title changed elsewhere (another device, the AI connection) and nothing was saved, or for an
   * Undo, nothing was undone.
   * `current` is the title's row as it is now, when it could be read, so a card can show where the title is.
   */
  | { ok: false; error: string; stale?: boolean; current?: TitleRecord | null };

/**
 * A card write refused because the title is Seen already, marked elsewhere (issues 65 and 74). One message per
 * button, each true for that tap. A Seen title always has a rating but may have no review.
 */
const STALE_SORT: Record<Exclude<SortKind, "seen">, string> = {
  pass: `Not passed: ${ALREADY_SEEN}, so it stays on your Seen list.`,
  skip: `Not skipped: ${ALREADY_SEEN}, so it stays on your Seen list.`,
  watchlist: `Not added to your Watchlist: ${ALREADY_SEEN}, so it stays on your Seen list.`,
};
const STALE_SEEN_TYPED = `${STALE_SEEN} ${COPY_REVIEW}`;

/**
 * A Discover card's tap refused because the title was put on a list, or skipped, elsewhere while the card was on
 * screen (issue 83). The notice says where it is. A Seen title keeps the button's own message above.
 */
const ALREADY_ON: Record<Exclude<TitleStatus, "seen">, string> = {
  watchlist: "Already on your Watchlist.",
  passed: "Already on your Passed list.",
  skipped: "Already skipped. It comes back to Discover later.",
};

const SIGNED_OUT = "You're signed out. Sign in again to save.";

/**
 * A Discover card's tap refused because the title changed again while the tap was saving: core's not_found from
 * a guard that locked a row which was gone, or showable again, by the time it looked (issue 100). Nothing was
 * saved and the title is on no list, so the card comes back and the tap can be made again.
 */
const CHANGED_MEANWHILE = "Couldn't save: this title changed just now. Try again.";

/** An Undo refused because the title changed since the action it undoes (core's compare-and-set). */
const UNDO_STALE: ReadonlySet<CoreError["code"]> = new Set(["wrong_state", "stale_value", "not_found"]);

/** Presentation only: the words the screen shows for each core error. */
function messageFor(error: CoreError, undo: boolean): string {
  switch (error.code) {
    case "invalid_user":
    case "unknown_user":
      return SIGNED_OUT;
    case "invalid_rating":
      return "Pick a rating from half a star to 10 stars.";
    case "invalid_review":
      return "That review can't be saved. Try shortening it.";
    case "wrong_state":
    case "stale_value":
    case "not_found":
      if (undo) return "Couldn't undo: this title changed since.";
      // A documented race, not a fault (core's onNoListRefused), so it is not logged as one.
      if (error.code === "not_found") return CHANGED_MEANWHILE;
      break;
  }
  console.error("deck action rejected:", error);
  return undo ? "Couldn't undo. Try again." : "Couldn't save. Try again.";
}

/** How a card write words core's wrong_state (the title is somewhere the card didn't show), and whether to read the title's row for the screen. */
interface CardRefusal {
  ref: TitleId;
  /** The message for core's wrong_state, from the status the title has now. */
  stale: (status: TitleStatus) => string;
  /** The title card shows the row from the refusal. The deck drops the card, so it skips the read. */
  readCurrent: boolean;
}

/** How an Undo's refusal is answered: whether to read the title's row for the screen, as for a card write. */
interface UndoRefusal {
  ref: TitleId;
  /** The title card shows the row from the refusal (issue 49). The deck takes the card out again, so it skips the read. */
  readCurrent: boolean;
}

/**
 * Runs one write as the signed-in user. For a card write, core's wrong_state means the card was stale: the title
 * is Seen already, or, for a Discover card, on any list or skipped (issue 83). `card.stale` words it, and the
 * result can carry the title's row as it is now. Undo passes no `card` but `undoOf`: its wrong_state, stale_value,
 * or not_found means its own compare-and-set refused because the title changed since, which is stale too.
 */
async function run(
  fn: (userId: string) => Promise<Result<ActionOutcome>>,
  card: CardRefusal | null,
  undoOf: UndoRefusal | null = null,
): Promise<DeckActionResult> {
  const undo = card === null;
  const user = await getCurrentUserForRequest();
  if (!user) return { ok: false, error: SIGNED_OUT };
  /** A stale refusal, with the title's row as it is now when it is wanted and could be read. */
  const staleResult = async (error: string, ref: TitleId, readCurrent: boolean): Promise<DeckActionResult> => {
    if (!readCurrent) return { ok: false, error, stale: true };
    const now = await getTitleState(user.id, ref).catch(() => null);
    return { ok: false, error, stale: true, ...(now?.ok ? { current: now.value } : {}) };
  };
  try {
    const result = await fn(user.id);
    if (result.ok) return { ok: true, outcome: result.value };
    if (card && result.error.code === "wrong_state") {
      return staleResult(card.stale(result.error.status), card.ref, card.readCurrent);
    }
    if (undoOf && UNDO_STALE.has(result.error.code)) {
      return staleResult(messageFor(result.error, true), undoOf.ref, undoOf.readCurrent);
    }
    return { ok: false, error: messageFor(result.error, undo) };
  } catch (err) {
    console.error("deck action failed:", err);
    return { ok: false, error: undo ? "Couldn't undo. Try again." : "Couldn't save. Try again." };
  }
}

/** One Pass, Skip, or Watchlist write in core. */
function sortTitle(kind: Exclude<SortKind, "seen">, userId: string, ref: TitleId, shownOnNoList: boolean): Promise<Result<ActionOutcome>> {
  const options = { shownOnNoList };
  switch (kind) {
    case "pass":
      return passTitle(userId, ref, options);
    case "skip":
      return skipTitle(userId, ref, options);
    case "watchlist":
      return watchlistTitle(userId, ref, options);
    default:
      return Promise.resolve({ ok: false, error: { code: "invalid_move", message: `unknown sort: ${String(kind)}` } });
  }
}

/**
 * Pass, Skip, or Watchlist on a title card (Search, Lists). The card shows the list the title is on, so a tap
 * moves it from there. Core refuses to move a Seen title, so a card never erases a rating and review (issues 43
 * and 74). A Seen title's card shows no sort buttons, so a refusal here means the card is stale: the title was
 * marked Seen elsewhere.
 */
export async function sortCardAction(kind: Exclude<SortKind, "seen">, ref: TitleId): Promise<DeckActionResult> {
  return run((userId) => sortTitle(kind, userId, ref, false), {
    ref,
    // An unknown kind never gets here: sortTitle refuses it with invalid_move, not wrong_state.
    stale: () => STALE_SORT[kind],
    readCurrent: true,
  });
}

/**
 * Pass, Skip, or Watchlist on a Discover card, which always shows its title on no list. If the title was put on a
 * list, or skipped, elsewhere while the card was on screen, core leaves it where it is (Alex's ruling on issue
 * 83: the earlier choice wins), and the notice says where it is.
 */
export async function sortDeckCardAction(kind: Exclude<SortKind, "seen">, ref: TitleId): Promise<DeckActionResult> {
  return run((userId) => sortTitle(kind, userId, ref, true), {
    ref,
    stale: (status) => (status === "seen" ? STALE_SORT[kind] : ALREADY_ON[status]),
    readCurrent: false,
  });
}

/** Seen it, with the rating and the optional review. Core validates both. */
export async function markSeenAction(ref: TitleId, rating: number, review: string | null): Promise<DeckActionResult> {
  const typed = typeof review === "string" && review.trim() !== "";
  return run((userId) => markSeen(userId, ref, { rating, review }), {
    ref,
    stale: () => (typed ? STALE_SEEN_TYPED : STALE_SEEN),
    readCurrent: true,
  });
}

/**
 * Undo on Discover: puts the title back the way it was before the sort, if nothing changed it since. A refusal
 * because it changed is `stale`. The deck takes the card out again either way, so it skips the read.
 */
export async function undoSortAction(ref: TitleId, outcome: UndoInput): Promise<DeckActionResult> {
  return run((userId) => restoreTitleState(userId, ref, outcome), null, { ref, readCurrent: false });
}

/**
 * Undo on a title card (Search, Lists). The same undo, but a refusal because the title changed since carries the
 * title's row as it is now, so the card can show where it really is instead of the state it held before the Undo
 * (issue 49).
 */
export async function undoCardSortAction(ref: TitleId, outcome: UndoInput): Promise<DeckActionResult> {
  return run((userId) => restoreTitleState(userId, ref, outcome), null, { ref, readCurrent: true });
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
