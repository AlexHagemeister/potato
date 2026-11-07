import { describe, expect, test } from "bun:test";
import type { Candidate } from "../types";
import { applyListFilters, decodeCursor, encodeCursor, filtersNeedDetails, pageRows, parseListQuery, withDetails } from "./list";
import { MAX_LIST_LIMIT, type TitleRecord } from "./types";

function rec(tmdbId: number, over: Partial<TitleRecord> = {}): TitleRecord {
  return {
    mediaType: "movie",
    tmdbId,
    status: "watchlist",
    rating: null,
    review: null,
    reviewVisibility: "private",
    skipUntil: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, tmdbId)),
    updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, tmdbId)),
    ...over,
  };
}

function cand(tmdbId: number, over: Partial<Candidate> = {}): Candidate {
  return {
    mediaType: "movie",
    tmdbId,
    title: `T${tmdbId}`,
    year: 2020,
    genreIds: [],
    popularity: 1,
    tmdbVoteAverage: 7,
    tmdbVoteCount: 100,
    ...over,
  };
}

const ids = (rows: readonly TitleRecord[]) => rows.map((r) => `${r.mediaType}:${r.tmdbId}`);

describe("parseListQuery", () => {
  test("defaults: newest change first, 50 per page", () => {
    expect(parseListQuery("watchlist")).toEqual({
      ok: true,
      value: { status: "watchlist", filters: {}, sort: "updated_desc", cursor: null, limit: 50 },
    });
  });

  test("skipped is not a list", () => {
    expect(parseListQuery("skipped")).toMatchObject({ ok: false, error: { code: "invalid_list_query" } });
  });

  test("rating sorts only on the seen list", () => {
    expect(parseListQuery("seen", { sort: "rating_desc" }).ok).toBe(true);
    expect(parseListQuery("watchlist", { sort: "rating_desc" }).ok).toBe(false);
  });

  test.each([0, -1, 1.5, MAX_LIST_LIMIT + 1])("rejects limit %p", (limit) => {
    expect(parseListQuery("seen", { limit }).ok).toBe(false);
  });

  test("rejects an unknown sort, a junk cursor, and a cursor from another sort", () => {
    expect(parseListQuery("seen", { sort: "title" as never }).ok).toBe(false);
    expect(parseListQuery("seen", { cursor: "junk" }).ok).toBe(false);
    const cursor = encodeCursor({ sort: "created_desc", values: [1, "movie", 1] });
    expect(parseListQuery("seen", { sort: "updated_desc", cursor }).ok).toBe(false);
    expect(parseListQuery("seen", { sort: "created_desc", cursor }).ok).toBe(true);
  });

  test("null options mean the defaults", () => {
    expect(parseListQuery("watchlist", null).ok).toBe(true);
  });

  test.each([
    "x",
    5,
    { filters: "x" },
    { filters: { mediaTypes: "movie" } },
    { filters: { mediaTypes: ["film"] } },
    { filters: { genreIds: ["18"] } },
    { filters: { genreIds: [0] } },
    { filters: { era: 2020 } },
    { filters: { era: { fromYear: "2020" } } },
    { filters: { era: { toYear: 1.5 } } },
    { filters: { onMyServices: "yes" } },
    { filters: { minImdbRating: "7.5" } },
    { filters: { minImdbRating: 11 } },
    { filters: { minImdbRating: -0.5 } },
    { filters: { minImdbRating: Number.NaN } },
    { lookupDetails: "not a function" },
  ])("malformed options %p are invalid_list_query, not a throw", (options) => {
    expect(parseListQuery("watchlist", options as never)).toMatchObject({ ok: false, error: { code: "invalid_list_query" } });
  });

  test("well-formed filters pass through, with era bounds normalized", () => {
    const result = parseListQuery("watchlist", {
      filters: { mediaTypes: ["tv"], genreIds: [18], era: { fromYear: 2000 }, onMyServices: false, minImdbRating: 7.5 },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        filters: { mediaTypes: ["tv"], genreIds: [18], era: { fromYear: 2000, toYear: null }, onMyServices: false, minImdbRating: 7.5 },
      },
    });
  });
});

