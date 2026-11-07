import { describe, expect, test } from "bun:test";
import { cardUserState } from "./user-state";

const REF = { mediaType: "movie", tmdbId: 603 } as const;
const NOW = new Date("2026-11-07T12:00:00Z");

describe("cardUserState", () => {
  test("no row is no state", () => {
    expect(cardUserState(REF, null, NOW)).toBeNull();
  });

  test("a list row passes through", () => {
    expect(cardUserState(REF, { status: "seen", rating: 4, review: "Good.", skipUntil: null }, NOW)).toEqual({
      status: "seen",
      rating: 4,
      review: "Good.",
      skipUntil: null,
    });
  });

  test("a skip that has run out is no state, a live one is skipped, with the time as a Date", () => {
    expect(cardUserState(REF, { status: "skipped", rating: null, review: null, skipUntil: new Date("2026-11-07T11:59:59Z") }, NOW)).toBeNull();
    expect(cardUserState(REF, { status: "skipped", rating: null, review: null, skipUntil: "2026-11-07T11:59:59.000Z" }, NOW)).toBeNull();
    expect(cardUserState(REF, { status: "skipped", rating: null, review: null, skipUntil: "2026-11-22T12:00:00.000Z" }, NOW)).toEqual({
      status: "skipped",
      rating: null,
      review: null,
      skipUntil: new Date("2026-11-22T12:00:00Z"),
    });
  });

  test("a skip whose return time names no moment stays skipped, as it stays hidden in the deck", () => {
    expect(cardUserState(REF, { status: "skipped", rating: null, review: null, skipUntil: "2026-11-01T12:00:00" }, NOW)?.status).toBe("skipped");
    expect(cardUserState(REF, { status: "skipped", rating: null, review: null, skipUntil: null }, NOW)?.status).toBe("skipped");
    // An unparseable time is skipped with no date ("Skipped for now"), never an Invalid Date.
    expect(cardUserState(REF, { status: "skipped", rating: null, review: null, skipUntil: "" }, NOW)).toEqual({
      status: "skipped",
      rating: null,
      review: null,
      skipUntil: null,
    });
  });
});
