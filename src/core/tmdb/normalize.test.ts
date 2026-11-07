import { describe, expect, test } from "bun:test";
import { normalizeDetailsCore, normalizeProviders, normalizeRegions, normalizeSummary, pickTrailer, yearOf } from "./normalize";
import { breakingBadDetails, matrixDetails, matrixProviders } from "./test-fixtures";

describe("normalizeDetailsCore", () => {
  test("movie: title, year, genres, runtime, poster, IMDb ID, trailer", () => {
    const d = normalizeDetailsCore(matrixDetails, "movie");
    expect(d).toEqual({
      mediaType: "movie",
      tmdbId: 603,
      title: "The Matrix",
      year: 1999,
      genreIds: [28, 878],
      popularity: 20.1,
      tmdbVoteAverage: 8.2,
      tmdbVoteCount: 27000,
      posterPath: "/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg",
      overview: "Set in the 22nd century, The Matrix tells the story of a computer hacker...",
      genres: [
        { id: 28, name: "Action" },
        { id: 878, name: "Science Fiction" },
      ],
      runtimeMinutes: 136,
      numberOfSeasons: null,
      posterUrl: "https://image.tmdb.org/t/p/w500/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg",
      imdbId: "tt0133093",
      trailerYouTubeKey: "anniv1",
    });
  });

  test("series: name, first air year, season count, no runtime", () => {
    const d = normalizeDetailsCore(breakingBadDetails, "tv")!;
    expect(d.title).toBe("Breaking Bad");
    expect(d.year).toBe(2008);
    expect(d.numberOfSeasons).toBe(5);
    expect(d.runtimeMinutes).toBeNull();
    expect(d.imdbId).toBe("tt0903747");
    expect(d.trailerYouTubeKey).toBe("bbTeaser");
  });

  test("missing fields become nulls, not crashes", () => {
    const d = normalizeDetailsCore({ id: 5, title: "Bare" }, "movie")!;
    expect(d.year).toBeNull();
    expect(d.posterPath).toBeNull();
    expect(d.posterUrl).toBeNull();
    expect(d.imdbId).toBeNull();
    expect(d.trailerYouTubeKey).toBeNull();
    expect(d.runtimeMinutes).toBeNull();
    expect(d.genres).toEqual([]);
    expect(d.overview).toBe("");
  });

  test("an empty or malformed IMDb ID is null", () => {
    expect(normalizeDetailsCore({ id: 5, title: "x", external_ids: { imdb_id: "" } }, "movie")!.imdbId).toBeNull();
    expect(normalizeDetailsCore({ id: 5, title: "x", external_ids: { imdb_id: "nm123" } }, "movie")!.imdbId).toBeNull();
  });
});

describe("normalizeSummary", () => {
  test("drops adult titles and results with no usable ID or title", () => {
    expect(normalizeSummary({ id: 1, title: "x", adult: true }, "movie")).toBeNull();
    expect(normalizeSummary({ title: "x" }, "movie")).toBeNull();
    expect(normalizeSummary({ id: 1 }, "movie")).toBeNull();
  });

  test("uses genre_ids from list results", () => {
    expect(normalizeSummary({ id: 1, name: "S", genre_ids: [18, 80], first_air_date: "2020-05-01" }, "tv")).toMatchObject({
      mediaType: "tv",
      tmdbId: 1,
      title: "S",
      year: 2020,
      genreIds: [18, 80],
    });
  });
});

describe("pickTrailer", () => {
  const v = (key: string, extra: object) => ({ site: "YouTube", key, ...extra });

  test("prefers a trailer over a teaser, and ignores featurettes and clips", () => {
    expect(
      pickTrailer([
        v("teaser", { type: "Teaser", official: true }),
        v("clip", { type: "Clip", official: true }),
        v("trailer", { type: "Trailer", official: false }),
      ]),
    ).toBe("trailer");
  });

  test("prefers official, then English, then the earliest published", () => {
    expect(pickTrailer([v("fan", { type: "Trailer", official: false }), v("official", { type: "Trailer", official: true })])).toBe(
      "official",
    );
    expect(
      pickTrailer([
        v("fr", { type: "Trailer", official: true, iso_639_1: "fr" }),
        v("en", { type: "Trailer", official: true, iso_639_1: "en" }),
      ]),
    ).toBe("en");
    expect(
      pickTrailer([
        v("rerelease", { type: "Trailer", official: true, published_at: "2024-01-01T00:00:00Z" }),
        v("original", { type: "Trailer", official: true, published_at: "1999-01-01T00:00:00Z" }),
      ]),
    ).toBe("original");
  });

  test("only YouTube videos with a key qualify", () => {
    expect(pickTrailer([{ site: "Vimeo", key: "x", type: "Trailer" }, v("", { type: "Trailer" })])).toBeNull();
    expect(pickTrailer([])).toBeNull();
  });
});

describe("normalizeProviders", () => {
  test("keeps every country, each list sorted by display priority", () => {
    const p = normalizeProviders(matrixProviders);
    expect(Object.keys(p).sort()).toEqual(["GB", "US"]);
    expect(p.US.flatrate.map((x) => x.id)).toEqual([2528]);
    expect(p.US.rent.map((x) => x.id)).toEqual([10, 2]);
    expect(p.US.buy).toEqual([{ id: 10, name: "Amazon Video", logoPath: "/amazon.png", displayPriority: 9 }]);
    expect(p.US.free).toEqual([]);
    expect(p.US.ads).toEqual([]);
    expect(p.US.link).toContain("themoviedb.org");
  });

  test("no data gives an empty map", () => {
    expect(normalizeProviders(undefined)).toEqual({});
    expect(normalizeProviders({})).toEqual({});
  });
});

test("yearOf", () => {
  expect(yearOf("1999-03-31")).toBe(1999);
  expect(yearOf("")).toBeNull();
  expect(yearOf(undefined)).toBeNull();
});

describe("normalizeRegions", () => {
  test("keeps valid codes, falls back to the code for a blank name, sorts by name", () => {
    const raw = {
      results: [
        { iso_3166_1: "US", english_name: "United States" },
        { iso_3166_1: "AD", english_name: "Andorra" },
        { iso_3166_1: "us", english_name: "lowercase" },
        { iso_3166_1: "GB", english_name: "  " },
        { english_name: "No code" },
      ],
    };
    expect(normalizeRegions(raw)).toEqual([
      { code: "AD", name: "Andorra" },
      { code: "GB", name: "GB" },
      { code: "US", name: "United States" },
    ]);
  });

  test("handles an empty or odd payload", () => {
    expect(normalizeRegions(null)).toEqual([]);
    expect(normalizeRegions({})).toEqual([]);
  });
});
