// Pure input checks. The database enforces the same rules with CHECK
// constraints. Checking here too turns bad input into a typed error the
// caller can show, instead of a constraint violation.

import { TITLE_STATUSES } from "@/db/schema";
import type { TitleId, TitleStatus } from "../types";
import { fail, ok, type LibraryResult } from "./errors";
import { RATING_MAX, RATING_MIN, REVIEW_MAX_LENGTH, type TitleRecord } from "./types";

/** True for 0.5 to 5 in half steps, the scale title_status_rating_scale_check enforces. */
export function isValidRating(rating: unknown): rating is number {
  return (
    typeof rating === "number" &&
    Number.isFinite(rating) &&
    rating >= RATING_MIN &&
    rating <= RATING_MAX &&
    Number.isInteger(rating * 2)
  );
}

export function validateRating(rating: unknown): LibraryResult<number> {
  return isValidRating(rating) ? ok(rating) : fail({ code: "invalid_rating", rating });
}

/**
 * Normalizes a review. Undefined and null mean no review. A review that is
 * empty or only whitespace also becomes null, so a cleared text box never
 * leaves a blank review behind. Any other text is kept exactly as written.
 */
export function validateReview(review: unknown): LibraryResult<string | null> {
  if (review === undefined || review === null) return ok(null);
  if (typeof review !== "string") return fail({ code: "invalid_review", message: "review must be a string or null" });
  if (review.trim() === "") return ok(null);
  if (review.length > REVIEW_MAX_LENGTH) {
    return fail({ code: "invalid_review", message: `review is longer than ${REVIEW_MAX_LENGTH} characters` });
  }
  return ok(review);
}

export function validateUserId(userId: unknown): LibraryResult<string> {
  return typeof userId === "string" && userId.length > 0 ? ok(userId) : fail({ code: "invalid_user" });
}

/** The same rules as formatTitleKey, returned as a typed error instead of thrown. */
export function validateTitleRef(ref: unknown): LibraryResult<TitleId> {
  if (typeof ref !== "object" || ref === null) return fail({ code: "invalid_title", message: "title must be an object" });
  const { mediaType, tmdbId } = ref as Record<string, unknown>;
  if (mediaType !== "movie" && mediaType !== "tv") {
    return fail({ code: "invalid_title", message: `invalid media type ${JSON.stringify(mediaType)}` });
  }
  if (typeof tmdbId !== "number" || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
    return fail({ code: "invalid_title", message: `invalid TMDB ID ${JSON.stringify(tmdbId)}` });
  }
  // A fresh object, so nothing else the caller passed rides along into SQL.
  return ok({ mediaType, tmdbId });
}

function toDate(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Checks a state handed back for undo. It may have crossed JSON, so dates may
 * be ISO strings. It must name the same title as `ref` and satisfy every rule
 * the table's CHECK constraints hold. Fields other than the record's own
 * (a user id, say) are ignored: the caller's user id always wins.
 */
export function parseTitleRecord(input: unknown, ref: TitleId): LibraryResult<TitleRecord> {
  const bad = (message: string) => fail<TitleRecord>({ code: "invalid_snapshot", message });
  if (typeof input !== "object" || input === null) return bad("state must be an object or null");
  const r = input as Record<string, unknown>;

  if (r.mediaType !== ref.mediaType || r.tmdbId !== ref.tmdbId) return bad("state names a different title");
  if (!(TITLE_STATUSES as readonly unknown[]).includes(r.status)) return bad(`invalid status ${JSON.stringify(r.status)}`);
  const status = r.status as TitleStatus;

  let rating: number | null = null;
  if (status === "seen") {
    if (!isValidRating(r.rating)) return bad("a seen state needs a rating from 0.5 to 5 in half steps");
    rating = r.rating;
  } else if (r.rating !== null && r.rating !== undefined) {
    return bad("only a seen state carries a rating");
  }

  let review: string | null = null;
  if (r.review !== null && r.review !== undefined) {
    if (status !== "seen") return bad("only a seen state carries a review");
    if (typeof r.review !== "string" || r.review.length > REVIEW_MAX_LENGTH) return bad("invalid review");
    review = r.review; // Exactly as stored: undo restores, it does not normalize.
  }

  if (r.reviewVisibility !== "private") return bad(`invalid review visibility ${JSON.stringify(r.reviewVisibility)}`);

  let skipUntil: Date | null = null;
  if (status === "skipped") {
    skipUntil = toDate(r.skipUntil);
    if (!skipUntil) return bad("a skipped state needs a valid skipUntil");
  } else if (r.skipUntil !== null && r.skipUntil !== undefined) {
    return bad("only a skipped state carries skipUntil");
  }

  const createdAt = toDate(r.createdAt);
  const updatedAt = toDate(r.updatedAt);
  if (!createdAt || !updatedAt) return bad("state needs valid createdAt and updatedAt");

  return ok({
    mediaType: ref.mediaType,
    tmdbId: ref.tmdbId,
    status,
    rating,
    review,
    reviewVisibility: "private",
    skipUntil,
    createdAt,
    updatedAt,
  });
}
