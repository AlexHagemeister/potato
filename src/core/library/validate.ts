// Pure input checks. The database enforces the same rules with CHECK
// constraints. Checking here too turns bad input into a typed error the
// caller can show, instead of a constraint violation.

import { TITLE_STATUSES } from "@/db/schema";
import { fail, ok, type Result } from "../result";
import { titleIdError, type TitleId } from "../title-id";
import type { TitleStatus } from "../types";
import { RATING_MAX, RATING_MIN, REVIEW_MAX_LENGTH, type TitleRecord } from "./types";

/** True for 0.5 to 10 in half steps, the scale title_status_rating_scale_check enforces. */
export function isValidRating(rating: unknown): rating is number {
  return (
    typeof rating === "number" &&
    Number.isFinite(rating) &&
    rating >= RATING_MIN &&
    rating <= RATING_MAX &&
    Number.isInteger(rating * 2)
  );
}

export function validateRating(rating: unknown): Result<number> {
  return isValidRating(rating) ? ok(rating) : fail({ code: "invalid_rating", rating });
}

/** Why review text cannot be stored, or null when it can. */
function reviewTextError(review: string): string | null {
  if (review.length > REVIEW_MAX_LENGTH) return `review is longer than ${REVIEW_MAX_LENGTH} characters`;
  // Postgres text cannot hold a NUL character, so the write would fail.
  if (review.includes("\u0000")) return "review contains a NUL character";
  return null;
}

/**
 * Normalizes a review. Undefined and null mean no review. A review that is
 * empty or only whitespace also becomes null, so a cleared text box never
 * leaves a blank review behind. Any other text is kept exactly as written.
 */
export function validateReview(review: unknown): Result<string | null> {
  if (review === undefined || review === null) return ok(null);
  if (typeof review !== "string") return fail({ code: "invalid_review", message: "review must be a string or null" });
  if (review.trim() === "") return ok(null);
  const error = reviewTextError(review);
  return error ? fail({ code: "invalid_review", message: error }) : ok(review);
}

/** titleIdError's rules (the one statement of them), returned as a typed error instead of thrown. */
export function validateTitleRef(ref: unknown): Result<TitleId> {
  const error = titleIdError(ref);
  if (error) return fail({ code: "invalid_title", message: error });
  const { mediaType, tmdbId } = ref as TitleId;
  // A fresh object, so nothing else the caller passed rides along into SQL.
  return ok({ mediaType, tmdbId });
}

/**
 * An ISO 8601 date-time with an explicit offset ("Z" or "+05:30"), the form
 * toISOString and JSON.stringify write. A string without an offset parses in
 * the host's local time zone, so it names no one moment (issue 27). The deck
 * engine holds the same pattern for skip_until (ISO_WITH_OFFSET in
 * ../deck/build-deck.ts): change both together.
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * No row is older than this: Potato's first commit is from November 2026. An
 * undo state dated earlier was not returned by an action.
 */
export const UNDO_DATE_FLOOR = new Date("2026-01-01T00:00:00.000Z");

/**
 * How far past the server's clock an undo state's createdAt or updatedAt may
 * be. Actions stamp rows from the server's clock, so a returned state is never
 * ahead of it by more than the drift between two servers. A day is far more
 * than that.
 */
export const UNDO_CLOCK_ALLOWANCE_MS = DAY_MS;

/**
 * How far past the server's clock an undo state's skipUntil may be. A Skip
 * sets it SKIP_DAYS ahead (two weeks today). A year leaves room to retune
 * SKIP_DAYS without refusing the undo of a Skip made before the change.
 */
export const UNDO_SKIP_ALLOWANCE_MS = 366 * DAY_MS;

/**
 * A date from an undo state: a Date, or a string with an explicit offset. Null
 * when it is neither, names no real moment, or falls outside `floor` to
 * `ceiling`, so no date an action could not have returned reaches the row.
 */
function toDate(value: unknown, floor: Date, ceiling: Date): Date | null {
  let date: Date;
  if (value instanceof Date) date = new Date(value.getTime());
  else if (typeof value === "string" && ISO_WITH_OFFSET.test(value)) date = new Date(value);
  else return null;
  const time = date.getTime();
  if (Number.isNaN(time) || time < floor.getTime() || time > ceiling.getTime()) return null;
  return date;
}

/**
 * Checks a state handed back for undo. It may have crossed JSON, so dates may
 * be ISO strings, each with an explicit offset as JSON.stringify writes them.
 * It must name the same title as `ref` and satisfy every rule the table's
 * CHECK constraints hold. Fields other than the record's own (a user id, say)
 * are ignored: the caller's user id always wins.
 *
 * Every date must lie between UNDO_DATE_FLOOR and a little past `now`, the
 * server's clock (issue 22): restoreTitleState writes these dates into the
 * row, and an action only ever returns dates its own clock stamped.
 */
export function parseTitleRecord(input: unknown, ref: TitleId, now: Date): Result<TitleRecord> {
  const bad = (message: string) => fail<TitleRecord>({ code: "invalid_snapshot", message });
  if (typeof input !== "object" || input === null) return bad("state must be an object or null");
  const r = input as Record<string, unknown>;

  if (r.mediaType !== ref.mediaType || r.tmdbId !== ref.tmdbId) return bad("state names a different title");
  if (!(TITLE_STATUSES as readonly unknown[]).includes(r.status)) return bad(`invalid status ${JSON.stringify(r.status)}`);
  const status = r.status as TitleStatus;

  let rating: number | null = null;
  if (status === "seen") {
    if (!isValidRating(r.rating)) return bad(`a seen state needs a rating from ${RATING_MIN} to ${RATING_MAX} in half steps`);
    rating = r.rating;
  } else if (r.rating !== null && r.rating !== undefined) {
    return bad("only a seen state carries a rating");
  }

  let review: string | null = null;
  if (r.review !== null && r.review !== undefined) {
    if (status !== "seen") return bad("only a seen state carries a review");
    if (typeof r.review !== "string" || reviewTextError(r.review)) return bad("invalid review");
    review = r.review; // Exactly as stored: undo restores, it does not normalize.
  }

  if (r.reviewVisibility !== "private") return bad(`invalid review visibility ${JSON.stringify(r.reviewVisibility)}`);

  let skipUntil: Date | null = null;
  if (status === "skipped") {
    skipUntil = toDate(r.skipUntil, UNDO_DATE_FLOOR, new Date(now.getTime() + UNDO_SKIP_ALLOWANCE_MS));
    if (!skipUntil) return bad("a skipped state needs a valid skipUntil");
  } else if (r.skipUntil !== null && r.skipUntil !== undefined) {
    return bad("only a skipped state carries skipUntil");
  }

  const stampCeiling = new Date(now.getTime() + UNDO_CLOCK_ALLOWANCE_MS);
  const createdAt = toDate(r.createdAt, UNDO_DATE_FLOOR, stampCeiling);
  const updatedAt = toDate(r.updatedAt, UNDO_DATE_FLOOR, stampCeiling);
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
