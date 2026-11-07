import { describe, expect, test } from "bun:test";
import type { MediaType } from "../types";
import { mergeSearchPages } from "./merge";
import type { SearchResult } from "./types";

function result(mediaType: MediaType, tmdbId: number): SearchResult {
  return { mediaType, tmdbId, title: `${mediaType} ${tmdbId}`, year: 2020, posterUrl: null, overview: "", status: null };
}

describe("mergeSearchPages", () => {
  test("appends the later page, keeping each title's first place", () => {
    const shown = [result("movie", 1), result("movie", 2)];
    const next = [result("movie", 2), result("movie", 3), result("movie", 3)];
    expect(mergeSearchPages(shown, next).map((r) => r.tmdbId)).toEqual([1, 2, 3]);
  });

  test("matches on the pair: a series with a movie's ID is a different title", () => {
    expect(mergeSearchPages([result("movie", 7)], [result("tv", 7)]).map((r) => `${r.mediaType}:${r.tmdbId}`)).toEqual(["movie:7", "tv:7"]);
  });

  test("does not change its inputs", () => {
    const shown = [result("movie", 1)];
    mergeSearchPages(shown, [result("movie", 2)]);
    expect(shown).toHaveLength(1);
  });
});
