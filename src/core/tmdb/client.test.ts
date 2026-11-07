import { describe, expect, test } from "bun:test";
import { MemoryCacheStore, type CacheStore } from "../cache/cache-store";
import type { Candidate } from "../types";
import { createTmdbClient } from "./client";
import { TMDB_MAX_BACKOFF_MS, TMDB_TTL_MS } from "./constants";
import { retryDelayMs, TmdbError } from "./http";
import { posterUrl, logoUrl } from "./images";
import { breakingBadDetails, json, matrixDetails, notFound, scriptedFetch, status } from "./test-fixtures";

const HOUR = 60 * 60 * 1000;

/** Runs fn with console.warn muted (expected failure paths log a warning). */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

const timeout = () => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

/** What fetch throws in Node and Bun when the socket is reset. */
const reset = () => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
};

function setup(routes: Parameters<typeof scriptedFetch>[0], cache: CacheStore = new MemoryCacheStore()) {
  const scripted = scriptedFetch(routes);
  const clock = { now: new Date("2026-11-06T12:00:00Z") };
  const sleeps: number[] = [];
  const client = createTmdbClient({
    token: "test-token",
    cache,
    fetch: scripted.fetch,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { client, calls: scripted.calls, sleeps, cache, advance };
}

describe("getTitleDetails", () => {
  test("fetches with appends, sends the bearer token, and normalizes", async () => {
    const { client, calls } = setup({ "/movie/603": json(matrixDetails) });
    const d = await client.getTitleDetails("movie", 603);
    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe("Bearer test-token");
    expect(calls[0].params.get("append_to_response")).toBe("external_ids,videos,watch/providers");
    expect(d?.title).toBe("The Matrix");
    expect(d?.imdbId).toBe("tt0133093");
    expect(d?.trailerYouTubeKey).toBe("anniv1");
    expect(d?.providersByCountry.US.flatrate[0].name).toBe("YouTube TV");
  });

  test("series use the tv path", async () => {
    const { client, calls } = setup({ "/tv/1396": json(breakingBadDetails) });
    const d = await client.getTitleDetails("tv", 1396);
    expect(calls[0].path).toBe("/tv/1396");
    expect(d?.numberOfSeasons).toBe(5);
  });

  test("404 resolves to null and is not cached", async () => {
    const { client, calls, cache } = setup({ "/movie/999999": notFound });
    expect(await client.getTitleDetails("movie", 999999)).toBeNull();
    expect((cache as MemoryCacheStore).size).toBe(0);
    expect(await client.getTitleDetails("movie", 999999)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("cache hit: a second call inside both TTLs makes no request", async () => {
    const { client, calls, advance } = setup({ "/movie/603": json(matrixDetails) });
    const first = await client.getTitleDetails("movie", 603);
    advance(11 * HOUR);
    const second = await client.getTitleDetails("movie", 603);
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  test("stale providers alone: only the providers endpoint is refetched", async () => {
    const changed = { results: { US: { flatrate: [{ provider_id: 8, provider_name: "Netflix", display_priority: 0 }] } } };
    const { client, calls, advance } = setup({
      "/movie/603": json(matrixDetails),
      "/movie/603/watch/providers": json(changed),
    });
    await client.getTitleDetails("movie", 603);
    advance(TMDB_TTL_MS.titleProviders + 1);
    const d = await client.getTitleDetails("movie", 603);
    expect(calls.map((c) => c.path)).toEqual(["/movie/603", "/movie/603/watch/providers"]);
    expect(d?.title).toBe("The Matrix");
    expect(d?.providersByCountry.US.flatrate.map((p) => p.id)).toEqual([8]);
  });

  test("stale providers whose refresh fails: the card still shows, with the stale providers", async () => {
    for (const failure of [status(503), notFound]) {
      const { client, advance } = setup({
        "/movie/603": json(matrixDetails),
        "/movie/603/watch/providers": failure,
      });
      const first = await client.getTitleDetails("movie", 603);
      advance(TMDB_TTL_MS.titleProviders + 1);
      const d = await quietly(() => client.getTitleDetails("movie", 603));
      expect(d?.title).toBe("The Matrix");
      expect(d?.providersByCountry).toEqual(first!.providersByCountry);
    }
  });

  test("cache miss after the details TTL refetches everything", async () => {
    const { client, calls, advance } = setup({ "/movie/603": json(matrixDetails) });
    await client.getTitleDetails("movie", 603);
    advance(TMDB_TTL_MS.details + 1);
    await client.getTitleDetails("movie", 603);
    expect(calls.map((c) => c.path)).toEqual(["/movie/603", "/movie/603"]);
  });

  test("a failing cache does not break lookups", async () => {
    const broken: CacheStore = {
      get: async () => {
        throw new Error("db down");
      },
      set: async () => {
        throw new Error("db down");
      },
    };
    const { client } = setup({ "/movie/603": json(matrixDetails) }, broken);
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect((await client.getTitleDetails("movie", 603))?.title).toBe("The Matrix");
    } finally {
      console.warn = warn;
    }
  });

  test("rejects an invalid title identity before any request", async () => {
    const { client, calls } = setup({});
    // Messages come from titleIdError in src/core/title-id.ts.
    await expect(client.getTitleDetails("movie", 0)).rejects.toThrow("invalid TMDB ID");
    // @ts-expect-error: invalid media type on purpose
    await expect(client.getTitleDetails("person", 1)).rejects.toThrow("invalid media type");
    expect(calls).toHaveLength(0);
  });
});

describe("HTTP 429 and errors", () => {
  test("honors Retry-After, then succeeds", async () => {
    const { client, calls, sleeps } = setup({
      "/movie/603": [status(429, { "retry-after": "2" }), json(matrixDetails)],
    });
    expect((await client.getTitleDetails("movie", 603))?.title).toBe("The Matrix");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  test("backs off exponentially without Retry-After, and gives up after the retry bound", async () => {
    const { client, calls, sleeps } = setup({ "/movie/603": status(429) });
    const err = await client.getTitleDetails("movie", 603).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmdbError);
    expect((err as TmdbError).status).toBe(429);
    expect(calls).toHaveLength(4); // first try plus 3 retries
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  test("retries 5xx too, but not other 4xx", async () => {
    const a = setup({ "/movie/603": [status(503), json(matrixDetails)] });
    expect((await a.client.getTitleDetails("movie", 603))?.title).toBe("The Matrix");
    const b = setup({ "/movie/603": status(401) });
    await expect(b.client.getTitleDetails("movie", 603)).rejects.toThrow("TMDB 401");
    expect(b.calls).toHaveLength(1);
  });

  test("each attempt carries a timeout signal, and a timeout is retried", async () => {
    let signal: AbortSignal | null | undefined;
    const scripted = scriptedFetch({ "/movie/603": [timeout, json(matrixDetails)] });
    const client = createTmdbClient({
      token: "t",
      cache: new MemoryCacheStore(),
      fetch: (input, init) => {
        signal = init?.signal;
        return scripted.fetch(input, init);
      },
      sleep: async () => {},
    });
    expect((await client.getTitleDetails("movie", 603))?.title).toBe("The Matrix");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(scripted.calls).toHaveLength(2);
  });

  test("a connection reset is retried, then succeeds", async () => {
    const { client, calls, sleeps } = setup({ "/movie/603": [reset, json(matrixDetails)] });
    expect((await client.getTitleDetails("movie", 603))?.title).toBe("The Matrix");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  test("a persistent connection reset ends in TmdbError after the retry bound", async () => {
    const { client, calls } = setup({ "/discover/movie": reset });
    const err = await client.discover("popular", { mediaType: "movie" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmdbError);
    expect((err as TmdbError).status).toBe(0);
    expect((err as TmdbError).message).toContain("ECONNRESET");
    expect(calls).toHaveLength(4);
  });

  test("a 200 whose body is not JSON throws TmdbError at once", async () => {
    const { client, calls } = setup({ "/movie/603": () => new Response("<html>oops", { status: 200 }) });
    const err = await client.getTitleDetails("movie", 603).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmdbError);
    expect((err as TmdbError).message).toContain("not JSON");
    expect(calls).toHaveLength(1);
  });

  test("gives up after the retry bound when every attempt times out", async () => {
    const { client, calls } = setup({ "/movie/603": timeout });
    const err = await client.getTitleDetails("movie", 603).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmdbError);
    expect((err as TmdbError).message).toContain("timed out");
    expect(calls).toHaveLength(4);
  });

  test("retryDelayMs reads seconds or an HTTP date, and caps the wait", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    expect(retryDelayMs("3", 0, now)).toBe(3000);
    expect(retryDelayMs("Fri, 06 Nov 2026 12:00:05 GMT", 0, now)).toBe(5000);
    expect(retryDelayMs("600", 0, now)).toBe(TMDB_MAX_BACKOFF_MS);
    expect(retryDelayMs(null, 2, now)).toBe(4000);
    expect(retryDelayMs("garbage", 1, now)).toBe(2000);
  });
});

describe("discover", () => {
  const page = (results: object[]) => json({ page: 1, total_pages: 3, results });

  test("popular: sort, vote floor, filters, and provider params", async () => {
    const { client, calls } = setup({
      "/discover/tv": page([{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", genre_ids: [18], popularity: 60, vote_average: 8.9, vote_count: 16000 }]),
    });
    const result = await client.discover("popular", {
      mediaType: "tv",
      genreIds: [10765, 18, 18],
      era: { fromYear: 2015, toYear: 2025 },
      providerIds: [9, 8],
      watchRegion: "US",
    });
    const p = calls[0].params;
    expect(p.get("sort_by")).toBe("popularity.desc");
    expect(p.get("with_genres")).toBe("18|10765");
    expect(p.get("first_air_date.gte")).toBe("2015-01-01");
    expect(p.get("first_air_date.lte")).toBe("2025-12-31");
    expect(p.get("with_watch_providers")).toBe("8|9");
    expect(p.get("watch_region")).toBe("US");
    expect(p.get("with_watch_monetization_types")).toBe("flatrate|free|ads");
    expect(p.get("include_adult")).toBe("false");
    expect(result.totalPages).toBe(3);
    expect(result.results[0]).toMatchObject({ mediaType: "tv", tmdbId: 1396, year: 2008, tmdbVoteCount: 16000 });
  });

  test("movies filter on primary release date", async () => {
    const { client, calls } = setup({ "/discover/movie": page([]) });
    await client.discover("top_rated", { mediaType: "movie", era: { fromYear: 2020 } });
    expect(calls[0].params.get("primary_release_date.gte")).toBe("2020-01-01");
    expect(calls[0].params.get("sort_by")).toBe("vote_average.desc");
    expect(calls[0].params.get("vote_count.gte")).toBe("1000");
  });

  test("deep cuts ask for a band of vote counts with a minimum average", async () => {
    const { client, calls } = setup({ "/discover/movie": page([]) });
    await client.discover("deep_cuts", { mediaType: "movie" });
    const p = calls[0].params;
    expect([p.get("vote_count.gte"), p.get("vote_count.lte"), p.get("vote_average.gte")]).toEqual(["100", "999", "7"]);
  });

  test("providers without a region is a caller error", async () => {
    const { client } = setup({});
    await expect(client.discover("popular", { mediaType: "movie", providerIds: [8] })).rejects.toThrow("watchRegion");
  });

  test("discover pages are cached for 12 hours", async () => {
    const { client, calls, advance } = setup({ "/discover/movie": page([]) });
    await client.discover("popular", { mediaType: "movie" });
    await client.discover("popular", { mediaType: "movie" });
    expect(calls).toHaveLength(1);
    advance(TMDB_TTL_MS.discover + 1);
    await client.discover("popular", { mediaType: "movie" });
    expect(calls).toHaveLength(2);
  });
});

describe("recommendations", () => {
  test("applies genre and era filters locally", async () => {
    const { client, calls } = setup({
      "/movie/603/recommendations": json({
        page: 1,
        total_pages: 1,
        results: [
          { id: 1, media_type: "movie", title: "Old sci-fi", release_date: "1990-01-01", genre_ids: [878] },
          { id: 2, media_type: "movie", title: "New sci-fi", release_date: "2021-01-01", genre_ids: [878] },
          { id: 3, media_type: "movie", title: "New drama", release_date: "2021-01-01", genre_ids: [18] },
        ],
      }),
    });
    const r = await client.recommendations({ mediaType: "movie", tmdbId: 603 }, { genreIds: [878], era: { fromYear: 2000 } });
    expect(calls[0].path).toBe("/movie/603/recommendations");
    expect(r.results.map((t) => t.tmdbId)).toEqual([2]);
  });

  test("an unknown seed gives an empty page", async () => {
    const { client } = setup({ "/tv/5/recommendations": notFound });
    expect((await client.recommendations({ mediaType: "tv", tmdbId: 5 })).results).toEqual([]);
  });
});

describe("searchTitles", () => {
  test("keeps movies and series, drops people", async () => {
    const { client, calls } = setup({
      "/search/multi": json({
        page: 1,
        total_pages: 1,
        results: [
          { id: 603, media_type: "movie", title: "The Matrix", release_date: "1999-03-31" },
          { id: 6384, media_type: "person", name: "Keanu Reeves" },
          { id: 711, media_type: "tv", name: "Threat Matrix", first_air_date: "2003-09-18" },
        ],
      }),
    });
    const r = await client.searchTitles("  The   Matrix ");
    expect(calls[0].params.get("query")).toBe("the matrix");
    expect(r.results.map((t) => [t.mediaType, t.tmdbId])).toEqual([
      ["movie", 603],
      ["tv", 711],
    ]);
  });

  test("a blank query makes no request", async () => {
    const { client, calls } = setup({});
    expect((await client.searchTitles("   ")).results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("search is cached for an hour", async () => {
    const { client, calls, advance } = setup({ "/search/multi": json({ page: 1, total_pages: 0, results: [] }) });
    await client.searchTitles("dune");
    await client.searchTitles("Dune");
    expect(calls).toHaveLength(1);
    advance(TMDB_TTL_MS.search + 1);
    await client.searchTitles("dune");
    expect(calls).toHaveLength(2);
  });
});

describe("lists", () => {
  test("getGenres", async () => {
    const { client } = setup({ "/genre/tv/list": json({ genres: [{ id: 18, name: "Drama" }, { id: "bad" }] }) });
    expect(await client.getGenres("tv")).toEqual([{ id: 18, name: "Drama" }]);
  });

  test("getProviderList merges movie and tv lists, ordered for the country", async () => {
    const { client, calls } = setup({
      "/watch/providers/movie": json({
        results: [
          { provider_id: 8, provider_name: "Netflix", logo_path: "/n.png", display_priorities: { US: 0, GB: 3 } },
          { provider_id: 2, provider_name: "Apple TV Store", logo_path: "/a.png", display_priorities: { US: 5 } },
        ],
      }),
      "/watch/providers/tv": json({
        results: [
          { provider_id: 8, provider_name: "Netflix", logo_path: "/n.png", display_priorities: { US: 0 } },
          { provider_id: 15, provider_name: "Hulu", logo_path: "/h.png", display_priorities: { US: 2 } },
        ],
      }),
    });
    const list = await client.getProviderList("US");
    expect(calls.every((c) => c.params.get("watch_region") === "US")).toBe(true);
    expect(list.map((p) => [p.id, p.mediaTypes])).toEqual([
      [8, ["movie", "tv"]],
      [15, ["tv"]],
      [2, ["movie"]],
    ]);
  });

  test("rejects a bad country code", async () => {
    const { client } = setup({});
    await expect(client.getProviderList("usa")).rejects.toThrow("country");
  });
});

describe("fan-out helpers", () => {
  test("resolveImdbIds reads details once per title, through the cache", async () => {
    const { client, calls } = setup({
      "/movie/603": json(matrixDetails),
      "/tv/1396": json(breakingBadDetails),
      "/movie/404": notFound,
    });
    const ids = [
      { mediaType: "movie" as const, tmdbId: 603 },
      { mediaType: "tv" as const, tmdbId: 1396 },
      { mediaType: "movie" as const, tmdbId: 603 },
      { mediaType: "movie" as const, tmdbId: 404 },
    ];
    const map = await client.resolveImdbIds(ids);
    expect(Object.fromEntries(map)).toEqual({ "movie:603": "tt0133093", "tv:1396": "tt0903747", "movie:404": null });
    expect(calls).toHaveLength(3);
    await client.resolveImdbIds(ids.slice(0, 2));
    expect(calls).toHaveLength(3); // both found titles are cached
  });

  test("resolveImdbIds: a title that fails gets null, the rest still resolve", async () => {
    const { client } = setup({
      "/movie/603": json(matrixDetails),
      "/tv/1396": status(500),
    });
    const map = await quietly(() =>
      client.resolveImdbIds([
        { mediaType: "movie", tmdbId: 603 },
        { mediaType: "tv", tmdbId: 1396 },
      ]),
    );
    expect(Object.fromEntries(map)).toEqual({ "movie:603": "tt0133093", "tv:1396": null });
  });

  test("attachProviderIds counts free and ad-supported services, not rent or buy", async () => {
    const provider = (id: number) => ({ provider_id: id, provider_name: `p${id}`, logo_path: null, display_priority: id });
    const { client } = setup({
      "/movie/603": json({
        ...matrixDetails,
        "watch/providers": {
          results: { US: { flatrate: [provider(8)], free: [provider(191)], ads: [provider(73), provider(8)], rent: [provider(2)], buy: [provider(10)] } },
        },
      }),
      "/tv/1396": status(500),
    });
    const base = { title: "x", year: 2000, genreIds: [], popularity: 1, tmdbVoteAverage: 7, tmdbVoteCount: 10 };
    const out = await quietly(() =>
      client.attachProviderIds<Candidate>(
        [
          { ...base, mediaType: "movie", tmdbId: 603 },
          { ...base, mediaType: "tv", tmdbId: 1396 },
        ],
        "US",
      ),
    );
    // A failed lookup leaves providerIds unknown instead of failing the batch.
    expect(out.map((c) => c.providerIds)).toEqual([[8, 191, 73], undefined]);
  });

  test("attachProviderIds sets streaming providers for the country", async () => {
    const { client } = setup({
      "/movie/603": json(matrixDetails),
      "/tv/1396": json({ ...breakingBadDetails, "watch/providers": { results: {} } }),
      "/movie/404": notFound,
    });
    const base = { title: "x", year: 2000, genreIds: [], popularity: 1, tmdbVoteAverage: 7, tmdbVoteCount: 10 };
    const out = await client.attachProviderIds<Candidate>(
      [
        { ...base, mediaType: "movie", tmdbId: 603 },
        { ...base, mediaType: "tv", tmdbId: 1396 },
        { ...base, mediaType: "movie", tmdbId: 404 },
      ],
      "US",
    );
    expect(out.map((c) => c.providerIds)).toEqual([[2528], [], undefined]);
  });

  test("attachProviderIds and resolveImdbIds in parallel on a cold cache share one request per title", async () => {
    const { client, calls } = setup({ "/movie/603": json(matrixDetails), "/tv/1396": json(breakingBadDetails) });
    const base = { title: "x", year: 2000, genreIds: [], popularity: 1, tmdbVoteAverage: 7, tmdbVoteCount: 10 };
    const candidates: Candidate[] = [
      { ...base, mediaType: "movie", tmdbId: 603 },
      { ...base, mediaType: "tv", tmdbId: 1396 },
    ];
    const [withProviders, imdbIds] = await Promise.all([client.attachProviderIds(candidates, "US"), client.resolveImdbIds(candidates)]);
    expect(calls.map((c) => c.path).sort()).toEqual(["/movie/603", "/tv/1396"]);
    expect(withProviders.map((c) => c.providerIds)).toEqual([[2528], [8]]);
    expect(Object.fromEntries(imdbIds)).toEqual({ "movie:603": "tt0133093", "tv:1396": "tt0903747" });
  });

  test("attachProviderIds serves expired providers when their refresh fails", async () => {
    const { client, advance } = setup({
      "/movie/603": json(matrixDetails),
      "/movie/603/watch/providers": status(503),
    });
    const base = { title: "x", year: 2000, genreIds: [], popularity: 1, tmdbVoteAverage: 7, tmdbVoteCount: 10 };
    const candidates: Candidate[] = [{ ...base, mediaType: "movie", tmdbId: 603 }];
    await client.attachProviderIds(candidates, "US");
    advance(TMDB_TTL_MS.titleProviders + 1);
    const out = await quietly(() => client.attachProviderIds(candidates, "US"));
    expect(out[0].providerIds).toEqual([2528]);
  });
});

describe("expired details", () => {
  test("served when the refetch fails, so the card and its IMDb ID survive an outage", async () => {
    const { client, calls, advance } = setup({ "/movie/603": [json(matrixDetails), status(503)] });
    await client.getTitleDetails("movie", 603);
    advance(TMDB_TTL_MS.details + 1);
    const d = await quietly(() => client.getTitleDetails("movie", 603));
    expect(d?.title).toBe("The Matrix");
    expect(d?.providersByCountry.US.flatrate.map((p) => p.id)).toEqual([2528]);
    const ids = await quietly(() => client.resolveImdbIds([{ mediaType: "movie", tmdbId: 603 }]));
    expect(ids.get("movie:603")).toBe("tt0133093");
    expect(calls.length).toBeGreaterThan(1); // the refetch was attempted
  });

  test("a failed fetch with nothing cached still throws", async () => {
    const { client } = setup({ "/movie/603": status(503) });
    await expect(client.getTitleDetails("movie", 603)).rejects.toBeInstanceOf(TmdbError);
  });
});

test("image URL helpers", () => {
  expect(posterUrl("/abc.jpg")).toBe("https://image.tmdb.org/t/p/w500/abc.jpg");
  expect(posterUrl("/abc.jpg", "w342")).toBe("https://image.tmdb.org/t/p/w342/abc.jpg");
  expect(posterUrl(null)).toBeNull();
  expect(logoUrl("/n.png")).toBe("https://image.tmdb.org/t/p/w92/n.png");
});

describe("getWatchRegions", () => {
  test("fetches once, then answers from the cache until it expires", async () => {
    const payload = { results: [{ iso_3166_1: "US", english_name: "United States" }] };
    const { client, calls, advance } = setup({ "/watch/providers/regions": json(payload) });
    expect(await client.getWatchRegions()).toEqual([{ code: "US", name: "United States" }]);
    await client.getWatchRegions();
    expect(calls).toHaveLength(1);
    expect(calls[0].params.get("language")).toBe("en-US");
    advance(TMDB_TTL_MS.watchRegions + 1);
    await client.getWatchRegions();
    expect(calls).toHaveLength(2);
  });
});
