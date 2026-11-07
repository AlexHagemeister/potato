import { describe, expect, test } from "bun:test";
import { formatTitleKey, parseTitleKey, type TitleId } from "./title-id";

describe("title keys", () => {
  test("format uses the (media type, TMDB ID) pair", () => {
    expect(formatTitleKey({ mediaType: "movie", tmdbId: 603 })).toBe("movie:603");
    expect(formatTitleKey({ mediaType: "tv", tmdbId: 603 })).toBe("tv:603");
  });

  test("format rejects IDs that are not positive integers", () => {
    expect(() => formatTitleKey({ mediaType: "movie", tmdbId: 0 })).toThrow();
    expect(() => formatTitleKey({ mediaType: "movie", tmdbId: 1.5 })).toThrow();
  });

  test("format rejects media types other than movie and tv", () => {
    expect(() => formatTitleKey({ mediaType: "person", tmdbId: 1 } as unknown as TitleId)).toThrow();
  });

  test("parse round-trips a formatted key", () => {
    const id = { mediaType: "tv", tmdbId: 1399 } as const;
    expect(parseTitleKey(formatTitleKey(id))).toEqual(id);
  });

  test("parse rejects malformed keys", () => {
    for (const bad of ["603", "film:603", "movie:", "movie:0", "movie:-1", "movie:01", "tv:1e3", "movie:99999999999999999999"]) {
      expect(parseTitleKey(bad)).toBeNull();
    }
  });
});
