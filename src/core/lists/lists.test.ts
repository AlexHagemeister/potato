import { describe, expect, test } from "bun:test";
import { MemoryRatingsStore } from "../imdb/ratings";
import type { TitleRecord } from "../library/types";
import type { DetailsCore } from "../tmdb";
import type { Candidate } from "../types";
import { createTitleInfoLookup, toListRow } from "./lists";

const record: TitleRecord = {
  mediaType: "movie",
  tmdbId: 603,
  status: "seen",
  rating: 4.5,
  review: "Still holds up.",
  reviewVisibility: "private",
  skipUntil: null,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  updatedAt: new Date("2026-11-02T10:00:00Z"),
};

const info = {
  mediaType: "movie",
  tmdbId: 603,
  title: "The Matrix",
  year: 1999,
  posterPath: "/poster.jpg",
} as DetailsCore;

describe("toListRow", () => {
  test("carries the row's identity, status, rating, review, and time, plus title, year, and a thumbnail poster", () => {
    expect(toListRow(record, info)).toEqual({
      mediaType: "movie",
      tmdbId: 603,
      status: "seen",
      rating: 4.5,
      review: "Still holds up.",
      updatedAt: record.updatedAt,
      title: "The Matrix",
      year: 1999,
      posterUrl: "https://image.tmdb.org/t/p/w185/poster.jpg",
    });
  });

  test("unknown metadata still gives a row, with null display fields", () => {
    const row = toListRow({ ...record, status: "watchlist", rating: null, review: null }, undefined);
    expect(row).toMatchObject({ mediaType: "movie", tmdbId: 603, status: "watchlist", title: null, year: null, posterUrl: null });
  });

  test("a title with no poster gets a null poster URL", () => {
    expect(toListRow(record, { ...info, posterPath: null }).posterUrl).toBeNull();
  });
});

describe("createTitleInfoLookup", () => {
  const matrix = { ...info, tmdbId: 603 } as DetailsCore;
  const lost = { ...info, mediaType: "tv", tmdbId: 1399, title: "Lost" } as DetailsCore;

  function fakeTmdb() {
    const calls: { lookup: number; attach: { ids: string[]; country: string }[] } = { lookup: 0, attach: [] };
    const tmdb = {
      lookupTitles: async () => {
        calls.lookup++;
        return new Map([
          ["movie:603", matrix],
          ["tv:1399", lost],
        ]);
      },
      attachProviderIds: async <T extends Candidate>(cs: readonly T[], country: string): Promise<T[]> => {
        calls.attach.push({ ids: cs.map((c) => `${c.mediaType}:${c.tmdbId}`), country });
        // The real client leaves providerIds undefined when it can't tell.
        return cs.map((c) => (c.tmdbId === 603 ? { ...c, providerIds: [8] } : { ...c }));
      },
    };
    return { tmdb, calls };
  }

  const refs = [
    { mediaType: "movie" as const, tmdbId: 603 },
    { mediaType: "tv" as const, tmdbId: 1399 },
  ];

  test("without a country it reads display metadata only, with no streaming lookup", async () => {
    const { tmdb, calls } = fakeTmdb();
    const found = await createTitleInfoLookup(tmdb)(refs);
    expect(calls).toEqual({ lookup: 1, attach: [] });
    expect(found.get("movie:603")?.providerIds).toBeUndefined();
  });

  test("with a country it adds where each title streams there, keyed by the pair", async () => {
    const { tmdb, calls } = fakeTmdb();
    const found = await createTitleInfoLookup(tmdb)(refs, { country: "GB" });
    expect(calls.attach).toEqual([{ ids: ["movie:603", "tv:1399"], country: "GB" }]);
    expect(found.get("movie:603")?.providerIds).toEqual([8]);
    expect(found.get("tv:1399")?.title).toBe("Lost");
    expect(found.get("tv:1399")?.providerIds).toBeUndefined();
  });

  describe("IMDb ratings (a minimum IMDb rating filter)", () => {
    const rated = { ...matrix, imdbId: "tt0133093" } as DetailsCore;
    const unmapped = { ...lost, imdbId: null } as DetailsCore;
    const tmdbWith = (titles: DetailsCore[]) => ({
      lookupTitles: async () => new Map(titles.map((t) => [`${t.mediaType}:${t.tmdbId}`, t])),
      attachProviderIds: async <T extends Candidate>(cs: readonly T[]): Promise<T[]> => cs.map((c) => ({ ...c, providerIds: [8] })),
    });
    const ratings = () => new MemoryRatingsStore(new Map([["tt0133093", { rating: 8.7, votes: 2_000_000 }]]));

    test("without the flag no rating is read", async () => {
      let reads = 0;
      const spy = () => ({ getMany: async () => (reads++, new Map()), hasAnyRatings: async () => true });
      const found = await createTitleInfoLookup(tmdbWith([rated]), spy)(refs);
      expect(reads).toBe(0);
      expect(found.get("movie:603")?.imdb).toBeUndefined();
    });

    test("with the flag each title carries IMDb's rating, and a title IMDb has none for carries none", async () => {
      const found = await createTitleInfoLookup(tmdbWith([rated, unmapped]), ratings)(refs, { imdbRatings: true });
      expect(found.get("movie:603")?.imdb).toEqual({ rating: 8.7, votes: 2_000_000 });
      expect(found.get("tv:1399")?.imdb).toBeUndefined();
    });

    test("combines with a country: both providers and ratings", async () => {
      const found = await createTitleInfoLookup(tmdbWith([rated]), ratings)(refs, { country: "US", imdbRatings: true });
      expect(found.get("movie:603")).toMatchObject({ providerIds: [8], imdb: { rating: 8.7 } });
    });

    test("rows stay keyed by the requested ref, even when TMDB's answer carries another key", async () => {
      // A details entry whose own (media type, TMDB ID) differs from the ref that asked for it.
      const odd = { ...rated, tmdbId: 9603 } as DetailsCore;
      const tmdb = {
        lookupTitles: async () => new Map([["movie:603", odd]]),
        attachProviderIds: async <T extends Candidate>(cs: readonly T[]): Promise<T[]> => cs.map((c) => ({ ...c, providerIds: [8] })),
      };
      for (const context of [undefined, { country: "US" }, { imdbRatings: true }]) {
        const found = await createTitleInfoLookup(tmdb, ratings)(refs, context);
        expect([...found.keys()]).toEqual(["movie:603"]);
      }
    });

    test("an empty ratings table throws, so the list shows a failure instead of emptying", async () => {
      const lookup = createTitleInfoLookup(tmdbWith([rated]), () => new MemoryRatingsStore());
      await expect(lookup(refs, { imdbRatings: true })).rejects.toThrow(/not loaded/);
    });
  });
});
