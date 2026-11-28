import { describe, expect, test } from "bun:test";
import { fail, ok, type Result } from "../result";
import { TMDB_MAX_PAGE } from "../tmdb/constants";
import type { ResultPage, TitleSummary } from "../tmdb/types";
import type { MediaType, UserTitleState } from "../types";
import { SEARCH_PAGES_PER_REQUEST, SEARCH_QUERY_MAX_LENGTH, SEARCH_STATUS_MAX_TITLES } from "./constants";
import { createSearchService } from "./service";
import type { SearchPage } from "./types";

const USER = "user-1";
const NOW = new Date("2026-11-07T12:00:00Z");

function summary(mediaType: MediaType, tmdbId: number, overrides: Partial<TitleSummary> = {}): TitleSummary {
  return {
    mediaType,
    tmdbId,
    title: `${mediaType} ${tmdbId}`,
    year: 2020,
    genreIds: [18],
    popularity: 10,
    tmdbVoteAverage: 7,
    tmdbVoteCount: 100,
    posterPath: `/p${tmdbId}.jpg`,
    overview: `About ${mediaType} ${tmdbId}.`,
    ...overrides,
  };
}

interface Fake {
  page?: ResultPage<TitleSummary>;
  /** TMDB's answer by page number, for tests that read more than one page. Wins over `page`. */
  pages?: Record<number, ResultPage<TitleSummary>>;
  states?: UserTitleState[];
  statesResult?: Result<UserTitleState[]>;
  tmdbThrows?: boolean;
  /** Throw on this page only. */
  tmdbThrowsOn?: number;
}

function fakeService(fake: Fake = {}) {
  const calls = { tmdb: [] as [string, number][], states: [] as string[] };
  const service = createSearchService({
    now: () => NOW,
    tmdb: {
      async searchTitles(query, page = 1) {
        calls.tmdb.push([query, page]);
        if (fake.tmdbThrows || fake.tmdbThrowsOn === page) throw new Error("TMDB 503 for /search/multi");
        if (fake.pages) return fake.pages[page] ?? { results: [], page, totalPages: 0 };
        return fake.page ?? { results: [], page, totalPages: 0 };
      },
    },
    library: {
      async getUserTitleStates(userId) {
        calls.states.push(userId);
        return fake.statesResult ?? ok(fake.states ?? []);
      },
    },
  });
  return { service, calls };
}

