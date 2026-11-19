import { describe, expect, test } from "bun:test";
import { summary } from "../deck-service/test-fakes";
import { formatTitleKey } from "../title-id";
import type { ImdbRating, TitleId } from "../types";
import { DETAILS_CAP, IMDB_FLOOR, IMDB_MIN_VOTES, MIN_TMDB_AVERAGE, MIN_TMDB_VOTES, SIMILAR_LIMIT } from "./constants";
import { finalize, shortlist, type FoundDetails, type Shortlisted } from "./rank";

const VIEWED: TitleId = { mediaType: "movie", tmdbId: 1 };
const all = () => true;
const ids = (list: readonly { summary: TitleId }[] | readonly TitleId[]) =>
  list.map((x) => ("summary" in x ? x.summary.tmdbId : x.tmdbId));

describe("shortlist", () => {
  test("keeps TMDB's order when no liked title agrees", () => {
    const recs = [10, 11, 12].map((id) => summary("movie", id));
    const out = shortlist({ viewed: VIEWED, recommendations: recs, favorites: [], visible: all });
    expect(ids(out)).toEqual([10, 11, 12]);
    expect(out.every((s) => s.because.length === 0)).toBe(true);
  });

  test("a title the user's liked titles also recommend moves up, and names them", () => {
    const recs = [10, 11, 12, 13].map((id) => summary("movie", id));
    const favorites = [
      { title: "Arrival", recommendations: [summary("movie", 13)] },
      { title: "Dune", recommendations: [summary("movie", 13), summary("movie", 12)] },
    ];
    const out = shortlist({ viewed: VIEWED, recommendations: recs, favorites, visible: all });
    // Scores: 10 = 1, 11 = 0.75, 12 = 0.5 + 0.5 (a tie with 10, which TMDB put first), 13 = 0.25 + 1.
    expect(ids(out)).toEqual([13, 10, 12, 11]);
    expect(out[0].because).toEqual(["Arrival", "Dune"]);
    expect(out[2].because).toEqual(["Dune"]);
  });

  test("drops the viewed title, titles the deck hides, filler by TMDB's numbers, and repeats across pages", () => {
    const recs = [
      summary("movie", 1),
      summary("movie", 10),
      summary("movie", 11),
      summary("movie", 12, { tmdbVoteCount: MIN_TMDB_VOTES - 1 }),
      summary("movie", 13, { tmdbVoteAverage: MIN_TMDB_AVERAGE - 0.1 }),
      summary("movie", 10),
      summary("tv", 10),
    ];
    const hidden = new Set([formatTitleKey({ mediaType: "movie", tmdbId: 11 })]);
    const out = shortlist({ viewed: VIEWED, recommendations: recs, favorites: [], visible: (t) => !hidden.has(formatTitleKey(t)) });
    expect(out.map((s) => formatTitleKey(s.summary))).toEqual(["movie:10", "tv:10"]);
  });

  test("caps the shortlist at DETAILS_CAP", () => {
    const recs = Array.from({ length: DETAILS_CAP + 10 }, (_, i) => summary("movie", 100 + i));
    expect(shortlist({ viewed: VIEWED, recommendations: recs, favorites: [], visible: all })).toHaveLength(DETAILS_CAP);
  });
});

function item(tmdbId: number, score: number, because: string[] = []): Shortlisted {
  return { summary: summary("movie", tmdbId), score, because };
}
const tt = (id: number) => `tt${id}`;
function detailsOf(entries: [number, Partial<FoundDetails>?][]): Map<string, FoundDetails> {
  return new Map(entries.map(([id, d]) => [formatTitleKey({ mediaType: "movie", tmdbId: id }), { imdbId: tt(id), ...d }]));
}
const rated = (entries: [number, number, number?][]) =>
  new Map<string, ImdbRating>(entries.map(([id, rating, votes]) => [tt(id), { rating, votes: votes ?? 50_000 }]));

describe("finalize", () => {
  test("applies the IMDb floor and its vote minimum, and drops titles with no rating or no details", () => {
    const list = [item(10, 1), item(11, 0.9), item(12, 0.8), item(13, 0.7), item(14, 0.6), item(15, 0.5)];
    const details = detailsOf([[10], [11], [12], [13, { imdbId: null }], [14]]);
    const ratings = rated([
      [10, 7],
      [11, IMDB_FLOOR - 0.1],
      [12, 8, IMDB_MIN_VOTES - 1],
      [14, IMDB_FLOOR],
    ]);
    const out = finalize(list, details, ratings);
    expect(ids(out)).toEqual([10, 14]);
    expect(out[0].imdbRating).toBe(7);
  });

  test("a better IMDb rating breaks a near tie", () => {
    const out = finalize([item(10, 1), item(11, 0.98)], detailsOf([[10], [11]]), rated([[10, IMDB_FLOOR + 0.1], [11, 9]]));
    expect(ids(out)).toEqual([11, 10]);
  });

  test("ratings unavailable: no floor, no rating shown, order kept", () => {
    const out = finalize([item(10, 1), item(11, 0.5)], detailsOf([[10], [11, { imdbId: null }]]), "unavailable");
    expect(ids(out)).toEqual([10, 11]);
    expect(out.map((t) => t.imdbRating)).toEqual([null, null]);
  });

  test("one title per franchise, the best one, while unknown franchises never collapse", () => {
    const list = [item(10, 1), item(11, 0.9), item(12, 0.8), item(13, 0.7), item(14, 0.6)];
    const details = detailsOf([[10, { collectionId: 5 }], [11, { collectionId: 5 }], [12, { collectionId: null }], [13], [14]]);
    const out = finalize(list, details, rated([10, 11, 12, 13, 14].map((id) => [id, 7] as [number, number])));
    expect(ids(out)).toEqual([10, 12, 13, 14]);
  });

  test("caps at SIMILAR_LIMIT, carries the reason and a row poster", () => {
    const list = Array.from({ length: SIMILAR_LIMIT + 5 }, (_, i) => item(100 + i, 1 - i / 100, i === 0 ? ["Arrival"] : []));
    const ids2 = list.map((s) => s.summary.tmdbId);
    const out = finalize(list, detailsOf(ids2.map((id) => [id])), rated(ids2.map((id) => [id, 7] as [number, number])));
    expect(out).toHaveLength(SIMILAR_LIMIT);
    expect(out[0]).toEqual({
      mediaType: "movie",
      tmdbId: 100,
      title: "movie 100",
      year: 2020,
      posterUrl: "https://image.tmdb.org/t/p/w185/p100.jpg",
      imdbRating: 7,
      because: ["Arrival"],
    });
  });
});
