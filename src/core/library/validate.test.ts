import { describe, expect, test } from "bun:test";
import { RATING_MAX, RATING_MIN, REVIEW_MAX_LENGTH, type TitleRecord } from "./types";
import { validateUserId } from "../result";
import { rowVisible } from "../deck/build-deck";
import { SKIP_DAYS } from "../deck/constants";
import {
  isValidRating,
  parseTitleRecord,
  UNDO_CLOCK_ALLOWANCE_MS,
  UNDO_DATE_FLOOR,
  UNDO_SKIP_ALLOWANCE_MS,
  validateRating,
  validateReview,
  validateTitleRef,
} from "./validate";

describe("rating bounds: 0.5 to 10 in half steps", () => {
  test("accepts every half step from 0.5 to 10", () => {
    const steps = Array.from({ length: 20 }, (_, i) => (i + 1) / 2);
    expect(steps[0]).toBe(0.5);
    expect(steps.at(-1)).toBe(10);
    for (const r of steps) expect(isValidRating(r)).toBe(true);
  });

  test("the ends of the scale are 0.5 and 10", () => {
    expect(RATING_MIN).toBe(0.5);
    expect(RATING_MAX).toBe(10);
    expect(isValidRating(0.5)).toBe(true);
    expect(isValidRating(10)).toBe(true);
    expect(isValidRating(10.5)).toBe(false);
    expect(isValidRating(0)).toBe(false);
  });

  test.each([0, 0.25, 0.75, 4.9, 7.25, 9.9, 9.75, 10.5, 11, 20, -1, -0.5, Number.NaN, Infinity, -Infinity])("rejects %p", (r) => {
    expect(isValidRating(r)).toBe(false);
    expect(validateRating(r)).toEqual({ ok: false, error: { code: "invalid_rating", rating: r } });
  });

  test.each(["4", null, undefined, {}, [[4]], true])("rejects non-number %p", (r) => {
    expect(validateRating(r).ok).toBe(false);
  });

  test("returns the rating when valid", () => {
    expect(validateRating(3.5)).toEqual({ ok: true, value: 3.5 });
    expect(validateRating(10)).toEqual({ ok: true, value: 10 });
    expect(validateRating(7.5)).toEqual({ ok: true, value: 7.5 });
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

  test("rejects a NUL character, which Postgres text cannot store", () => {
    expect(validateReview("bad\u0000byte")).toMatchObject({ ok: false, error: { code: "invalid_review" } });
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
    { mediaType: "movie", tmdbId: 2_147_483_648 },
    { mediaType: "tv", tmdbId: 3_000_000_000 },
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
  /** The server's clock when the undo arrives. */
  const now = new Date("2026-01-03T00:00:00.000Z");
  const DAY_MS = 86_400_000;
  /** A moment `ms` after `now`, as JSON carries it. */
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const skipped = { ...seen, status: "skipped", rating: null, review: null };

  test("round-trips a record through JSON to the same values", () => {
    const parsed = parseTitleRecord(JSON.parse(JSON.stringify(seen)), ref, now);
    expect(parsed).toEqual({ ok: true, value: seen });
  });

  test("takes a record with Date objects, as a server action carries it, to the same values", () => {
    expect(parseTitleRecord(seen, ref, now)).toEqual({ ok: true, value: seen });
  });

  test("accepts a skipped state with an ISO skipUntil", () => {
    const parsed = parseTitleRecord({ ...skipped, skipUntil: "2026-01-15T00:00:00.000Z" }, ref, now);
    expect(parsed.ok && parsed.value.skipUntil?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  test("ignores a user id inside the state", () => {
    const parsed = parseTitleRecord({ ...seen, userId: "someone-else" }, ref, now);
    expect(parsed.ok && "userId" in parsed.value).toBe(false);
  });

  test.each<[string, Record<string, unknown>]>([
    ["another title", { tmdbId: 604 }],
    ["another media type", { mediaType: "tv" }],
    ["an unknown status", { status: "deleted" }],
    ["a seen state with no rating", { rating: null }],
    ["a seen state with an off-scale rating", { rating: 10.5 }],
    ["a seen state with a rating off the half steps", { rating: 7.25 }],
    ["a rating on a watchlist state", { status: "watchlist", review: null }],
    ["a review on a passed state", { status: "passed", rating: null }],
    ["a skipped state with no skipUntil", { status: "skipped", rating: null, review: null, skipUntil: null }],
    ["skipUntil on a seen state", { skipUntil: "2026-01-15T00:00:00.000Z" }],
    ["a bad date", { createdAt: "not a date" }],
    ["a public visibility", { reviewVisibility: "public" }],
    // Issue 27: a string with no offset parses in the host's time zone, so it names no one moment.
    ["a createdAt with no offset", { createdAt: "2026-01-01T00:00:00.123" }],
    ["an updatedAt with no offset", { updatedAt: "2026-01-02T00:00:00.456" }],
    ["a date with no time", { createdAt: "2026-01-01" }],
    ["a date with a space for the T", { createdAt: "2026-01-01 00:00:00.123Z" }],
    ["a date in another format", { createdAt: "Thu, 01 Jan 2026 00:00:00 GMT" }],
    ["a date as a number", { createdAt: Date.UTC(2026, 0, 1) }],
    ["a month that does not exist", { createdAt: "2026-13-01T00:00:00.000Z" }],
    ["an invalid Date", { updatedAt: new Date(Number.NaN) }],
    // Issue 22: dates no action could have returned.
    ["a createdAt before the floor", { createdAt: new Date(UNDO_DATE_FLOOR.getTime() - 1) }],
    ["an updatedAt before the floor", { updatedAt: "2025-12-31T23:59:59.999Z" }],
    ["a createdAt past the clock allowance", { createdAt: at(UNDO_CLOCK_ALLOWANCE_MS + 1) }],
    ["an updatedAt past the clock allowance", { updatedAt: new Date(now.getTime() + UNDO_CLOCK_ALLOWANCE_MS + 1) }],
    ["a createdAt in the year 3000", { createdAt: "3000-01-01T00:00:00.000Z" }],
    ["the latest Date JavaScript holds", { updatedAt: new Date(8.64e15) }],
    ["the earliest Date JavaScript holds", { createdAt: new Date(-8.64e15) }],
    ["a year written with six digits", { createdAt: "+010000-01-01T00:00:00.000Z" }],
  ])("rejects %s", (_name, change) => {
    expect(parseTitleRecord({ ...seen, ...change }, ref, now)).toMatchObject({ ok: false, error: { code: "invalid_snapshot" } });
  });

  test("rejects a non-object", () => {
    expect(parseTitleRecord("seen", ref, now).ok).toBe(false);
  });

  test.each<[string, unknown]>([
    ["no offset", "2026-01-15T00:00:00.000"],
    ["a date before the floor", new Date(UNDO_DATE_FLOOR.getTime() - 1)],
    ["a date past the skip allowance", at(UNDO_SKIP_ALLOWANCE_MS + 1)],
    ["the year 9999", "9999-12-31T23:59:59.999Z"],
  ])("rejects a skipUntil with %s", (_name, skipUntil) => {
    expect(parseTitleRecord({ ...skipped, skipUntil }, ref, now)).toMatchObject({ ok: false, error: { code: "invalid_snapshot" } });
  });

  test.each<[string, unknown, string]>([
    ["a Date object", new Date("2026-01-01T00:00:00.123Z"), "2026-01-01T00:00:00.123Z"],
    ["a toISOString string", "2026-01-01T00:00:00.123Z", "2026-01-01T00:00:00.123Z"],
    ["a +00:00 offset, as Postgres writes it", "2026-01-01T00:00:00.123+00:00", "2026-01-01T00:00:00.123Z"],
    ["another offset, read as the same moment", "2026-01-01T05:30:00.123+05:30", "2026-01-01T00:00:00.123Z"],
    ["microseconds, cut to the millisecond", "2026-01-01T00:00:00.123456+00:00", "2026-01-01T00:00:00.123Z"],
    ["no seconds", "2026-01-01T00:00Z", "2026-01-01T00:00:00.000Z"],
    ["exactly the floor", UNDO_DATE_FLOOR.toISOString(), UNDO_DATE_FLOOR.toISOString()],
    ["exactly the clock allowance", at(UNDO_CLOCK_ALLOWANCE_MS), at(UNDO_CLOCK_ALLOWANCE_MS)],
    ["a few seconds ahead, from a server whose clock runs fast", at(5_000), at(5_000)],
  ])("accepts a createdAt as %s", (_name, createdAt, expected) => {
    const parsed = parseTitleRecord({ ...seen, createdAt }, ref, now);
    expect(parsed.ok && parsed.value.createdAt.toISOString()).toBe(expected);
  });

  test.each<[string, unknown, string]>([
    ["SKIP_DAYS ahead of the clock", at(SKIP_DAYS * DAY_MS), at(SKIP_DAYS * DAY_MS)],
    ["exactly the skip allowance", at(UNDO_SKIP_ALLOWANCE_MS), at(UNDO_SKIP_ALLOWANCE_MS)],
    ["long past (a Skip that came back)", UNDO_DATE_FLOOR, UNDO_DATE_FLOOR.toISOString()],
    ["with a +00:00 offset", "2026-01-15T00:00:00+00:00", "2026-01-15T00:00:00.000Z"],
  ])("accepts a skipUntil %s", (_name, skipUntil, expected) => {
    const parsed = parseTitleRecord({ ...skipped, skipUntil }, ref, now);
    expect(parsed.ok && parsed.value.skipUntil?.toISOString()).toBe(expected);
  });

  test("the skip allowance covers a Skip made now, with room to retune SKIP_DAYS", () => {
    expect(SKIP_DAYS * DAY_MS * 2).toBeLessThan(UNDO_SKIP_ALLOWANCE_MS);
  });

  test("the offset pattern is the deck engine's: undo accepts a skipUntil exactly when the deck reads it as a time", () => {
    const late = new Date("2026-03-01T00:00:00.000Z");
    for (const text of [
      "2026-01-15T00:00:00.000Z",
      "2026-01-15T00:00:00+00:00",
      "2026-01-15T00:00Z",
      "2026-01-15T00:00:00.000",
      "2026-01-15",
      "2026-01-15 00:00:00Z",
      "January 15, 2026",
    ]) {
      // The deck shows a skipped title after its return time only when it can read that time.
      const deckReadsIt = rowVisible(ref, { status: "skipped", skipUntil: text }, late);
      expect([text, parseTitleRecord({ ...skipped, skipUntil: text }, ref, now).ok]).toEqual([text, deckReadsIt]);
    }
  });
});
