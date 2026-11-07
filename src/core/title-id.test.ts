import { describe, expect, test } from "bun:test";
import { formatTitleKey, MAX_TMDB_ID, parseTitleKey, titleIdError, toTitleId, tryFormatTitleKey, type TitleId } from "./title-id";

describe("title keys", () => {
  test("format uses the (media type, TMDB ID) pair", () => {
    expect(formatTitleKey({ mediaType: "movie", tmdbId: 603 })).toBe("movie:603");
    expect(formatTitleKey({ mediaType: "tv", tmdbId: 603 })).toBe("tv:603");
  });

  test("format rejects IDs that are not positive integers", () => {
    expect(() => formatTitleKey({ mediaType: "movie", tmdbId: 0 })).toThrow();
    expect(() => formatTitleKey({ mediaType: "movie", tmdbId: 1.5 })).toThrow();
  });

  test("the largest ID is the Postgres integer max, the tmdb_id column's type", () => {
    expect(formatTitleKey({ mediaType: "movie", tmdbId: MAX_TMDB_ID })).toBe(`movie:${MAX_TMDB_ID}`);
    expect(() => formatTitleKey({ mediaType: "movie", tmdbId: MAX_TMDB_ID + 1 })).toThrow();
    expect(parseTitleKey(`tv:${MAX_TMDB_ID + 1}`)).toBeNull();
  });

  test("titleIdError names the problem, or returns null for a valid identity", () => {
    expect(titleIdError({ mediaType: "tv", tmdbId: 1 })).toBeNull();
    expect(titleIdError(null)).toMatch(/object/);
    expect(titleIdError({ mediaType: "film", tmdbId: 1 })).toMatch(/media type/);
    expect(titleIdError({ mediaType: "movie", tmdbId: "1" })).toMatch(/TMDB ID/);
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

describe("tryFormatTitleKey", () => {
  test("gives the same key as formatTitleKey for a valid identity", () => {
    expect(tryFormatTitleKey({ mediaType: "movie", tmdbId: 603 })).toBe(formatTitleKey({ mediaType: "movie", tmdbId: 603 }));
    expect(tryFormatTitleKey({ mediaType: "tv", tmdbId: MAX_TMDB_ID })).toBe(`tv:${MAX_TMDB_ID}`);
  });

  test("returns null instead of throwing for anything formatTitleKey rejects", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "movie:1",
      { mediaType: "person", tmdbId: 1 },
      { mediaType: "movie", tmdbId: 0 },
      { mediaType: "movie", tmdbId: 1.5 },
      { mediaType: "tv", tmdbId: MAX_TMDB_ID + 1 },
      { mediaType: "movie", tmdbId: "1" },
    ];
    for (const id of bad) {
      expect(tryFormatTitleKey(id)).toBeNull();
      expect(() => formatTitleKey(id as TitleId)).toThrow();
    }
  });
});

describe("toTitleId", () => {
  test("keeps only the identity, in a fresh object", () => {
    const card = { mediaType: "tv" as const, tmdbId: 2734, title: "x", userState: null };
    const id = toTitleId(card);
    expect(id).toEqual({ mediaType: "tv", tmdbId: 2734 });
    expect(id).not.toBe(card);
  });
});
