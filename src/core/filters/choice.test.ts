import { describe, expect, test } from "bun:test";
import { matchesFilters } from "../deck/build-deck";
import type { Candidate } from "../types";
import {
  DEFAULT_FILTER_CHOICE,
  ERA_CHOICES,
  GENRE_GROUPS,
  MIN_RATING_CHOICES,
  MIN_RATING_LABELS,
  describeFilterChoice,
  eraBounds,
  filterChoiceFromParams,
  filterChoiceToParams,
  genresFor,
  isDefaultFilterChoice,
  normalizeFilterChoice,
  toDeckFilters,
  type FilterChoice,
} from "./choice";

// TMDB's genre lists as /genre/movie/list and /genre/tv/list returned them on 2026-11-07.
const TMDB_MOVIE_GENRES = new Set([28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]);
const TMDB_TV_GENRES = new Set([10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37]);

const NOW = new Date("2026-11-07T12:00:00Z");

const choice = (patch: Partial<FilterChoice>): FilterChoice => ({ ...DEFAULT_FILTER_CHOICE, genres: [], ...patch });

function candidate(patch: Partial<Candidate>): Candidate {
  return {
    mediaType: "tv",
    tmdbId: 1,
    title: "T",
    year: 2024,
    genreIds: [],
    popularity: 1,
    tmdbVoteAverage: 7,
    tmdbVoteCount: 100,
    providerIds: [],
    ...patch,
  };
}

