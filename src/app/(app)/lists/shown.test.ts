import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER_CHOICE, type FilterChoice } from "@/core/filters";
import type { TitleRecord } from "@/core/library/types";
import type { ListRow } from "@/core/lists";
import type { ListStatus, TitleStatus } from "@/core/types";
import { applyTitleChange, getShown, seedShown, setShown, type Lists } from "./shown";

// The module keeps its rows for the life of the page, so each test starts them over as its own user.
let users = 0;
const newUser = () => `user-${++users}`;

const NONE: FilterChoice = { ...DEFAULT_FILTER_CHOICE, genres: [] };
const SERIES: FilterChoice = { ...NONE, type: "tv" };

const FIGHT_CLUB = { mediaType: "movie", tmdbId: 550 } as const;
const OTHER_MOVIE = { mediaType: "movie", tmdbId: 13 } as const;
const A_SERIES = { mediaType: "tv", tmdbId: 1399 } as const;

const at = (day: number) => new Date(Date.UTC(2026, 10, day));
const NOW = new Date("2026-11-25T10:00:00Z");

function row(ref: { mediaType: "movie" | "tv"; tmdbId: number }, status: ListStatus, day: number): ListRow {
  return {
    ...ref,
    status,
    rating: status === "seen" ? 8 : null,
    review: null,
    updatedAt: at(day),
    title: `Title ${ref.tmdbId}`,
    year: 1999,
    posterUrl: `https://img/${ref.tmdbId}.jpg`,
  };
}

function record(
  ref: { mediaType: "movie" | "tv"; tmdbId: number },
  status: TitleStatus,
  updatedAt: Date = NOW,
): TitleRecord {
  return {
    ...ref,
    status,
    rating: status === "seen" ? 8 : null,
    review: null,
    reviewVisibility: "private",
    skipUntil: status === "skipped" ? NOW : null,
    createdAt: at(1),
    updatedAt,
  };
}

const empty = () => ({ rows: [], nextCursor: null });
const keys = (lists: Lists, status: ListStatus) => lists[status].rows.map((r) => `${r.mediaType}:${r.tmdbId}`);
const shownLists = () => getShown()!.lists;

/** No filters: Fight Club on Passed, another movie on the Watchlist. */
function seedNoFilters(userId: string) {
  seedShown(`render-${userId}`, {
    userId,
    filters: NONE,
    lists: {
      watchlist: { rows: [row(OTHER_MOVIE, "watchlist", 10)], nextCursor: null },
      seen: empty(),
      passed: { rows: [row(FIGHT_CLUB, "passed", 5)], nextCursor: null },
    },
  });
}

describe("a row a card dropped (issue 121)", () => {
  test("comes back on Undo under the filters it was dropped under", () => {
    const userId = newUser();
    seedNoFilters(userId);
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "skipped"))).toBe(true);
    expect(keys(shownLists(), "passed")).toEqual([]);

    // The card's Undo restores the Passed row as it was.
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "passed", at(5)))).toBe(true);
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(shownLists().passed.rows[0].title).toBe("Title 550");
  });

  test("does not come back under filters that exclude it: the issue's walk", () => {
    const userId = newUser();
    seedNoFilters(userId);
    // Passed > Fight Club's card > Skip.
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "skipped"))).toBe(true);
    // Back > Filters, Type: Series > Done. The filter load replaces the rows.
    setShown({
      userId,
      filters: SERIES,
      lists: { watchlist: { rows: [row(A_SERIES, "watchlist", 9)], nextCursor: null }, seen: empty(), passed: empty() },
    });
    // Search > Fight Club's card > Watchlist. The kept rows can't take it, so the card reads the server instead.
    const before = shownLists();
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "watchlist"))).toBe(false);
    expect(shownLists()).toBe(before);
    expect(keys(shownLists(), "watchlist")).toEqual(["tv:1399"]);
  });

  test("comes back once the kept rows have its filters again", () => {
    const userId = newUser();
    seedNoFilters(userId);
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "skipped"))).toBe(true);
    setShown({ userId, filters: SERIES, lists: { watchlist: empty(), seen: empty(), passed: empty() } });
    // Clear filters: a fresh load with no filters, without Fight Club (it is skipped on the server).
    setShown({
      userId,
      filters: NONE,
      lists: { watchlist: { rows: [row(OTHER_MOVIE, "watchlist", 10)], nextCursor: null }, seen: empty(), passed: empty() },
    });
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "watchlist"))).toBe(true);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:550", "movie:13"]);
  });

  test("a title the rows show still moves under a filter", () => {
    const userId = newUser();
    seedShown(`render-${userId}`, {
      userId,
      filters: SERIES,
      lists: { watchlist: empty(), seen: empty(), passed: { rows: [row(A_SERIES, "passed", 5)], nextCursor: null } },
    });
    expect(applyTitleChange(A_SERIES, record(A_SERIES, "watchlist"))).toBe(true);
    expect(keys(shownLists(), "watchlist")).toEqual(["tv:1399"]);
    expect(keys(shownLists(), "passed")).toEqual([]);
  });

  test("dropped under one filter, it comes back under the same filter", () => {
    const userId = newUser();
    seedShown(`render-${userId}`, {
      userId,
      filters: SERIES,
      lists: { watchlist: empty(), seen: empty(), passed: { rows: [row(A_SERIES, "passed", 5)], nextCursor: null } },
    });
    expect(applyTitleChange(A_SERIES, record(A_SERIES, "skipped"))).toBe(true);
    expect(applyTitleChange(A_SERIES, record(A_SERIES, "passed", at(5)))).toBe(true);
    expect(keys(shownLists(), "passed")).toEqual(["tv:1399"]);
  });
});
