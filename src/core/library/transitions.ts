// Pure state-transition rules. Every write sets all four status-dependent
// columns, nulling the ones the new status does not use, so a row always
// satisfies the table's "exactly when" checks whatever status it came from.

import { skipUntilFrom } from "../deck/constants";
import type { TitleStatus } from "../types";
import { fail, ok, type CoreError, type Result } from "../result";
import { validateRating, validateReview } from "./validate";
import type { MoveRequest } from "./types";

/** The columns a status write sets. */
export interface StatusColumns {
  status: TitleStatus;
  rating: number | null;
  review: string | null;
  skipUntil: Date | null;
}

/** Every status, in a fixed order. The Record type makes the compiler flag a status added to the schema. */
const EVERY_STATUS = Object.keys({ watchlist: 0, passed: 0, skipped: 0, seen: 0 } satisfies Record<TitleStatus, 0>) as TitleStatus[];

/**
 * The one rule for which row a write may replace or delete without naming
 * what the user was shown (issues 43, 65, and 74, VISION invariant 6): any row
 * but a Seen one. A title on no list can always be written.
 *
 * A Seen row holds a rating, and maybe a review, that the caller may never
 * have shown: another device or the AI connection can write them while a card
 * sits open. So no card button (Pass, Skip, Watchlist, Seen it) and no
 * removeTitle ever replaces or deletes a Seen row, whatever the caller says it
 * showed. A Seen title changes only through the calls that name what the user
 * saw: updateRatingReview edits the rating and review, and removeRatingReview
 * takes them off the Seen list (Alex's ruling on issue 43: removing them is a
 * deliberate step, never one stray tap). Undo (restoreTitleState) can also
 * take a title off the Seen list, but only by naming the Seen row's exact
 * rating and review, as the action it undoes returned them.
 *
 * The SQL guards and the refusal's `expected` are both built from this.
 */
export const REPLACEABLE: readonly TitleStatus[] = EVERY_STATUS.filter((s) => s !== "seen");

/**
 * The refusal when a REPLACEABLE guard holds. The guard can only refuse a Seen
 * row, so the error says so directly, rather than reading the statement's
 * snapshot, which can miss a Seen row committed at the same instant.
 */
export function seenRefused(): CoreError {
  return { code: "wrong_state", status: "seen", expected: [...REPLACEABLE] };
}

/**
 * Whether a refused write means the title changed since the caller read it
 * (another device, the AI connection), rather than bad input or an unknown
 * user. Every write that names what the caller showed refuses this way when
 * that no longer holds:
 *
 * - wrong_state: the title is on another list than the write needs (a list
 *   move from the wrong list, a rating edit on a title no longer Seen, a card
 *   write on a Seen title, a Discover card's tap on a title already on a list,
 *   an undo of a row that moved).
 * - not_found: the title is on no list now.
 * - stale_value: the title is still Seen, with another rating or review.
 *
 * Nothing was written. Read the title again to show where it is now
 * (readChangedElsewhere).
 */
export function isChangedElsewhere(error: CoreError): boolean {
  return error.code === "wrong_state" || error.code === "not_found" || error.code === "stale_value";
}

/**
 * Which rows a card write may replace (Alex's ruling on issue 83, option A).
 *
 * - `replaceable`: any row but a Seen one (REPLACEABLE). The title card uses
 *   it: it shows the list the title is on, so a tap there is a knowing move.
 *   So does any caller that says nothing, such as the future AI connection.
 * - `on_no_list`: only a row the deck may show (core's rowVisible): no row at
 *   all, or a Skip whose return time has passed, since a returned Skip is
 *   dealt again. A Discover card always showed the title on no list, so a row
 *   on any list, or a Skip that hasn't returned yet, means the card went
 *   stale while on screen: the title was sorted on another device or in
 *   another tab. The earlier choice wins, and the tap changes nothing
 *   (VISION invariant 3: the deck respects decisions already made).
 */
export type CardGuard = "replaceable" | "on_no_list";

/**
 * The guard for one card write. Pass, Skip, and Watchlist use `on_no_list`
 * only when the caller says it showed the title on no list (strictly
 * `shownOnNoList: true`). Seen it always uses `replaceable`: it records a
 * rating the user typed on purpose, and Watchlist to Seen is a move the lists
 * offer anyway, so a stale card's Seen it still moves a title off another
 * list. It still never replaces a Seen row.
 */
