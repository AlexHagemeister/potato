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
 * deliberate step, never one stray tap).
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
 * Checks what a removal says the user was shown, and normalizes it the way a
 * write stores it (a blank review is no review), so it compares equal to the
 * stored row.
 */
export function planRatingReviewRemoval(shown: unknown): Result<{ rating: number; review: string | null }> {
  const s = typeof shown === "object" && shown !== null ? (shown as Record<string, unknown>) : {};
  const rating = validateRating(s.rating);
  if (!rating.ok) return rating;
  const review = validateReview(s.review);
  if (!review.ok) return review;
  return ok({ rating: rating.value, review: review.value });
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