describe("cursors", () => {
  test("round-trip", () => {
    const key = { sort: "rating_asc" as const, values: [4.5, -123, "tv", 9] };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  test("reject wrong shapes", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(decodeCursor(enc(["updated_desc", 1, "movie"]))).toBeNull(); // too short
    expect(decodeCursor(enc(["rating_desc", 1, "movie", 1]))).toBeNull(); // rating sort needs four values
    expect(decodeCursor(enc(["nope", 1, "movie", 1]))).toBeNull();
    expect(decodeCursor(enc({ sort: "updated_desc" }))).toBeNull();
    expect(decodeCursor(enc(["updated_desc", null, "movie", 1]))).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("filters", () => {
  test("media type alone needs no details", () => {
    expect(filtersNeedDetails({ mediaTypes: ["tv"] })).toBe(false);
    expect(filtersNeedDetails({ era: { fromYear: null, toYear: null } })).toBe(false);
    expect(filtersNeedDetails({ genreIds: [878] })).toBe(true);
    expect(filtersNeedDetails({ era: { fromYear: 2020 } })).toBe(true);
    expect(filtersNeedDetails({ onMyServices: true })).toBe(true);
    // The IMDb rating needs the IMDb ID, which comes with the details.
    expect(filtersNeedDetails({ minImdbRating: 7.5 })).toBe(true);
    expect(filtersNeedDetails({ minImdbRating: 0 })).toBe(true);
  });

  test("a minimum IMDb rating keeps rows rated at or above it, and drops rows with no IMDb rating", () => {
    const rows = [rec(1), rec(2), rec(3), rec(4)];
    const details = new Map([
      ["movie:1", cand(1, { imdb: { rating: 8, votes: 1_000 } })],
      ["movie:2", cand(2, { imdb: { rating: 7.4, votes: 1_000 } })],
      ["movie:3", cand(3, { tmdbVoteAverage: 9 })],
      // movie:4 has no details at all.
    ]);
    expect(ids(applyListFilters(rows, { minImdbRating: 7.5 }, details, []))).toEqual(["movie:1"]);
    expect(ids(applyListFilters(rows, { minImdbRating: 7 }, details, []))).toEqual(["movie:1", "movie:2"]);
  });

  test("media type filters on the row itself", () => {
    const rows = [rec(1), rec(2, { mediaType: "tv" })];
    expect(ids(applyListFilters(rows, { mediaTypes: ["tv"] }, null, []))).toEqual(["tv:2"]);
  });

  test("genre, era, and services use the deck's matchesFilters on looked-up details", () => {
    const rows = [rec(1), rec(2), rec(3), rec(4)];
    const details = new Map([
      ["movie:1", cand(1, { genreIds: [878], year: 2022, providerIds: [8] })],
      ["movie:2", cand(2, { genreIds: [878], year: 1999, providerIds: [8] })],
      ["movie:3", cand(3, { genreIds: [18], year: 2022, providerIds: [8] })],
      // movie:4 has no details, so it fails any metadata filter.
    ]);
    const filters = { genreIds: [878], era: { fromYear: 2020 }, onMyServices: true };
    expect(ids(applyListFilters(rows, filters, details, [8]))).toEqual(["movie:1"]);
    expect(ids(applyListFilters(rows, filters, details, [337]))).toEqual([]);
  });

  test("a lookup answer for another title cannot change which row matches", () => {
    const rows = [rec(1)];
    const details = new Map([["movie:1", cand(99, { mediaType: "tv", genreIds: [878] })]]);
    expect(ids(applyListFilters(rows, { genreIds: [878], mediaTypes: ["movie"] }, details, []))).toEqual(["movie:1"]);
  });
});

describe("pageRows", () => {
  const rows = [rec(3), rec(1), rec(2), rec(5), rec(4)];

  test("sorts by updatedAt, newest first by default", () => {
    expect(ids(pageRows(rows, "updated_desc", null, 10).rows)).toEqual(["movie:5", "movie:4", "movie:3", "movie:2", "movie:1"]);
    expect(ids(pageRows(rows, "created_asc", null, 10).rows)).toEqual(["movie:1", "movie:2", "movie:3", "movie:4", "movie:5"]);
  });

  test("pages without repeats or gaps, and the last page has no cursor", () => {
    const seen: string[] = [];
    let cursor = null;
    for (let i = 0; i < 10; i++) {
      const page = pageRows(rows, "updated_desc", cursor, 2);
      seen.push(...ids(page.rows));
      if (!page.nextCursor) break;
      cursor = decodeCursor(page.nextCursor);
    }
    expect(seen).toEqual(["movie:5", "movie:4", "movie:3", "movie:2", "movie:1"]);
  });

  test("a row removed between pages does not shift the next page", () => {
    const first = pageRows(rows, "updated_desc", null, 2);
    const remaining = rows.filter((r) => r.tmdbId !== 5); // the first row on page one is removed
    const second = pageRows(remaining, "updated_desc", decodeCursor(first.nextCursor), 2);
    expect(ids(second.rows)).toEqual(["movie:3", "movie:2"]);
  });

  test("ties break on identity, so the order is total", () => {
    const same = new Date("2026-01-01T00:00:00Z");
    const tied = [rec(2, { updatedAt: same, mediaType: "tv" }), rec(2, { updatedAt: same }), rec(1, { updatedAt: same })];
    expect(ids(pageRows(tied, "updated_desc", null, 10).rows)).toEqual(["movie:1", "movie:2", "tv:2"]);
  });

  test("rating sorts break ties by most recent change", () => {
    const seen = [
      rec(1, { status: "seen", rating: 4 }),
      rec(2, { status: "seen", rating: 5 }),
      rec(3, { status: "seen", rating: 4 }),
      rec(4, { status: "seen", rating: 0.5 }),
    ];
    expect(ids(pageRows(seen, "rating_desc", null, 10).rows)).toEqual(["movie:2", "movie:3", "movie:1", "movie:4"]);
    expect(ids(pageRows(seen, "rating_asc", null, 10).rows)).toEqual(["movie:4", "movie:3", "movie:1", "movie:2"]);
  });

  test("an empty list is one empty page", () => {
    expect(pageRows([], "updated_desc", null, 10)).toEqual({ rows: [], nextCursor: null });
  });
});

describe("withDetails", () => {
  test("attaches details where known", () => {
    const entries = withDetails([rec(1), rec(2)], new Map([["movie:1", cand(1)]]));
    expect(entries[0]!.details?.title).toBe("T1");
    expect("details" in entries[1]!).toBe(false);
  });
});