export function cardGuardFor(intent: CardIntent, shownOnNoList: unknown): CardGuard {
  return intent.status !== "seen" && shownOnNoList === true ? "on_no_list" : "replaceable";
}

/**
 * Checks what a removal says the user was shown. The review is kept exactly as
 * given, not normalized the way a write stores one: it is compared with the
 * stored row, which may hold text no write would store today (a blank review
 * put back by an undo), and the caller echoes the stored value. Left out or
 * null means no review was shown.
 */
export function planRatingReviewRemoval(shown: unknown): Result<{ rating: number; review: string | null }> {
  const s = typeof shown === "object" && shown !== null ? (shown as Record<string, unknown>) : {};
  const rating = validateRating(s.rating);
  if (!rating.ok) return rating;
  const review = s.review ?? null;
  if (review !== null && typeof review !== "string") {
    return fail({ code: "invalid_review", message: "review must be a string or null" });
  }
  // Postgres text cannot hold a NUL character, so no stored review has one, and the parameter would fail.
  if (review?.includes("\u0000")) return fail({ code: "invalid_review", message: "review contains a NUL character" });
  return ok({ rating: rating.value, review });
}

/** The four card buttons, as row writes. */
export type CardIntent =
  | { status: "watchlist" }
  | { status: "passed" }
  | { status: "skipped" }
  | { status: "seen"; rating: unknown; review?: unknown };

/** The full column set for a card action, or a typed error for a bad rating or review. */
export function columnsFor(intent: CardIntent, now: Date): Result<StatusColumns> {
  switch (intent.status) {
    case "watchlist":
    case "passed":
      return ok({ status: intent.status, rating: null, review: null, skipUntil: null });
    case "skipped":
      return ok({ status: "skipped", rating: null, review: null, skipUntil: skipUntilFrom(now) });
    case "seen": {
      const rating = validateRating(intent.rating);
      if (!rating.ok) return rating;
      const review = validateReview(intent.review);
      if (!review.ok) return review;
      return ok({ status: "seen", rating: rating.value, review: review.value, skipUntil: null });
    }
  }
}

/**
 * The moves the Lists tab offers (VISION: Your lists). Each list move names
 * where the title must be now, so a stale screen cannot move a title it no
 * longer shows. Any other change goes through a card action, removeTitle, or
 * removeRatingReview.
 */
export const ALLOWED_MOVES: ReadonlyArray<{ from: TitleStatus; to: TitleStatus }> = [
  { from: "watchlist", to: "seen" },
  { from: "passed", to: "watchlist" },
];

export function isAllowedMove(from: unknown, to: unknown): boolean {
  return ALLOWED_MOVES.some((m) => m.from === from && m.to === to);
}

/** The guard status and new columns for a list move. */
export function planMove(move: MoveRequest): Result<{ from: TitleStatus; columns: StatusColumns }> {
  if (typeof move !== "object" || move === null || !isAllowedMove(move.from, move.to)) {
    const from = (move as { from?: unknown } | null)?.from;
    const to = (move as { to?: unknown } | null)?.to;
    return fail({ code: "invalid_move", message: `cannot move from ${JSON.stringify(from)} to ${JSON.stringify(to)}` });
  }
  if (move.to === "seen") {
    // Watchlist to Seen asks for a rating (VISION: Your lists).
    const rating = validateRating(move.rating);
    if (!rating.ok) return rating;
    const review = validateReview(move.review);
    if (!review.ok) return review;
    return ok({ from: move.from, columns: { status: "seen", rating: rating.value, review: review.value, skipUntil: null } });
  }
  return ok({ from: move.from, columns: { status: "watchlist", rating: null, review: null, skipUntil: null } });
}

/** The fields a rating and review edit sets. Absent fields stay as they are. */
export interface PatchColumns {
  rating?: number;
  review?: string | null;
}

export function planRatingReviewPatch(patch: unknown): Result<PatchColumns> {
  if (typeof patch !== "object" || patch === null) return fail({ code: "empty_patch" });
  const p = patch as Record<string, unknown>;
  const out: PatchColumns = {};
  if (p.rating !== undefined) {
    const rating = validateRating(p.rating);
    if (!rating.ok) return rating;
    out.rating = rating.value;
  }
  if (p.review !== undefined) {
    const review = validateReview(p.review);
    if (!review.ok) return review;
    out.review = review.value;
  }
  if (out.rating === undefined && !("review" in out)) return fail({ code: "empty_patch" });
  return ok(out);
}
