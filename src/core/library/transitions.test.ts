import { describe, expect, test } from "bun:test";
import { SKIP_DAYS } from "../deck/constants";
import { ALLOWED_MOVES, columnsFor, isAllowedMove, planMove, planRatingReviewPatch } from "./transitions";
import type { MoveRequest } from "./types";

const now = new Date("2026-11-06T12:00:00.000Z");

describe("columnsFor: every card action sets all four status columns", () => {
  test("watchlist and passed clear rating, review, and skipUntil", () => {
    for (const status of ["watchlist", "passed"] as const) {
      expect(columnsFor({ status }, now)).toEqual({ ok: true, value: { status, rating: null, review: null, keepReview: false, skipUntil: null } });
    }
  });

  test("skipped returns after exactly SKIP_DAYS days and clears rating and review", () => {
    const result = columnsFor({ status: "skipped" }, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rating).toBeNull();
    expect(result.value.review).toBeNull();
    expect(result.value.skipUntil!.getTime() - now.getTime()).toBe(SKIP_DAYS * 24 * 60 * 60 * 1000);
  });

  test("seen carries the rating and review and clears skipUntil", () => {
    expect(columnsFor({ status: "seen", rating: 4, review: "Good." }, now)).toEqual({
      ok: true,
      value: { status: "seen", rating: 4, review: "Good.", keepReview: false, skipUntil: null },
    });
  });

  test("seen with the review left out keeps the existing review; null or blank clears it", () => {
    expect(columnsFor({ status: "seen", rating: 0.5 }, now)).toMatchObject({ ok: true, value: { review: null, keepReview: true } });
    for (const review of [null, "", "  "]) {
      expect(columnsFor({ status: "seen", rating: 0.5, review }, now)).toMatchObject({
        ok: true,
        value: { review: null, keepReview: false },
      });
    }
  });

  test("the skipped column set never keeps a review", () => {
    expect(columnsFor({ status: "skipped" }, now)).toMatchObject({ ok: true, value: { keepReview: false } });
  });

  test("seen needs a valid rating", () => {
    for (const rating of [undefined, 0, 5.5, 3.3, "4"]) {
      expect(columnsFor({ status: "seen", rating }, now)).toMatchObject({ ok: false, error: { code: "invalid_rating" } });
    }
  });

  test("seen rejects a bad review", () => {
    expect(columnsFor({ status: "seen", rating: 3, review: 42 }, now)).toMatchObject({ ok: false, error: { code: "invalid_review" } });
  });
});

describe("list moves", () => {
  test("the allowed moves are exactly Watchlist to Seen and Passed to Watchlist", () => {
    expect(ALLOWED_MOVES).toEqual([
      { from: "watchlist", to: "seen" },
      { from: "passed", to: "watchlist" },
    ]);
  });

  test("every other pair of statuses is refused", () => {
    const statuses = ["watchlist", "passed", "seen", "skipped"];
    for (const from of statuses) {
      for (const to of statuses) {
        const allowed = (from === "watchlist" && to === "seen") || (from === "passed" && to === "watchlist");
        expect(isAllowedMove(from, to)).toBe(allowed);
      }
    }
  });

  test("Watchlist to Seen needs a rating and keeps the review", () => {
    expect(planMove({ from: "watchlist", to: "seen", rating: 5, review: "Loved it." })).toEqual({
      ok: true,
      value: { from: "watchlist", columns: { status: "seen", rating: 5, review: "Loved it.", keepReview: false, skipUntil: null } },
    });
    expect(planMove({ from: "watchlist", to: "seen" } as unknown as MoveRequest)).toMatchObject({
      ok: false,
      error: { code: "invalid_rating" },
    });
  });

  test("Passed to Watchlist clears everything else", () => {
    expect(planMove({ from: "passed", to: "watchlist" })).toEqual({
      ok: true,
      value: { from: "passed", columns: { status: "watchlist", rating: null, review: null, keepReview: false, skipUntil: null } },
    });
  });

  test("refuses unknown moves and junk input", () => {
    for (const move of [{ from: "seen", to: "watchlist" }, { from: "watchlist", to: "skipped" }, null, "x"]) {
      expect(planMove(move as unknown as MoveRequest)).toMatchObject({ ok: false, error: { code: "invalid_move" } });
    }
  });
});

describe("planRatingReviewPatch", () => {
  test("sets only the fields named", () => {
    expect(planRatingReviewPatch({ rating: 2.5 })).toEqual({ ok: true, value: { rating: 2.5 } });
    expect(planRatingReviewPatch({ review: "New." })).toEqual({ ok: true, value: { review: "New." } });
    expect(planRatingReviewPatch({ rating: 1, review: "Both." })).toEqual({ ok: true, value: { rating: 1, review: "Both." } });
  });

  test("a null or blank review clears it, which is different from leaving it out", () => {
    expect(planRatingReviewPatch({ review: null })).toEqual({ ok: true, value: { review: null } });
    expect(planRatingReviewPatch({ review: "  " })).toEqual({ ok: true, value: { review: null } });
  });

  test("an empty patch is an error", () => {
    for (const patch of [{}, { rating: undefined }, null]) {
      expect(planRatingReviewPatch(patch)).toEqual({ ok: false, error: { code: "empty_patch" } });
    }
  });

  test("validates the rating", () => {
    expect(planRatingReviewPatch({ rating: 0 })).toMatchObject({ ok: false, error: { code: "invalid_rating" } });
  });
});
