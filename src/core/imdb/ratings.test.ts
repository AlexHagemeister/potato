import { describe, expect, test } from "bun:test";
import type { Candidate } from "../types";
import { attachImdbRatings, getRatings, getRatingsForFilter, MemoryRatingsStore } from "./ratings";

const store = () =>
  new MemoryRatingsStore(
    new Map([
      ["tt0133093", { rating: 8.7, votes: 2_207_468 }],
      ["tt0903747", { rating: 9.5, votes: 2_400_000 }],
    ]),
  );

const candidate = (mediaType: "movie" | "tv", tmdbId: number, extra: Partial<Candidate> = {}): Candidate => ({
  mediaType,
  tmdbId,
  title: `t${tmdbId}`,
  year: 2000,
  genreIds: [],
  popularity: 1,
  tmdbVoteAverage: 7,
  tmdbVoteCount: 100,
  ...extra,
});

describe("getRatings", () => {
  test("batch lookup returns only IDs with rows", async () => {
    const m = await getRatings(store(), ["tt0133093", "tt0000001", "tt0133093"]);
    expect(Object.fromEntries(m)).toEqual({ tt0133093: { rating: 8.7, votes: 2_207_468 } });
  });

  test("ignores non-IMDb IDs and skips the store for an empty list", async () => {
    let called = false;
    const spy = { getMany: async () => ((called = true), new Map()) };
    expect((await getRatings(spy, ["", "nm0000206"])).size).toBe(0);
    expect(called).toBe(false);
  });
});

describe("getRatingsForFilter", () => {
  test("returns what the store has, without a probe when it found any", async () => {
    let probes = 0;
    const s = store();
    const counted = { getMany: (ids: readonly string[]) => s.getMany(ids), hasAnyRatings: async () => (probes++, true) };
    const m = await getRatingsForFilter(counted, ["tt0133093", "tt0000001"]);
    expect([...m.keys()]).toEqual(["tt0133093"]);
    expect(probes).toBe(0);
  });

  test("finding nothing in a loaded table is an answer: no title is rated", async () => {
    expect((await getRatingsForFilter(store(), ["tt0000001"])).size).toBe(0);
  });

  test("finding nothing in an empty table throws, so a filter never reads it as no rating", async () => {
    await expect(getRatingsForFilter(new MemoryRatingsStore(), ["tt0000001"])).rejects.toThrow(/not loaded/);
  });

  test("no IMDb IDs to look up is an empty answer, with no probe", async () => {
    expect((await getRatingsForFilter(new MemoryRatingsStore(), ["", "nm0000206"])).size).toBe(0);
  });

  test("a failed lookup throws", async () => {
    const broken = { getMany: () => Promise.reject(new Error("db down")), hasAnyRatings: async () => true };
    await expect(getRatingsForFilter(broken, ["tt0133093"])).rejects.toThrow(/db down/);
  });
});

describe("attachImdbRatings", () => {
  test("attaches imdb by title key, and leaves it absent when there is no ID or row", async () => {
    const input = [
      candidate("movie", 603),
      candidate("tv", 1396),
      candidate("movie", 1, { imdb: { rating: 1, votes: 1 } }), // stale value, no ID now
      candidate("movie", 2),
    ];
    const ids = new Map<string, string | null>([
      ["movie:603", "tt0133093"],
      ["tv:1396", "tt0903747"],
      ["movie:1", null],
      ["movie:2", "tt0000002"],
    ]);
    const out = await attachImdbRatings(store(), input, ids);
    expect(out.map((c) => c.imdb)).toEqual([{ rating: 8.7, votes: 2_207_468 }, { rating: 9.5, votes: 2_400_000 }, undefined, undefined]);
    expect("imdb" in out[2]).toBe(false);
    expect(input[2].imdb).toEqual({ rating: 1, votes: 1 }); // input not mutated
  });

  test("with the filter-safe read, an unloaded table throws instead of attaching nothing", async () => {
    const ids = new Map([["movie:603", "tt0133093"]]);
    await expect(attachImdbRatings(new MemoryRatingsStore(), [candidate("movie", 603)], ids, getRatingsForFilter)).rejects.toThrow(/not loaded/);
    const out = await attachImdbRatings(store(), [candidate("movie", 603)], ids, getRatingsForFilter);
    expect(out[0].imdb).toEqual({ rating: 8.7, votes: 2_207_468 });
  });

  test("movie and series with the same TMDB ID stay distinct", async () => {
    const out = await attachImdbRatings(
      store(),
      [candidate("movie", 1396), candidate("tv", 1396)],
      new Map([["tv:1396", "tt0903747"]]),
    );
    expect(out.map((c) => c.imdb?.rating)).toEqual([undefined, 9.5]);
  });
});
