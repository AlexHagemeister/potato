import { describe, expect, test } from "bun:test";
import { SKIP_DAYS } from "../deck/constants";
import {
  ALLOWED_MOVES,
  cardGuardFor,
  columnsFor,
  isAllowedMove,
  isChangedElsewhere,
  planMove,
  planRatingReviewPatch,
  planShownRatingReview,
  REPLACEABLE,
  seenRefused,
} from "./transitions";
import type { MoveRequest } from "./types";

const now = new Date("2026-11-06T12:00:00.000Z");

describe("columnsFor: every card action sets all four status columns", () => {
  test("watchlist and passed clear rating, review, and skipUntil", () => {
    for (const status of ["watchlist", "passed"] as const) {
      expect(columnsFor({ status }, now)).toEqual({ ok: true, value: { status, rating: null, review: null, skipUntil: null } });
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
      value: { status: "seen", rating: 4, review: "Good.", skipUntil: null },
    });
  });

  test("seen with the review left out, null, or blank writes no review", () => {
    for (const review of [undefined, null, "", "  "]) {
      expect(columnsFor({ status: "seen", rating: 0.5, review }, now)).toEqual({
        ok: true,
        value: { status: "seen", rating: 0.5, review: null, skipUntil: null },
      });
    }
  });

  test("seen needs a valid rating", () => {
    for (const rating of [undefined, 0, 10.5, 3.3, "4"]) {
      expect(columnsFor({ status: "seen", rating }, now)).toMatchObject({ ok: false, error: { code: "invalid_rating" } });
    }
  });

  test("seen rejects a bad review", () => {
    expect(columnsFor({ status: "seen", rating: 3, review: 42 }, now)).toMatchObject({ ok: false, error: { code: "invalid_review" } });
  });
});

describe("REPLACEABLE: which row a card button or removeTitle may replace (issues 43, 65, and 74)", () => {
  test("every status but Seen, so no button ever replaces a Seen row", () => {
    expect([...REPLACEABLE].sort()).toEqual(["passed", "skipped", "watchlist"]);
    expect(REPLACEABLE).not.toContain("seen");
  });

  test("the refusal says the title is Seen and lists what would have worked", () => {
    expect(seenRefused()).toEqual({ code: "wrong_state", status: "seen", expected: [...REPLACEABLE] });
    // A copy: changing the error can't change the rule.
    const refused = seenRefused();
    expect(refused.code === "wrong_state" && refused.expected).not.toBe(REPLACEABLE);
  });
});

describe("cardGuardFor: a Discover card's tap never moves a title already on a list (issue 83)", () => {
  const sorts = [{ status: "passed" }, { status: "skipped" }, { status: "watchlist" }] as const;

  test("Pass, Skip, and Watchlist on a card shown on no list take the deck's rule", () => {
    for (const intent of sorts) expect(cardGuardFor(intent, true)).toBe("on_no_list");
  });

  test("left out, or anything but strictly true, keeps REPLACEABLE (the title card and the AI connection)", () => {
    for (const intent of sorts) {
      for (const shown of [undefined, false, null, "true", 1, {}]) expect(cardGuardFor(intent, shown)).toBe("replaceable");
    }
  });

  test("Seen it always keeps REPLACEABLE, so a stale card's rating still moves a title off another list", () => {
    for (const shown of [undefined, false, true]) {
      expect(cardGuardFor({ status: "seen", rating: 4 }, shown)).toBe("replaceable");
    }
  });
});

describe("planShownRatingReview: what an edit or a removal says the user was shown (issues 43 and 103)", () => {
  test("keeps a valid rating and review as they are", () => {
    expect(planShownRatingReview({ rating: 4.5, review: "Loved it." })).toEqual({ ok: true, value: { rating: 4.5, review: "Loved it." } });
  });

  test("a review left out or null means none was shown", () => {
    for (const shown of [{ rating: 3 }, { rating: 3, review: null }]) {
      expect(planShownRatingReview(shown)).toEqual({ ok: true, value: { rating: 3, review: null } });
    }
  });

  test("keeps a shown review exactly, blank or long, so it compares with the stored row as it is", () => {
    for (const review of ["", "   ", " Padded. ", "x".repeat(20_000)]) {
      expect(planShownRatingReview({ rating: 3, review })).toEqual({ ok: true, value: { rating: 3, review } });
    }
  });

  test("rejects a review with a NUL character, which no stored review can hold", () => {
    expect(planShownRatingReview({ rating: 3, review: "a\u0000b" })).toMatchObject({ ok: false, error: { code: "invalid_review" } });
  });

  test("needs the rating that was shown: a Seen title always has one", () => {
    for (const shown of [{}, { review: "Text." }, { rating: 0 }, { rating: 4.2 }, { rating: "4" }, null, undefined, "x", 4]) {
      expect(planShownRatingReview(shown)).toMatchObject({ ok: false, error: { code: "invalid_rating" } });
    }
  });

  test("rejects a review that is not text", () => {
    expect(planShownRatingReview({ rating: 2, review: 42 })).toMatchObject({ ok: false, error: { code: "invalid_review" } });
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
      value: { from: "watchlist", columns: { status: "seen", rating: 5, review: "Loved it.", skipUntil: null } },
    });
    expect(planMove({ from: "watchlist", to: "seen" } as unknown as MoveRequest)).toMatchObject({
      ok: false,
      error: { code: "invalid_rating" },
    });
  });

  test("Passed to Watchlist clears everything else", () => {
    expect(planMove({ from: "passed", to: "watchlist" })).toEqual({
      ok: true,
      value: { from: "passed", columns: { status: "watchlist", rating: null, review: null, skipUntil: null } },
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
    expect(planRatingReviewPatch({ rating: 10.5 })).toMatchObject({ ok: false, error: { code: "invalid_rating" } });
    expect(planRatingReviewPatch({ rating: 10 })).toEqual({ ok: true, value: { rating: 10 } });
  });
});

describe("isChangedElsewhere: which refusals mean the title changed since the caller read it", () => {
  test("wrong_state, not_found, and stale_value do", () => {
    expect(isChangedElsewhere({ code: "wrong_state", status: "watchlist", expected: ["seen"] })).toBe(true);
    expect(isChangedElsewhere(seenRefused())).toBe(true);
    expect(isChangedElsewhere({ code: "not_found" })).toBe(true);
    expect(isChangedElsewhere({ code: "stale_value", status: "seen" })).toBe(true);
  });

  test("bad input and an unknown user do not", () => {
    for (const error of [
      { code: "invalid_user" },
      { code: "unknown_user" },
      { code: "invalid_rating", rating: 10.5 },
      { code: "invalid_review", message: "too long" },
      { code: "invalid_title", message: "bad id" },
      { code: "invalid_move", message: "no" },
      { code: "empty_patch" },
      { code: "invalid_snapshot", message: "bad" },
    ] as const) {
      expect(isChangedElsewhere(error)).toBe(false);
    }
  });
});