async function search(fake: Fake, query: unknown, page?: unknown): Promise<SearchPage> {
  const { service } = fakeService(fake);
  const r = await service.searchTitles(USER, query, page);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

describe("searchTitles: results", () => {
  test("keeps TMDB's order and paging, with display-ready rows keyed by the pair", async () => {
    const page = { results: [summary("movie", 603, { title: "The Matrix", year: 1999 }), summary("tv", 603, { posterPath: null })], page: 2, totalPages: 3 };
    const r = await search({ page }, "matrix", 2);
    expect(r).toEqual({
      query: "matrix",
      page: 2,
      totalPages: 3,
      results: [
        {
          mediaType: "movie",
          tmdbId: 603,
          title: "The Matrix",
          year: 1999,
          posterUrl: "https://image.tmdb.org/t/p/w185/p603.jpg",
          overview: "About movie 603.",
          status: null,
        },
        { mediaType: "tv", tmdbId: 603, title: "tv 603", year: 2020, posterUrl: null, overview: "About tv 603.", status: null },
      ],
    });
  });

  test("marks each result with the user's status, matching on media type and ID together", async () => {
    const page = {
      results: [summary("movie", 1), summary("tv", 1), summary("movie", 2), summary("movie", 3), summary("movie", 4)],
      page: 1,
      totalPages: 1,
    };
    const states: UserTitleState[] = [
      { mediaType: "tv", tmdbId: 1, status: "watchlist" }, // same ID, other media type: not movie 1
      { mediaType: "movie", tmdbId: 2, status: "seen" },
      { mediaType: "movie", tmdbId: 3, status: "passed" },
      { mediaType: "movie", tmdbId: 4, status: "watchlist" },
      { mediaType: "movie", tmdbId: 99, status: "seen" }, // not in the results
    ];
    const r = await search({ page, states }, "x");
    expect(r.results.map((t) => [t.mediaType, t.tmdbId, t.status])).toEqual([
      ["movie", 1, null],
      ["tv", 1, "watchlist"],
      ["movie", 2, "seen"],
      ["movie", 3, "passed"],
      ["movie", 4, "watchlist"],
    ]);
  });

  test("a skip shows while it lasts, and not after the title is back in the deck", async () => {
    const page = { results: [summary("movie", 1), summary("movie", 2), summary("movie", 3)], page: 1, totalPages: 1 };
    const states: UserTitleState[] = [
      { mediaType: "movie", tmdbId: 1, status: "skipped", skipUntil: new Date(NOW.getTime() + 60_000) },
      { mediaType: "movie", tmdbId: 2, status: "skipped", skipUntil: new Date(NOW.getTime() - 60_000) },
      // A return time that does not parse stays hidden in the deck, so it still shows as skipped.
      { mediaType: "movie", tmdbId: 3, status: "skipped", skipUntil: "" },
    ];
    const r = await search({ page, states }, "x");
    expect(r.results.map((t) => t.status)).toEqual(["skipped", null, "skipped"]);
  });

  test("trims and collapses the query before searching", async () => {
    const { service, calls } = fakeService();
    const r = await service.searchTitles(USER, "  the   matrix\n", 1);
    expect(r.ok && r.value.query).toBe("the matrix");
    expect(calls.tmdb).toEqual([["the matrix", 1]]);
  });

  test("the page defaults to 1", async () => {
    const { service, calls } = fakeService();
    await service.searchTitles(USER, "dune");
    expect(calls.tmdb).toEqual([["dune", 1]]);
  });

  test("a blank query gives an empty page without asking TMDB or the library", async () => {
    const { service, calls } = fakeService();
    const r = await service.searchTitles(USER, "   ");
    expect(r).toEqual(ok({ query: "", results: [], page: 1, totalPages: 0 }));
    expect(calls).toEqual({ tmdb: [], states: [] });
  });
});

/** A TMDB page that held only people: nothing survives the module's filter. */
function peoplePage(page: number, total: number): ResultPage<TitleSummary> {
  return { results: [], page, totalPages: total };
}

function titlesPage(page: number, total: number, ...ids: number[]): ResultPage<TitleSummary> {
  return { results: ids.map((id) => summary("movie", id)), page, totalPages: total };
}

describe("searchTitles: pages with no titles (#46)", () => {
  test("a first page of only people reads on to the page with titles", async () => {
    const { service, calls } = fakeService({ pages: { 1: peoplePage(1, 5), 2: titlesPage(2, 5, 7, 8), 3: titlesPage(3, 5, 9) } });
    const r = await service.searchTitles(USER, "kevin white");
    expect(r.ok && r.value).toMatchObject({ page: 2, totalPages: 5, results: [{ tmdbId: 7 }, { tmdbId: 8 }] });
    expect(calls.tmdb).toEqual([
      ["kevin white", 1],
      ["kevin white", 2],
    ]);
    expect(calls.states).toEqual([USER]);
  });

  test("a page with titles asks TMDB once", async () => {
    const { service, calls } = fakeService({ pages: { 1: titlesPage(1, 5, 1), 2: titlesPage(2, 5, 2) } });
    await service.searchTitles(USER, "dune");
    expect(calls.tmdb).toEqual([["dune", 1]]);
  });

  test("reads at most the cap, then returns no results with the last page read and TMDB's page count", async () => {
    const pages: Record<number, ResultPage<TitleSummary>> = {};
    for (let n = 1; n <= 10; n++) pages[n] = peoplePage(n, 10);
    const { service, calls } = fakeService({ pages });
    const r = await service.searchTitles(USER, "maria garcia");
    expect(r.ok && r.value).toEqual({ query: "maria garcia", results: [], page: SEARCH_PAGES_PER_REQUEST, totalPages: 10 });
    expect(calls.tmdb).toHaveLength(SEARCH_PAGES_PER_REQUEST);
    // The next request (Show more) starts after the last page read and reads on from there.
    const next = await service.searchTitles(USER, "maria garcia", SEARCH_PAGES_PER_REQUEST + 1);
    expect(next.ok && next.value.page).toBe(Math.min(10, 2 * SEARCH_PAGES_PER_REQUEST));
  });

  test("stops at TMDB's last page: no results there means no matches", async () => {
    const { service, calls } = fakeService({ pages: { 1: peoplePage(1, 2), 2: peoplePage(2, 2), 3: titlesPage(3, 2, 1) } });
    const r = await service.searchTitles(USER, "brian moore");
    expect(r.ok && r.value).toEqual({ query: "brian moore", results: [], page: 2, totalPages: 2 });
    expect(calls.tmdb).toEqual([
      ["brian moore", 1],
      ["brian moore", 2],
    ]);
  });

  test("nothing matched at all asks TMDB once", async () => {
    const { service, calls } = fakeService({ pages: {} });
    const r = await service.searchTitles(USER, "zzqx");
    expect(r.ok && r.value).toEqual({ query: "zzqx", results: [], page: 1, totalPages: 0 });
    expect(calls.tmdb).toHaveLength(1);
  });

  test("a later starting page (Show more) reads on too", async () => {
    const { service, calls } = fakeService({ pages: { 4: peoplePage(4, 9), 5: titlesPage(5, 9, 3) } });
    const r = await service.searchTitles(USER, "steve jones", 4);
    expect(r.ok && r.value).toMatchObject({ page: 5, totalPages: 9, results: [{ tmdbId: 3 }] });
    expect(calls.tmdb).toEqual([
      ["steve jones", 4],
      ["steve jones", 5],
    ]);
  });

  test("a page past TMDB's count asks once and reads no further", async () => {
    const { service, calls } = fakeService({ pages: { 7: peoplePage(7, 3) } });
    const r = await service.searchTitles(USER, "x", 7);
    expect(r.ok && r.value).toMatchObject({ results: [], page: 7, totalPages: 3 });
    expect(calls.tmdb).toHaveLength(1);
  });

  test("a TMDB failure while reading on throws, and no further page is asked", async () => {
    const { service, calls } = fakeService({ pages: { 1: peoplePage(1, 5), 3: titlesPage(3, 5, 1) }, tmdbThrowsOn: 2 });
    await expect(service.searchTitles(USER, "x")).rejects.toThrow("TMDB 503");
    expect(calls.tmdb).toEqual([
      ["x", 1],
      ["x", 2],
    ]);
  });
});

describe("searchTitles: bad input and failures", () => {
  test("bad input returns a typed error and asks no one", async () => {
    const cases: [string, unknown, unknown][] = [
      ["", "dune", 1],
      [USER, 42, 1],
      [USER, null, 1],
      [USER, "x".repeat(SEARCH_QUERY_MAX_LENGTH + 1), 1],
      [USER, "dune", 0],
      [USER, "dune", 1.5],
      [USER, "dune", "2"],
      [USER, "dune", TMDB_MAX_PAGE + 1],
    ];
    for (const [user, query, page] of cases) {
      const { service, calls } = fakeService();
      const r = await service.searchTitles(user, query, page);
      expect(r.ok).toBe(false);
      expect(calls).toEqual({ tmdb: [], states: [] });
    }
    const { service } = fakeService();
    expect(await service.searchTitles("", "dune")).toEqual(fail({ code: "invalid_user" }));
    const long = await service.searchTitles(USER, "x".repeat(SEARCH_QUERY_MAX_LENGTH + 1));
    expect(!long.ok && long.error.code).toBe("invalid_search_query");
  });

  test("a query at the length cap, counted after trimming, is accepted", async () => {
    const r = await search({}, `  ${"x".repeat(SEARCH_QUERY_MAX_LENGTH)}  `);
    expect(r.query).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
  });

  test("a TMDB outage throws, so callers can tell it from no matches", async () => {
    const { service } = fakeService({ tmdbThrows: true });
    await expect(service.searchTitles(USER, "dune")).rejects.toThrow("TMDB 503");
  });

  test("a library error is passed through", async () => {
    const r = await fakeService({ statesResult: fail({ code: "unknown_user" }), page: { results: [summary("movie", 1)], page: 1, totalPages: 1 } })
      .service.searchTitles(USER, "dune");
    expect(r).toEqual(fail({ code: "unknown_user" }));
  });
});

describe("getStatuses (#69)", () => {
  test("each title's status now, in the order asked, by the same rule as a result row, without asking TMDB", async () => {
    const states: UserTitleState[] = [
      { mediaType: "movie", tmdbId: 1, status: "watchlist" },
      // Same ID, other media type: never matched.
      { mediaType: "tv", tmdbId: 2, status: "seen" },
      { mediaType: "movie", tmdbId: 3, status: "skipped", skipUntil: new Date(NOW.getTime() + 60_000) },
      { mediaType: "movie", tmdbId: 4, status: "skipped", skipUntil: new Date(NOW.getTime() - 60_000) },
    ];
    const { service, calls } = fakeService({ states });
    const r = await service.getStatuses(USER, [
      { mediaType: "movie", tmdbId: 2 },
      { mediaType: "movie", tmdbId: 1 },
      { mediaType: "movie", tmdbId: 3 },
      { mediaType: "movie", tmdbId: 4 },
    ]);
    expect(r).toEqual(
      ok([
        { mediaType: "movie", tmdbId: 2, status: null },
        { mediaType: "movie", tmdbId: 1, status: "watchlist" },
        { mediaType: "movie", tmdbId: 3, status: "skipped" },
        { mediaType: "movie", tmdbId: 4, status: null },
      ]),
    );
    expect(calls).toEqual({ tmdb: [], states: [USER] });
  });

  test("only the identity of each title is read and returned", async () => {
    const { service } = fakeService();
    const r = await service.getStatuses(USER, [{ mediaType: "tv", tmdbId: 7, title: "x", status: "seen" }]);
    expect(r).toEqual(ok([{ mediaType: "tv", tmdbId: 7, status: null }]));
  });

  test("no titles reads nothing", async () => {
    const { service, calls } = fakeService();
    expect(await service.getStatuses(USER, [])).toEqual(ok([]));
    expect(calls).toEqual({ tmdb: [], states: [] });
  });

  test("bad input returns a typed error and reads nothing", async () => {
    const tooMany = Array.from({ length: SEARCH_STATUS_MAX_TITLES + 1 }, (_, i) => ({ mediaType: "movie", tmdbId: i + 1 }));
    const cases: [string, unknown][] = [
      ["", []],
      [USER, null],
      [USER, { mediaType: "movie", tmdbId: 1 }],
      [USER, [{ mediaType: "film", tmdbId: 1 }]],
      [USER, [{ mediaType: "movie", tmdbId: 0 }]],
      [USER, [{ mediaType: "movie", tmdbId: "1" }]],
      [USER, tooMany],
    ];
    for (const [user, titles] of cases) {
      const { service, calls } = fakeService();
      const r = await service.getStatuses(user, titles);
      expect(r.ok).toBe(false);
      if (user) expect(!r.ok && r.error.code).toBe("invalid_search_query");
      expect(calls).toEqual({ tmdb: [], states: [] });
    }
    const { service } = fakeService();
    expect((await service.getStatuses(USER, tooMany.slice(1))).ok).toBe(true);
  });

  test("a library error is passed through", async () => {
    const r = await fakeService({ statesResult: fail({ code: "unknown_user" }) }).service.getStatuses(USER, [{ mediaType: "movie", tmdbId: 1 }]);
    expect(r).toEqual(fail({ code: "unknown_user" }));
  });
});
