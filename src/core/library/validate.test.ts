import { describe, expect, test } from "bun:test";
import { REVIEW_MAX_LENGTH, type TitleRecord } from "./types";
import { isValidRating, parseTitleRecord, validateRating, validateReview, validateTitleRef, validateUserId } from "./validate";

describe("rating bounds: 0.5 to 5 in half steps", () => {
  test("accepts every half step from 0.5 to 5", () => {
    for (let r = 0.5; r <= 5; r += 0.5) expect(isValidRating(r)).toBe(true);
  });

  test.each([0, 0.25, 0.75, 4.9, 5.5, -1, 10, Number.NaN, Infinity, -Infinity])("rejects %p", (r) => {
    expect(isValidRating(r)).toBe(false);
    expect(validateRating(r)).toEqual({ ok: false, error: { code: "invalid_rating", rating: r } });
  });

  test.each(["4", null, undefined, {}, [[4]], true])("rejects non-number %p", (r) => {
    expect(validateRating(r).ok).toBe(false);
  });

  test("returns the rating when valid", () => {
    expect(validateRating(3.5)).toEqual({ ok: true, value: 3.5 });
  });
});

describe("validateReview", () => {
  test("absent, null, empty, and whitespace-only mean no review", () => {
    for (const r of [undefined, null, "", "   ", "\n\t "]) expect(validateReview(r)).toEqual({ ok: true, value: null });
  });

  test("keeps text exactly as written, surrounding whitespace included", () => {
    expect(validateReview("  Great.  ")).toEqual({ ok: true, value: "  Great.  " });
  });

  test("accepts exactly the max length, rejects one more", () => {
    expect(validateReview("a".repeat(REVIEW_MAX_LENGTH)).ok).toBe(true);
    expect(validateReview("a".repeat(REVIEW_MAX_LENGTH + 1))).toMatchObject({ ok: false, error: { code: "invalid_review" } });
  });

  test("rejects a non-string", () => {
    expect(validateReview(5)).toMatchObject({ ok: false, error: { code: "invalid_review" } });
  });
});

describe("validateUserId and validateTitleRef", () => {
  test("user id must be a non-empty string", () => {
    expect(validateUserId("u1").ok).toBe(true);
    for (const u of ["", null, undefined, 5]) expect(validateUserId(u)).toEqual({ ok: false, error: { code: "invalid_user" } });
  });

  test("accepts movie and tv with a positive integer ID, and strips extra fields", () => {
    expect(validateTitleRef({ mediaType: "tv", tmdbId: 1399, extra: "x" })).toEqual({ ok: true, value: { mediaType: "tv", tmdbId: 1399 } });
  });

  test.each([
    null,
    "movie:603",
    { mediaType: "film", tmdbId: 603 },
    { mediaType: "movie", tmdbId: 0 },
    { mediaType: "movie", tmdbId: -1 },
    { mediaType: "movie", tmdbId: 1.5 },
    { mediaType: "movie", tmdbId: "603" },
    { mediaType: "movie", tmdbId: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects %p", (ref) => {
    expect(validateTitleRef(ref)).toMatchObject({ ok: false, error: { code: "invalid_title" } });
  });
});

describe("parseTitleRecord (undo input)", () => {
  const ref = { mediaType: "movie", tmdbId: 603 } as const;
  const seen: TitleRecord = {
    ...ref,
    status: "seen",
    rating: 4.5,
    review: "Whoa.",
    reviewVisibility: "private",
    skipUntil: null,
    createdAt: new Date("2026-01-01T00:00:00.123Z"),
    updatedAt: new Date("2026-01-02T00:00:00.456Z"),
  };

  test("round-trips a record through JSON to the same values", () => {
    const parsed = parseTitleRecord(JSON.parse(JSON.stringify(seen)), ref);
    expect(parsed).toEqual({ ok: true, value: seen });
  });

  test("accepts a skipped state with an ISO skipUntil", () => {
    const skipped = { ...seen, status: "skipped", rating: null, review: null, skipUntil: "2026-01-15T00:00:00.000Z" };
    const parsed = parseTitleRecord(skipped, ref);
    expect(parsed.ok && parsed.value.skipUntil?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  test("ignores a user id inside the state", () => {
    const parsed = parseTitleRecord({ ...seen, userId: "someone-else" }, ref);
    expect(parsed.ok && "userId" in parsed.value).toBe(false);
  });

  test.each<[string, Record<string, unknown>]>([
    ["another title", { tmdbId: 604 }],
    ["another media type", { mediaType: "tv" }],
    ["an unknown status", { status: "deleted" }],
    ["a seen state with no rating", { rating: null }],
    ["a seen state with an off-scale rating", { rating: 5.5 }],
    ["a rating on a watchlist state", { status: "watchlist", review: null }],
    ["a review on a passed state", { status: "passed", rating: null }],
    ["a skipped state with no skipUntil", { status: "skipped", rating: null, review: null, skipUntil: null }],
    ["skipUntil on a seen state", { skipUntil: "2026-01-15T00:00:00.000Z" }],
    ["a bad date", { createdAt: "not a date" }],
    ["a public visibility", { reviewVisibility: "public" }],
  ])("rejects %s", (_name, change) => {
    expect(parseTitleRecord({ ...seen, ...change }, ref)).toMatchObject({ ok: false, error: { code: "invalid_snapshot" } });
  });

  test("rejects a non-object", () => {
    expect(parseTitleRecord("seen", ref).ok).toBe(false);
  });
});
