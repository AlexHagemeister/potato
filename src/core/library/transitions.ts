// Pure state-transition rules. Every write sets all four status-dependent
// columns, nulling the ones the new status does not use, so a row always
// satisfies the table's "exactly when" checks whatever status it came from.

import { skipUntilFrom } from "../deck/constants";
import type { TitleStatus } from "../types";
import { fail, ok, type Result } from "../result";
import { validateRating, validateReview } from "./validate";
import type { MoveRequest } from "./types";

/** The columns a status write sets. */
export interface StatusColumns {
  status: TitleStatus;
  rating: number | null;
  review: string | null;
  /**
   * Keep the row's current review instead of writing `review`. Only a Seen
   * write can set it, so it keeps a review only when the title is already Seen
   * (the schema allows a review on no other status).
   */
  keepReview: boolean;
  skipUntil: Date | null;
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
      return ok({ status: intent.status, rating: null, review: null, keepReview: false, skipUntil: null });
    case "skipped":
      return ok({ status: "skipped", rating: null, review: null, keepReview: false, skipUntil: skipUntilFrom(now) });
    case "seen": {
      const rating = validateRating(intent.rating);
      if (!rating.ok) return rating;
      const review = validateReview(intent.review);
      if (!review.ok) return review;
      return ok({ status: "seen", rating: rating.value, review: review.value, keepReview: intent.review === undefined, skipUntil: null });
    }
  }
}

/**
 * The moves the Lists tab offers (VISION: Your lists). Each list move names
 * where the title must be now, so a stale screen cannot move a title it no
 * longer shows. Any other change goes through a card action or removeTitle.
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
    return ok({ from: move.from, columns: { status: "seen", rating: rating.value, review: review.value, keepReview: false, skipUntil: null } });
  }
  return ok({ from: move.from, columns: { status: "watchlist", rating: null, review: null, keepReview: false, skipUntil: null } });
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