describe("GENRE_GROUPS", () => {
  test("every ID is in TMDB's list for its media type, and every genre exists for at least one type", () => {
    for (const g of GENRE_GROUPS) {
      for (const id of g.movie) expect(TMDB_MOVIE_GENRES.has(id)).toBe(true);
      for (const id of g.tv) expect(TMDB_TV_GENRES.has(id)).toBe(true);
      expect(g.movie.length + g.tv.length).toBeGreaterThan(0);
    }
  });

  test("keys are unique and labels are alphabetical", () => {
    expect(new Set(GENRE_GROUPS.map((g) => g.key)).size).toBe(GENRE_GROUPS.length);
    const labels = GENRE_GROUPS.map((g) => g.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  test("series Sci-Fi is TMDB's merged Sci-Fi & Fantasy genre", () => {
    expect(GENRE_GROUPS.find((g) => g.key === "scifi")).toMatchObject({ movie: [878], tv: [10765] });
  });
});

describe("genresFor", () => {
  test("series hides movie-only genres, movies hide series-only genres, all shows every genre", () => {
    const tv = genresFor("tv").map((g) => g.key);
    const movie = genresFor("movie").map((g) => g.key);
    expect(tv).toContain("scifi");
    expect(tv).toContain("reality");
    expect(tv).not.toContain("horror");
    expect(movie).toContain("horror");
    expect(movie).not.toContain("reality");
    expect(genresFor("all")).toHaveLength(GENRE_GROUPS.length);
  });
});

describe("eraBounds", () => {
  test("presets resolve against the current UTC year", () => {
    expect(eraBounds("any", NOW)).toBeNull();
    expect(eraBounds("recent", NOW)).toEqual({ fromYear: 2025, toYear: null });
    expect(eraBounds("last10", NOW)).toEqual({ fromYear: 2017, toYear: null });
    expect(eraBounds("y1990_2009", NOW)).toEqual({ fromYear: 1990, toYear: 2009 });
    expect(eraBounds("before1990", NOW)).toEqual({ fromYear: null, toYear: 1989 });
  });

  test("a saved preset moves with the clock", () => {
    expect(eraBounds("recent", new Date("2031-01-01T00:00:00Z"))).toEqual({ fromYear: 2030, toYear: null });
    // UTC, not the host's zone: 23:30 on Dec 31 UTC is still the old year.
    expect(eraBounds("recent", new Date("2026-12-31T23:30:00Z"))).toEqual({ fromYear: 2025, toYear: null });
  });
});

describe("toDeckFilters", () => {
  test("the default choice filters nothing", () => {
    expect(toDeckFilters(choice({}), NOW)).toEqual({});
  });

  test("the VISION test case: a modern sci-fi series on my services", () => {
    const filters = toDeckFilters(choice({ type: "tv", genres: ["scifi"], era: "last10", onMyServices: true }), NOW);
    expect(filters).toEqual({ mediaTypes: ["tv"], genreIds: [10765], era: { fromYear: 2017, toYear: null }, onMyServices: true });

    const mine = [8, 9];
    expect(matchesFilters(candidate({ genreIds: [10765, 18], year: 2022, providerIds: [8] }), filters, mine)).toBe(true);
    expect(matchesFilters(candidate({ mediaType: "movie", genreIds: [878], year: 2022, providerIds: [8] }), filters, mine)).toBe(false);
    expect(matchesFilters(candidate({ genreIds: [18], year: 2022, providerIds: [8] }), filters, mine)).toBe(false);
    expect(matchesFilters(candidate({ genreIds: [10765], year: 2010, providerIds: [8] }), filters, mine)).toBe(false);
    expect(matchesFilters(candidate({ genreIds: [10765], year: 2022, providerIds: [337] }), filters, mine)).toBe(false);
  });

  test("a genre carries the IDs of the chosen types only", () => {
    expect(toDeckFilters(choice({ type: "movie", genres: ["scifi", "action"] }), NOW).genreIds).toEqual([12, 28, 878]);
    expect(toDeckFilters(choice({ type: "tv", genres: ["scifi", "action"] }), NOW).genreIds).toEqual([10759, 10765]);
    expect(toDeckFilters(choice({ genres: ["scifi"] }), NOW)).toEqual({ genreIds: [878, 10765] });
  });

  test("genres shared by both lists and merged series genres collapse to unique IDs", () => {
    expect(toDeckFilters(choice({ genres: ["scifi", "fantasy"] }), NOW).genreIds).toEqual([14, 878, 10765]);
    expect(toDeckFilters(choice({ genres: ["comedy"] }), NOW).genreIds).toEqual([35]);
  });

  test("each minimum IMDb rating preset becomes its number, and Any adds no filter", () => {
    expect(toDeckFilters(choice({ minRating: "any" }), NOW)).toEqual({});
    expect(toDeckFilters(choice({ minRating: "7" }), NOW)).toEqual({ minImdbRating: 7 });
    expect(toDeckFilters(choice({ minRating: "7.5" }), NOW)).toEqual({ minImdbRating: 7.5 });
    expect(toDeckFilters(choice({ minRating: "8" }), NOW)).toEqual({ minImdbRating: 8 });
    expect(MIN_RATING_CHOICES).toEqual(["any", "7", "7.5", "8"]);
    for (const r of MIN_RATING_CHOICES) expect(MIN_RATING_LABELS[r]).toBeTruthy();
  });

  test("the VISION test case with a minimum: a good modern sci-fi series on my services", () => {
    const filters = toDeckFilters(choice({ type: "tv", genres: ["scifi"], era: "last10", minRating: "7.5", onMyServices: true }), NOW);
    const good = { genreIds: [10765], year: 2022, providerIds: [8] };
    expect(matchesFilters(candidate({ ...good, imdb: { rating: 7.9, votes: 40_000 } }), filters, [8])).toBe(true);
    expect(matchesFilters(candidate({ ...good, imdb: { rating: 7.1, votes: 40_000 } }), filters, [8])).toBe(false);
    expect(matchesFilters(candidate({ ...good, tmdbVoteAverage: 9 }), filters, [8])).toBe(false);
  });

  test("a genre that does not exist for the chosen type is dropped, never widened to no genre filter by accident", () => {
    // Horror has no series genre. Dropped, so the series filter stands alone.
    expect(toDeckFilters(choice({ type: "tv", genres: ["horror"] }), NOW)).toEqual({ mediaTypes: ["tv"] });
    expect(toDeckFilters(choice({ type: "tv", genres: ["horror", "drama"] }), NOW).genreIds).toEqual([18]);
  });
});

describe("normalizeFilterChoice", () => {
  test("junk falls back to the default", () => {
    for (const junk of [undefined, null, "x", 3, [], { type: "film", era: "1980s", genres: "scifi", minRating: 7.5, onMyServices: "yes" }]) {
      expect(normalizeFilterChoice(junk)).toEqual(choice({}));
    }
  });

  test("a choice saved before the minimum rating existed loads with no minimum", () => {
    expect(normalizeFilterChoice({ type: "tv", genres: ["scifi"], era: "recent", onMyServices: true })).toEqual(
      choice({ type: "tv", genres: ["scifi"], era: "recent", onMyServices: true }),
    );
    expect(normalizeFilterChoice({ minRating: "9" }).minRating).toBe("any");
    expect(normalizeFilterChoice({ minRating: "7.5" }).minRating).toBe("7.5");
  });

  test("drops unknown and duplicate genres and keeps display order", () => {
    expect(normalizeFilterChoice({ genres: ["western", "nope", "comedy", "comedy", 7] }).genres).toEqual(["comedy", "western"]);
  });

  test("returns a fresh object, never the shared default", () => {
    const c = normalizeFilterChoice(null);
    c.genres.push("drama");
    expect(DEFAULT_FILTER_CHOICE.genres).toEqual([]);
  });
});

describe("query params", () => {
  test("round trip, with defaults left out", () => {
    const c = choice({ type: "tv", genres: ["scifi", "drama"], era: "recent", minRating: "8", onMyServices: true });
    const params = filterChoiceToParams(c);
    expect(params).toEqual({ type: "tv", genre: "drama,scifi", era: "recent", imdb: "8", mine: "1" });
    expect(filterChoiceFromParams(new URLSearchParams(params))).toEqual(normalizeFilterChoice(c));
    expect(filterChoiceFromParams(params)).toEqual(normalizeFilterChoice(c));
    expect(filterChoiceToParams(choice({}))).toEqual({});
  });

  test("Next.js array values use the first, and junk is ignored", () => {
    expect(filterChoiceFromParams({ type: ["movie", "tv"], genre: "horror,,bogus", era: "soon", imdb: "9.5", mine: "true" })).toEqual(
      choice({ type: "movie", genres: ["horror"] }),
    );
    expect(filterChoiceFromParams({})).toEqual(choice({}));
  });
});

describe("describeFilterChoice and isDefaultFilterChoice", () => {
  test("labels follow the control's order", () => {
    expect(describeFilterChoice(choice({ type: "tv", genres: ["scifi"], era: "recent", minRating: "7.5", onMyServices: true }))).toEqual([
      "Series",
      "Sci-Fi",
      "Recent",
      "IMDb 7.5+",
      "My services",
    ]);
    expect(describeFilterChoice(choice({}))).toEqual([]);
  });

  test("default detection", () => {
    expect(isDefaultFilterChoice(choice({}))).toBe(true);
    for (const era of ERA_CHOICES.filter((e) => e !== "any")) expect(isDefaultFilterChoice(choice({ era }))).toBe(false);
    expect(isDefaultFilterChoice(choice({ onMyServices: true }))).toBe(false);
    for (const minRating of MIN_RATING_CHOICES.filter((r) => r !== "any")) expect(isDefaultFilterChoice(choice({ minRating }))).toBe(false);
    expect(isDefaultFilterChoice(choice({ type: "movie" }))).toBe(false);
  });
});
