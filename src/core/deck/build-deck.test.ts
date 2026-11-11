import { describe, expect, test } from "bun:test";
import { TITLE_STATUSES, type titleStatus } from "../../db/schema";
import { LIST_STATUSES, type Candidate, type PoolName, type UserTitleState } from "../types";
import { buildDeck, createFilterMatcher, createVisibilityCheck, interleave, matchesFilters, rowVisible, type DeckInput, type DeckResult } from "./build-deck";
import {
  BLEND_WEIGHTS,
  DEEP_CUTS_MIN_SCORE,
  FOR_YOU_MIN_RATINGS,
  SKIP_DAYS,
  VOTE_THRESHOLDS,
  skipUntilFrom,
} from "./constants";

const NOW = new Date("2026-11-06T12:00:00Z");

/** A candidate with neutral defaults. It qualifies for popular and for_you only. */
function cand(tmdbId: number, overrides: Partial<Candidate> = {}): Candidate {
  return {
    mediaType: "movie",
    tmdbId,
    title: `Title ${tmdbId}`,
    year: 2020,
    genreIds: [18],
    popularity: 10,
    tmdbVoteAverage: 6,
    tmdbVoteCount: 50,
    ...overrides,
  };
}

/** Freezes the input and everything in it, so any in-place mutation throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !(value instanceof Date) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function run(overrides: Partial<DeckInput> = {}): DeckResult {
  return buildDeck(
    deepFreeze({
      states: [],
      userProviderIds: [],
      filters: {},
      mode: "popular",
      now: NOW,
      ratedCount: 0,
      pools: {},
      ...overrides,
    }),
  );
}

/** Runs the engine and returns the dealt titles as "movie:603"-style keys. */
function keys(overrides: Partial<DeckInput> = {}): string[] {
  const result = run(overrides);
  if (result.kind !== "cards") throw new Error(`expected cards, got ${result.kind}`);
  return result.cards.map((c) => `${c.mediaType}:${c.tmdbId}`);
}

/** Every ordering of a list. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe("list exclusion (VISION invariant 3)", () => {
  const pool = [cand(1), cand(2), cand(3)];

  for (const status of ["watchlist", "passed", "seen"] as const) {
    test(`a title on ${status} never appears`, () => {
      const states: UserTitleState[] = [{ mediaType: "movie", tmdbId: 2, status }];
      expect(keys({ pools: { popular: pool }, states })).toEqual(["movie:1", "movie:3"]);
    });
  }

  test("a listed title stays out of every mode", () => {
    // Each pool holds titles that qualify for its own mode, so an empty deck can't pass for exclusion.
    const top = { imdb: { rating: 9, votes: VOTE_THRESHOLDS.imdb.topRatedMin } };
    const deep = { imdb: { rating: 8, votes: VOTE_THRESHOLDS.imdb.deepCutsMin } };
    const all = {
      popular: [cand(1), cand(2)],
      deep_cuts: [cand(3, deep), cand(4, deep)],
      top_rated: [cand(5, top), cand(6, top)],
      for_you: [cand(7), cand(8)],
    };
    const listedFirst: Record<PoolName, number> = { popular: 1, deep_cuts: 3, top_rated: 5, for_you: 7 };
    const states: UserTitleState[] = Object.values(listedFirst).map((tmdbId): UserTitleState => ({ mediaType: "movie", tmdbId, status: "seen" }));
    for (const mode of ["popular", "deep_cuts", "top_rated", "for_you"] as const) {
      expect(keys({ pools: all, states, mode, ratedCount: FOR_YOU_MIN_RATINGS })).toEqual([`movie:${listedFirst[mode] + 1}`]);
    }
    expect(keys({ pools: all, states, mode: "blend", ratedCount: FOR_YOU_MIN_RATINGS })).toEqual([
      "movie:2",
      "movie:4",
      "movie:6",
      "movie:8",
    ]);
  });

  test("exclusion uses the (media type, TMDB ID) pair: a listed movie does not hide the series with the same ID", () => {
    const states: UserTitleState[] = [{ mediaType: "movie", tmdbId: 603, status: "watchlist" }];
    const pools = { popular: [cand(603), cand(603, { mediaType: "tv" })] };
    expect(keys({ pools, states })).toEqual(["tv:603"]);
  });
});

describe("skip expiry (Alex's ruling on issue 4)", () => {
  const pools = { popular: [cand(1), cand(2)] };
  const skippedAt = (skipUntil: Date): UserTitleState[] => [
    { mediaType: "movie", tmdbId: 1, status: "skipped", skipUntil },
  ];

  test("a skipped title is hidden until its return time", () => {
    const skipUntil = new Date(NOW.getTime() + 1);
    expect(keys({ pools, states: skippedAt(skipUntil) })).toEqual(["movie:2"]);
  });

  test("a skipped title returns at exactly its return time", () => {
    expect(keys({ pools, states: skippedAt(NOW) })).toEqual(["movie:1", "movie:2"]);
  });

  test("a skipped title is in the deck after its return time", () => {
    const skipUntil = new Date(NOW.getTime() - 1);
    expect(keys({ pools, states: skippedAt(skipUntil) })).toEqual(["movie:1", "movie:2"]);
  });

  test("skipUntilFrom is SKIP_DAYS of 24 hours after now, and the card returns then", () => {
    expect(SKIP_DAYS).toBe(14);
    const skipUntil = skipUntilFrom(NOW);
    expect(skipUntil.getTime() - NOW.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    const states = skippedAt(skipUntil);
    expect(keys({ pools, states, now: new Date(skipUntil.getTime() - 1) })).toEqual(["movie:2"]);
    expect(keys({ pools, states, now: skipUntil })).toEqual(["movie:1", "movie:2"]);
  });
});

describe("filters", () => {
  test("media type keeps only the chosen types", () => {
    const pools = { popular: [cand(1), cand(2, { mediaType: "tv" })] };
    expect(keys({ pools, filters: { mediaTypes: ["tv"] } })).toEqual(["tv:2"]);
    expect(keys({ pools, filters: { mediaTypes: ["movie"] } })).toEqual(["movie:1"]);
    expect(keys({ pools, filters: { mediaTypes: ["movie", "tv"] } })).toEqual(["movie:1", "tv:2"]);
  });

  test("genre matches a title in any chosen genre", () => {
    const pools = {
      popular: [cand(1, { genreIds: [878] }), cand(2, { genreIds: [18, 35] }), cand(3, { genreIds: [27] }), cand(4, { genreIds: [] })],
    };
    expect(keys({ pools, filters: { genreIds: [878] } })).toEqual(["movie:1"]);
    expect(keys({ pools, filters: { genreIds: [878, 35] } })).toEqual(["movie:1", "movie:2"]);
  });

  test("era bounds are inclusive", () => {
    const pools = { popular: [cand(1, { year: 1999 }), cand(2, { year: 2000 }), cand(3, { year: 2010 }), cand(4, { year: 2011 })] };
    expect(keys({ pools, filters: { era: { fromYear: 2000, toYear: 2010 } } })).toEqual(["movie:2", "movie:3"]);
    expect(keys({ pools, filters: { era: { fromYear: 2010 } } })).toEqual(["movie:3", "movie:4"]);
    expect(keys({ pools, filters: { era: { toYear: 1999 } } })).toEqual(["movie:1"]);
  });

  test("an era filter excludes titles with no known year", () => {
    const pools = { popular: [cand(1, { year: null }), cand(2, { year: 2020 })] };
    expect(keys({ pools, filters: { era: { fromYear: 2000 } } })).toEqual(["movie:2"]);
    expect(keys({ pools, filters: { era: {} } })).toEqual(["movie:1", "movie:2"]);
  });

  test("a null era bound is unbounded", () => {
    const pools = { popular: [cand(1, { year: 1990 }), cand(2, { year: 2020 })] };
    expect(keys({ pools, filters: { era: { fromYear: 2015, toYear: null } } })).toEqual(["movie:2"]);
    expect(keys({ pools, filters: { era: { fromYear: null, toYear: 2000 } } })).toEqual(["movie:1"]);
    expect(keys({ pools, filters: { era: { fromYear: null, toYear: null } } })).toEqual(["movie:1", "movie:2"]);
  });

  test("empty filter fields mean no filter", () => {
    const pools = { popular: [cand(1), cand(2, { mediaType: "tv", year: null, genreIds: [] })] };
    expect(keys({ pools, filters: { mediaTypes: [], genreIds: [], era: {}, onMyServices: false } })).toEqual([
      "movie:1",
      "tv:2",
    ]);
  });

  test("filters combine: a modern sci-fi series on my services (the VISION test case)", () => {
    const pools = {
      popular: [
        cand(1, { mediaType: "tv", genreIds: [10765], year: 2022, providerIds: [8] }),
        cand(2, { mediaType: "movie", genreIds: [10765], year: 2022, providerIds: [8] }),
        cand(3, { mediaType: "tv", genreIds: [18], year: 2022, providerIds: [8] }),
        cand(4, { mediaType: "tv", genreIds: [10765], year: 1995, providerIds: [8] }),
        cand(5, { mediaType: "tv", genreIds: [10765], year: 2022, providerIds: [337] }),
      ],
    };
    const filters = { mediaTypes: ["tv" as const], genreIds: [10765], era: { fromYear: 2015 }, onMyServices: true };
    expect(keys({ pools, filters, userProviderIds: [8, 9] })).toEqual(["tv:1"]);
  });
});

describe("on my services", () => {
  const pools = {
    popular: [
      cand(1, { providerIds: [8] }),
      cand(2, { providerIds: [337, 9] }),
      cand(3, { providerIds: [337] }),
      cand(4, { providerIds: [] }),
      cand(5),
    ],
  };

  test("keeps titles on at least one of the user's services", () => {
    expect(keys({ pools, userProviderIds: [8, 9], filters: { onMyServices: true } })).toEqual(["movie:1", "movie:2"]);
  });

  test("excludes titles with unknown availability and titles streaming nowhere", () => {
    expect(keys({ pools, userProviderIds: [8, 9, 337], filters: { onMyServices: true } })).toEqual([
      "movie:1",
      "movie:2",
      "movie:3",
    ]);
  });

  test("a user with no services gets an empty deck", () => {
    expect(keys({ pools, userProviderIds: [], filters: { onMyServices: true } })).toEqual([]);
  });

  test("off, availability does not matter", () => {
    expect(keys({ pools, userProviderIds: [] })).toEqual(["movie:1", "movie:2", "movie:3", "movie:4", "movie:5"]);
  });
});

describe("minimum IMDb rating (issue 52)", () => {
  const imdb = (rating: number, votes = 5_000) => ({ imdb: { rating, votes } });
  const pools = {
    popular: [
      cand(1, imdb(8.1)),
      cand(2, imdb(7.5)),
      cand(3, imdb(7.4)),
      // No IMDb rating: TMDB maps no IMDb ID, or IMDb's dataset has no row.
      cand(4, { tmdbVoteAverage: 9.5 }),
      cand(5, imdb(6, 100_000)),
    ],
  };

  test("keeps titles rated at or above the minimum, the minimum itself included", () => {
    expect(keys({ pools, filters: { minImdbRating: 7.5 } })).toEqual(["movie:1", "movie:2"]);
    expect(keys({ pools, filters: { minImdbRating: 8 } })).toEqual(["movie:1"]);
    expect(keys({ pools, filters: { minImdbRating: 7 } })).toEqual(["movie:1", "movie:2", "movie:3"]);
  });

  test("a title with no IMDb rating fails any minimum, however high its TMDB vote average", () => {
    expect(keys({ pools, filters: { minImdbRating: 0 } })).toEqual(["movie:1", "movie:2", "movie:3", "movie:5"]);
  });

  test("judges IMDb's rating only, never TMDB's vote average", () => {
    const split = { popular: [cand(1, { ...imdb(8), tmdbVoteAverage: 5 }), cand(2, { ...imdb(6), tmdbVoteAverage: 9 })] };
    expect(keys({ pools: split, filters: { minImdbRating: 7.5 } })).toEqual(["movie:1"]);
  });

  test("a malformed IMDb rating fails the minimum, and the deck survives", () => {
    const bad = { popular: [cand(1, imdb(Number.NaN)), cand(2, { imdb: { rating: "9" as unknown as number, votes: 10 } }), cand(3, imdb(9))] };
    expect(keys({ pools: bad, filters: { minImdbRating: 7 } })).toEqual(["movie:3"]);
  });

  test("off, the IMDb rating does not matter", () => {
    expect(keys({ pools })).toEqual(["movie:1", "movie:2", "movie:3", "movie:4", "movie:5"]);
  });

  test("combines with the other filters and applies inside every mode", () => {
    const mixed = [cand(1, { ...imdb(8, 30_000), genreIds: [878] }), cand(2, { ...imdb(8, 30_000), genreIds: [18] }), cand(3, { ...imdb(7, 30_000), genreIds: [878] })];
    const filters = { genreIds: [878], minImdbRating: 7.5 };
    expect(keys({ pools: { popular: mixed }, filters })).toEqual(["movie:1"]);
    expect(keys({ mode: "top_rated", pools: { top_rated: mixed }, filters })).toEqual(["movie:1"]);
    expect(keys({ mode: "blend", pools: { popular: mixed, top_rated: mixed }, filters })).toEqual(["movie:1"]);
  });

  test("the Lists matcher applies the same rule", () => {
    const match = createFilterMatcher({ minImdbRating: 7.5 }, []);
    expect(match(cand(1, imdb(7.5)))).toBe(true);
    expect(match(cand(2, imdb(7.4)))).toBe(false);
    expect(match(cand(3))).toBe(false);
  });
});

describe("single modes", () => {
  test("popular sorts by popularity, ties keep pool order", () => {
    const pools = { popular: [cand(1, { popularity: 5 }), cand(2, { popularity: 50 }), cand(3, { popularity: 20 }), cand(4, { popularity: 20 })] };
    expect(keys({ pools, mode: "popular" })).toEqual(["movie:2", "movie:3", "movie:4", "movie:1"]);
  });

  test("a single mode uses only its own pool", () => {
    const pools = { popular: [cand(1)], for_you: [cand(2)] };
    expect(keys({ pools, mode: "popular", ratedCount: FOR_YOU_MIN_RATINGS })).toEqual(["movie:1"]);
  });

  test("top rated sorts by IMDb rating, falling back to TMDB vote average without IMDb data", () => {
    const imdbMin = VOTE_THRESHOLDS.imdb.topRatedMin;
    const tmdbMin = VOTE_THRESHOLDS.tmdb.topRatedMin;
    const pools = {
      top_rated: [
        cand(1, { imdb: { rating: 7.5, votes: imdbMin }, tmdbVoteAverage: 9.9, tmdbVoteCount: tmdbMin }),
        cand(2, { imdb: { rating: 8.8, votes: imdbMin * 10 }, tmdbVoteCount: tmdbMin }),
        cand(3, { tmdbVoteAverage: 8.0, tmdbVoteCount: tmdbMin }),
      ],
    };
    expect(keys({ pools, mode: "top_rated" })).toEqual(["movie:2", "movie:3", "movie:1"]);
  });

  test("top rated breaks equal IMDb ratings by TMDB vote average", () => {
    const imdb = { rating: 8.0, votes: VOTE_THRESHOLDS.imdb.topRatedMin };
    const pools = {
      top_rated: [cand(1, { imdb, tmdbVoteAverage: 7.0 }), cand(2, { imdb, tmdbVoteAverage: 7.8 })],
    };
    expect(keys({ pools, mode: "top_rated" })).toEqual(["movie:2", "movie:1"]);
  });

  test("the vote tiebreak compares like with like", () => {
    const imdbMin = VOTE_THRESHOLDS.imdb.topRatedMin;
    // Both IMDb: more IMDb votes wins, whatever the TMDB counts say.
    const bothImdb = {
      top_rated: [
        cand(1, { imdb: { rating: 8, votes: imdbMin }, tmdbVoteAverage: 7, tmdbVoteCount: 5_000 }),
        cand(2, { imdb: { rating: 8, votes: imdbMin * 4 }, tmdbVoteAverage: 7, tmdbVoteCount: 100 }),
      ],
    };
    expect(keys({ pools: bothImdb, mode: "top_rated" })).toEqual(["movie:2", "movie:1"]);
    // No IMDb votes sorts after any IMDb votes. Between two titles without IMDb data, more TMDB votes wins.
    const noImdb = {
      top_rated: [
        cand(3, { tmdbVoteAverage: 8, tmdbVoteCount: 2_000 }),
        cand(4, { tmdbVoteAverage: 8, tmdbVoteCount: 5_000 }),
        cand(5, { imdb: { rating: 8, votes: imdbMin }, tmdbVoteAverage: 8, tmdbVoteCount: 1_000 }),
      ],
    };
    expect(keys({ pools: noImdb, mode: "top_rated" })).toEqual(["movie:5", "movie:4", "movie:3"]);
  });

  test("tied titles sort the same from every input order (the round-2 cycle)", () => {
    // Tied on score and TMDB average. The old tiebreak made A > B > C > A.
    const imdbMin = VOTE_THRESHOLDS.imdb.topRatedMin;
    const a = cand(1, { imdb: { rating: 8, votes: imdbMin * 4 }, tmdbVoteAverage: 8, tmdbVoteCount: 1_000 });
    const b = cand(2, { imdb: { rating: 8, votes: imdbMin * 2 }, tmdbVoteAverage: 8, tmdbVoteCount: 3_000 });
    const c = cand(3, { tmdbVoteAverage: 8, tmdbVoteCount: 2_000 });
    for (const order of permutations([a, b, c])) {
      expect(keys({ pools: { top_rated: order }, mode: "top_rated" })).toEqual(["movie:1", "movie:2", "movie:3"]);
    }
  });

  test("titles tied on every signal sort by title key, from every input order", () => {
    const tie = { imdb: { rating: 8, votes: VOTE_THRESHOLDS.imdb.deepCutsMin }, tmdbVoteAverage: 8, tmdbVoteCount: 500 };
    const titles = [cand(30, tie), cand(4, tie), cand(4, { ...tie, mediaType: "tv" })];
    for (const order of permutations(titles)) {
      expect(keys({ pools: { deep_cuts: order }, mode: "deep_cuts" })).toEqual(["movie:30", "movie:4", "tv:4"]);
    }
  });

  test("top rated gates on votes from the same source as the rating", () => {
    const { imdb, tmdb } = VOTE_THRESHOLDS;
    const pools = {
      top_rated: [
        cand(1, { imdb: { rating: 9.5, votes: imdb.topRatedMin - 1 }, tmdbVoteCount: 100_000 }),
        cand(2, { imdb: { rating: 8.0, votes: imdb.topRatedMin } }),
        cand(3, { tmdbVoteAverage: 9.0, tmdbVoteCount: tmdb.topRatedMin - 1 }),
        cand(4, { tmdbVoteAverage: 8.5, tmdbVoteCount: tmdb.topRatedMin }),
      ],
    };
    expect(keys({ pools, mode: "top_rated" })).toEqual(["movie:4", "movie:2"]);
  });

  test("deep cuts keeps good titles in the low-vote band, best first", () => {
    const { imdb, tmdb } = VOTE_THRESHOLDS;
    const pools = {
      deep_cuts: [
        cand(1, { imdb: { rating: 7.2, votes: imdb.deepCutsMin } }), // at the band floor: in
        cand(2, { imdb: { rating: 8.4, votes: imdb.topRatedMin - 1 } }), // just under the ceiling: in
        cand(3, { imdb: { rating: 9.0, votes: imdb.topRatedMin } }), // at the ceiling: top rated, not a deep cut
        cand(4, { imdb: { rating: 9.0, votes: imdb.deepCutsMin - 1 } }), // too few votes to trust
        cand(5, { imdb: { rating: DEEP_CUTS_MIN_SCORE - 0.1, votes: 5_000 } }), // obscure but not good
        cand(6, { imdb: { rating: DEEP_CUTS_MIN_SCORE, votes: 5_000 } }), // exactly at the quality floor: in
        cand(7, { tmdbVoteAverage: 7.9, tmdbVoteCount: tmdb.deepCutsMin }), // no IMDb data: TMDB band
        cand(8, { tmdbVoteAverage: 9.0, tmdbVoteCount: tmdb.topRatedMin }), // TMDB ceiling: out
        cand(9, { tmdbVoteAverage: 9.0, tmdbVoteCount: tmdb.deepCutsMin - 1 }), // under the TMDB floor: out
      ],
    };
    expect(keys({ pools, mode: "deep_cuts" })).toEqual(["movie:2", "movie:7", "movie:1", "movie:6"]);
  });

  test("for you keeps the order it was given", () => {
    const pools = { for_you: [cand(3, { popularity: 1 }), cand(1, { popularity: 99 }), cand(2)] };
    expect(keys({ pools, mode: "for_you", ratedCount: FOR_YOU_MIN_RATINGS })).toEqual(["movie:3", "movie:1", "movie:2"]);
  });

  test("a single pool with a duplicate deals the title once", () => {
    const pools = { for_you: [cand(1), cand(2), cand(1)] };
    expect(keys({ pools, mode: "for_you", ratedCount: FOR_YOU_MIN_RATINGS })).toEqual(["movie:1", "movie:2"]);
  });
});

describe("for you lock", () => {
  const pools = { for_you: [cand(1), cand(2)] };

  test("locked one rating short of the threshold, even with a full pool", () => {
    expect(run({ pools, mode: "for_you", ratedCount: FOR_YOU_MIN_RATINGS - 1 })).toEqual({
      kind: "locked",
      mode: "for_you",
      ratedCount: FOR_YOU_MIN_RATINGS - 1,
      required: FOR_YOU_MIN_RATINGS,
      remaining: 1,
    });
  });

  test("locked with no ratings at all", () => {
    expect(run({ pools, mode: "for_you", ratedCount: 0 })).toMatchObject({ kind: "locked", remaining: FOR_YOU_MIN_RATINGS });
  });

  test("unlocked at the threshold", () => {
    expect(keys({ pools, mode: "for_you", ratedCount: FOR_YOU_MIN_RATINGS })).toEqual(["movie:1", "movie:2"]);
  });

  test("unlocked with an empty pool is an empty deck, not a lock", () => {
    expect(run({ pools: {}, mode: "for_you", ratedCount: FOR_YOU_MIN_RATINGS })).toEqual({ kind: "cards", cards: [] });
  });
});

describe("blend (Alex's ruling on issue 5)", () => {
  // Each pool's titles qualify for that pool's own mode.
  const top = (id: number, rating: number) => cand(id, { imdb: { rating, votes: VOTE_THRESHOLDS.imdb.topRatedMin } });
  const deep = (id: number, rating: number) => cand(id, { imdb: { rating, votes: VOTE_THRESHOLDS.imdb.deepCutsMin } });
  const pools = {
    popular: [cand(11, { popularity: 3 }), cand(12, { popularity: 2 }), cand(13, { popularity: 1 })],
    deep_cuts: [deep(21, 8), deep(22, 7.5), deep(23, 7)],
    top_rated: [top(31, 9), top(32, 8.5), top(33, 8)],
    for_you: [cand(41), cand(42), cand(43)],
  };

  test("the weights are even", () => {
    expect(Object.values(BLEND_WEIGHTS).every((w) => w === 1)).toBe(true);
  });

  test("before for you unlocks, popular, deep cuts, and top rated take equal turns", () => {
    expect(keys({ pools, mode: "blend", ratedCount: FOR_YOU_MIN_RATINGS - 1 })).toEqual(
      ["11", "21", "31", "12", "22", "32", "13", "23", "33"].map((id) => `movie:${id}`),
    );
  });

  test("once unlocked, for you joins as an equal fourth", () => {
    expect(keys({ pools, mode: "blend", ratedCount: FOR_YOU_MIN_RATINGS })).toEqual(
      ["11", "21", "31", "41", "12", "22", "32", "42", "13", "23", "33", "43"].map((id) => `movie:${id}`),
    );
  });

  test("blend never returns a lock", () => {
    expect(run({ pools, mode: "blend", ratedCount: 0 }).kind).toBe("cards");
  });

  test("each pool is ordered by its own signal before interleaving", () => {
    const shuffled = {
      popular: [cand(13, { popularity: 1 }), cand(11, { popularity: 3 })],
      deep_cuts: [deep(22, 7.5), deep(21, 8)],
      top_rated: [top(32, 8.5), top(31, 9)],
    };
    expect(keys({ pools: shuffled, mode: "blend" })).toEqual(
      ["11", "21", "31", "13", "22", "32"].map((id) => `movie:${id}`),
    );
  });

  test("a duplicate across pools appears once, at its first turn, and does not cost the later pool its turn", () => {
    const shared = cand(99, { popularity: 100, imdb: { rating: 9.9, votes: VOTE_THRESHOLDS.imdb.topRatedMin } });
    const result = run({
      mode: "blend",
      pools: { popular: [shared, cand(11)], top_rated: [shared, top(31, 9)] },
    });
    if (result.kind !== "cards") throw new Error("expected cards");
    expect(result.cards.map((c) => [c.tmdbId, c.source])).toEqual([
      [99, "popular"],
      [31, "top_rated"],
      [11, "popular"],
    ]);
  });

  test("dedupe uses the (media type, TMDB ID) pair: a movie and a series with the same ID both appear", () => {
    const pools = { popular: [cand(603)], top_rated: [top(603, 9), { ...top(603, 9), mediaType: "tv" as const }] };
    expect(keys({ pools, mode: "blend" })).toEqual(["movie:603", "tv:603"]);
  });

  test("an exhausted pool drops out and the others keep turning", () => {
    const uneven = {
      popular: [cand(11, { popularity: 3 }), cand(12, { popularity: 2 }), cand(13, { popularity: 1 })],
      deep_cuts: [deep(21, 8)],
      top_rated: [],
    };
    expect(keys({ pools: uneven, mode: "blend" })).toEqual(["movie:11", "movie:21", "movie:12", "movie:13"]);
  });

  test("filters and list exclusion apply inside the blend", () => {
    const states: UserTitleState[] = [{ mediaType: "movie", tmdbId: 21, status: "passed" }];
    const withSeries = { ...pools, popular: [cand(10, { mediaType: "tv", popularity: 99 }), ...pools.popular] };
    expect(keys({ pools: withSeries, mode: "blend", states }).slice(0, 3)).toEqual(["tv:10", "movie:22", "movie:31"]);
    const filtered = keys({ pools: withSeries, mode: "blend", states, filters: { mediaTypes: ["movie"] } });
    expect(filtered).not.toContain("tv:10");
    expect(filtered).not.toContain("movie:21");
    expect(filtered.slice(0, 3)).toEqual(["movie:11", "movie:22", "movie:31"]);
  });

  test("source tags each card with its pool", () => {
    const result = run({ pools, mode: "blend", ratedCount: FOR_YOU_MIN_RATINGS });
    if (result.kind !== "cards") throw new Error("expected cards");
    const sources: PoolName[] = result.cards.slice(0, 4).map((c) => c.source);
    expect(sources).toEqual(["popular", "deep_cuts", "top_rated", "for_you"]);
  });
});

describe("blend weights", () => {
  const a = [1, 2, 3];
  const b = [11, 12, 13];
  const key = (n: number) => String(n);

  test("a weight of 2 gives that pool two cards per round", () => {
    expect(interleave([a, b], [2, 1], key)).toEqual([1, 2, 11, 3, 12, 13]);
  });

  test("a weight of 0 leaves that pool out", () => {
    expect(interleave([a, b], [0, 1], key)).toEqual([11, 12, 13]);
  });

  test("fractional, negative, and non-numeric weights throw, as does a missing weight", () => {
    for (const bad of [0.5, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => interleave([a, b], [1, bad], key)).toThrow(RangeError);
    }
    expect(() => interleave([a, b], [1], key)).toThrow(RangeError);
  });

  test("the shipped weights are all valid", () => {
    const weights = Object.values(BLEND_WEIGHTS);
    expect(weights.every((w) => Number.isInteger(w) && w >= 0)).toBe(true);
    expect(() => interleave([a, b, a, b], weights, key)).not.toThrow();
  });
});

describe("malformed rows", () => {
  test("a candidate with a bad media type or ID is skipped, and the rest of the deck survives", () => {
    const bad = [
      cand(0),
      cand(-5),
      cand(1.5),
      { ...cand(7), mediaType: "person" } as unknown as Candidate,
    ];
    expect(keys({ pools: { popular: [cand(1), ...bad, cand(2)] } })).toEqual(["movie:1", "movie:2"]);
    expect(keys({ mode: "blend", pools: { popular: [...bad, cand(1)], for_you: bad } })).toEqual(["movie:1"]);
  });

  test("a state row with a bad ID is ignored", () => {
    const states = [
      { mediaType: "movie", tmdbId: 0, status: "seen" },
      { mediaType: "person", tmdbId: 1, status: "seen" },
    ] as unknown as UserTitleState[];
    expect(keys({ pools: { popular: [cand(1)] }, states })).toEqual(["movie:1"]);
  });

  test("skipUntil as an ISO string works like a Date", () => {
    const pools = { popular: [cand(1), cand(2)] };
    const skipped = (skipUntil: string): UserTitleState[] => [{ mediaType: "movie", tmdbId: 1, status: "skipped", skipUntil }];
    expect(keys({ pools, states: skipped(new Date(NOW.getTime() + 1).toISOString()) })).toEqual(["movie:2"]);
    expect(keys({ pools, states: skipped(NOW.toISOString()) })).toEqual(["movie:1", "movie:2"]);
  });

  test("a skipUntil that does not parse keeps the title hidden", () => {
    const pools = { popular: [cand(1), cand(2)] };
    for (const skipUntil of ["not a date", "", new Date(Number.NaN)]) {
      const states: UserTitleState[] = [{ mediaType: "movie", tmdbId: 1, status: "skipped", skipUntil }];
      expect(keys({ pools, states })).toEqual(["movie:2"]);
    }
  });

  test("a skipped row with a null, missing, or numeric skipUntil keeps the title hidden", () => {
    const pools = { popular: [cand(1), cand(2)] };
    for (const skipUntil of [null, undefined, 0]) {
      const states = [{ mediaType: "movie", tmdbId: 1, status: "skipped", skipUntil }] as unknown as UserTitleState[];
      expect(keys({ pools, states })).toEqual(["movie:2"]);
    }
  });

  test("an unknown mode throws a clear error", () => {
    expect(() => run({ mode: "bogus" as unknown as DeckInput["mode"] })).toThrow(/unknown discovery mode "bogus"/);
  });
});

describe("matchesFilters (shared with the Lists screens)", () => {
  test("applies the same rules as the deck", () => {
    const filters = { mediaTypes: ["tv" as const], genreIds: [10765], era: { fromYear: 2015 }, onMyServices: true };
    expect(matchesFilters(cand(1, { mediaType: "tv", genreIds: [10765], year: 2022, providerIds: [8] }), filters, [8])).toBe(true);
    expect(matchesFilters(cand(1, { mediaType: "tv", genreIds: [10765], year: 2022, providerIds: [8] }), filters, [9])).toBe(false);
    expect(matchesFilters(cand(1, { mediaType: "movie", genreIds: [10765], year: 2022, providerIds: [8] }), filters, [8])).toBe(false);
    expect(matchesFilters(cand(1), {}, [])).toBe(true);
  });
});

describe("status constants", () => {
  test("list statuses are every status but skipped", () => {
    expect(TITLE_STATUSES.filter((s) => s !== "skipped")).toEqual([...LIST_STATUSES]);
  });
});

describe("empty input", () => {
  for (const mode of ["blend", "popular", "deep_cuts", "top_rated", "for_you"] as const) {
    test(`${mode} with no pools gives an empty deck`, () => {
      expect(run({ mode, pools: {}, ratedCount: FOR_YOU_MIN_RATINGS })).toEqual({ kind: "cards", cards: [] });
    });
    test(`${mode} with empty pools gives an empty deck`, () => {
      const pools = { popular: [], deep_cuts: [], top_rated: [], for_you: [] };
      expect(run({ mode, pools, ratedCount: FOR_YOU_MIN_RATINGS })).toEqual({ kind: "cards", cards: [] });
    });
  }

  test("a deck where every title is already listed is empty", () => {
    const states: UserTitleState[] = [
      { mediaType: "movie", tmdbId: 1, status: "seen" },
      { mediaType: "movie", tmdbId: 2, status: "watchlist" },
    ];
    expect(keys({ pools: { popular: [cand(1), cand(2)] }, states })).toEqual([]);
  });
});

describe("purity", () => {
  test("never mutates its input (all input is frozen) and gives the same output for the same input", () => {
    const input: DeckInput = {
      states: [{ mediaType: "movie", tmdbId: 2, status: "skipped", skipUntil: skipUntilFrom(NOW) }],
      userProviderIds: [8],
      filters: { genreIds: [18] },
      mode: "blend",
      now: NOW,
      ratedCount: FOR_YOU_MIN_RATINGS,
      pools: {
        popular: [cand(3, { popularity: 1 }), cand(1, { popularity: 9 }), cand(2)],
        top_rated: [cand(5, { imdb: { rating: 8, votes: 30_000 } }), cand(4, { imdb: { rating: 9, votes: 30_000 } })],
        for_you: [cand(6), cand(1)],
      },
    };
    const before = JSON.stringify(input);
    const first = run(input);
    const second = run(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("hardening: bad input fails closed or throws (issue 20)", () => {
  const imdbMin = VOTE_THRESHOLDS.imdb.topRatedMin;

  test("a NaN score sorts last and the order no longer depends on pool order (item 1, the PR 13 repro)", () => {
    const votes = 30_000;
    const titles = [cand(3, { imdb: { rating: 9, votes } }), cand(2, { imdb: { rating: Number.NaN, votes } }), cand(1, { imdb: { rating: 5, votes } })];
    for (const order of permutations(titles)) {
      expect(keys({ pools: { top_rated: order }, mode: "top_rated" })).toEqual(["movie:3", "movie:1", "movie:2"]);
    }
  });

  test("NaN or infinite tiebreak signals sort last without breaking the total order (item 1)", () => {
    const imdb = { rating: 8, votes: imdbMin };
    const titles = [
      cand(1, { imdb, tmdbVoteAverage: Number.NaN }),
      cand(2, { imdb, tmdbVoteAverage: 7 }),
      cand(3, { imdb: { rating: Number.POSITIVE_INFINITY, votes: imdbMin } }),
    ];
    for (const order of permutations(titles)) {
      expect(keys({ pools: { top_rated: order }, mode: "top_rated" })).toEqual(["movie:2", "movie:1", "movie:3"]);
    }
  });

  test("NaN votes fail every vote threshold, and a NaN score is never a deep cut (item 1)", () => {
    const pools = {
      top_rated: [cand(1, { imdb: { rating: 9, votes: Number.NaN } }), cand(2, { imdb: { rating: 9, votes: imdbMin } })],
      deep_cuts: [
        cand(3, { imdb: { rating: Number.NaN, votes: 5_000 } }),
        cand(4, { imdb: { rating: 8, votes: Number.NaN } }),
        cand(5, { imdb: { rating: 8, votes: 5_000 } }),
      ],
    };
    expect(keys({ pools, mode: "top_rated" })).toEqual(["movie:2"]);
    expect(keys({ pools, mode: "deep_cuts" })).toEqual(["movie:5"]);
  });

  test("a NaN popularity sorts last, from every input order (item 1)", () => {
    const titles = [cand(1, { popularity: 5 }), cand(2, { popularity: Number.NaN }), cand(3, { popularity: 9 })];
    for (const order of permutations(titles)) {
      expect(keys({ pools: { popular: order } })).toEqual(["movie:3", "movie:1", "movie:2"]);
    }
  });

  test("an invalid now throws a RangeError instead of letting every skipped title back in (item 2)", () => {
    const states: UserTitleState[] = [{ mediaType: "movie", tmdbId: 1, status: "skipped", skipUntil: skipUntilFrom(NOW) }];
    for (const now of [new Date(Number.NaN), NOW.toISOString(), NOW.getTime(), undefined, null]) {
      expect(() => run({ pools: { popular: [cand(1)] }, states, now: now as unknown as Date })).toThrow(RangeError);
      expect(() => run({ mode: "for_you", now: now as unknown as Date })).toThrow(/now must be a valid Date/);
    }
  });

  test("a candidate with genreIds or year missing fails the filter that needs it, and the deck survives (item 3)", () => {
    const noGenres = { ...cand(1), genreIds: undefined } as unknown as Candidate;
    const noYear = { ...cand(2), year: undefined } as unknown as Candidate;
    const nanYear = cand(3, { year: Number.NaN });
    const badProviders = { ...cand(4), providerIds: "8" } as unknown as Candidate;
    const pools = { popular: [noGenres, noYear, nanYear, badProviders, cand(5, { providerIds: [8] })] };

    expect(keys({ pools, filters: { genreIds: [18] } })).toEqual(["movie:2", "movie:3", "movie:4", "movie:5"]);
    expect(keys({ pools, filters: { era: { fromYear: 2000 } } })).toEqual(["movie:1", "movie:4", "movie:5"]);
    expect(keys({ pools, filters: { era: { toYear: 2100 } } })).toEqual(["movie:1", "movie:4", "movie:5"]);
    expect(keys({ pools, filters: { onMyServices: true }, userProviderIds: [8] })).toEqual(["movie:5"]);
    // With no filter that needs the field, the missing field does not matter.
    expect(keys({ pools })).toEqual(["movie:1", "movie:2", "movie:3", "movie:4", "movie:5"]);
    // The Lists screens share the same rules.
    expect(matchesFilters(noGenres, { genreIds: [18] }, [])).toBe(false);
    expect(matchesFilters(noYear, { era: { fromYear: 2000 } }, [])).toBe(false);
    expect(matchesFilters(badProviders, { onMyServices: true }, [8])).toBe(false);
  });

  test("a ratedCount that is not a whole number, 0 or more, throws a RangeError (item 4)", () => {
    for (const ratedCount of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, "3", undefined]) {
      for (const mode of ["for_you", "blend", "popular"] as const) {
        expect(() => run({ mode, ratedCount: ratedCount as unknown as number })).toThrow(RangeError);
      }
    }
    expect(run({ mode: "for_you", ratedCount: 0 })).toMatchObject({ kind: "locked", remaining: FOR_YOU_MIN_RATINGS });
  });

  test("a skipUntil string without an explicit offset keeps the title hidden (item 5)", () => {
    const pools = { popular: [cand(1), cand(2)] };
    const skipped = (skipUntil: string): UserTitleState[] => [{ mediaType: "movie", tmdbId: 1, status: "skipped", skipUntil }];
    // A day before NOW in every time zone, but with no offset it is ambiguous, so it does not count.
    for (const skipUntil of ["2026-11-05T12:00:00", "2026-11-05T12:00", "2026-11-05", "2026-11-05 12:00:00+00"]) {
      expect(keys({ pools, states: skipped(skipUntil) })).toEqual(["movie:2"]);
    }
    // Explicit offsets work, including Postgres row_to_json's microseconds.
    expect(keys({ pools, states: skipped("2026-11-06T11:59:59.123456+00:00") })).toEqual(["movie:1", "movie:2"]);
    expect(keys({ pools, states: skipped("2026-11-06T13:30:00+02:00") })).toEqual(["movie:1", "movie:2"]);
    expect(keys({ pools, states: skipped("2026-11-06T12:00:00.5-01:00") })).toEqual(["movie:2"]);
    expect(keys({ pools, states: skipped("2026-11-06T12:00:01Z") })).toEqual(["movie:2"]);
  });

  test("raw Drizzle title_status rows go straight in, with no mapping (item 6)", () => {
    type TitleStatusRow = typeof titleStatus.$inferSelect;
    const row = (o: Partial<TitleStatusRow>): TitleStatusRow => ({
      userId: "user-1",
      mediaType: "movie",
      tmdbId: 1,
      status: "watchlist",
      rating: null,
      review: null,
      reviewVisibility: "private",
      skipUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...o,
    });
    const rows: TitleStatusRow[] = [
      row({ tmdbId: 1, status: "seen", rating: 4 }),
      row({ tmdbId: 2, status: "skipped", skipUntil: new Date(NOW.getTime() + 1) }),
      row({ tmdbId: 3, status: "skipped", skipUntil: new Date(NOW.getTime() - 1) }),
      row({ tmdbId: 4, status: "skipped", skipUntil: null }), // breaks the schema check: stays hidden
      row({ tmdbId: 5, status: "passed" }),
    ];
    // The assignment is the test: it compiles only if a raw row fits UserTitleState.
    const states: readonly UserTitleState[] = rows;
    const pools = { popular: [1, 2, 3, 4, 5, 6].map((id) => cand(id)) };
    expect(keys({ pools, states })).toEqual(["movie:3", "movie:6"]);
  });

  test("listed statuses hide whatever skipUntil says, and an unknown status fails closed (item 7)", () => {
    const past = new Date(NOW.getTime() - 1);
    const states = [
      ...LIST_STATUSES.map((status, i) => ({ mediaType: "movie", tmdbId: i + 1, status, skipUntil: past })),
      { mediaType: "movie", tmdbId: 9, status: "bogus", skipUntil: past },
    ] as unknown as UserTitleState[];
    const pools = { popular: [1, 2, 3, 9, 10].map((id) => cand(id)) };
    expect(keys({ pools, states })).toEqual(["movie:10"]);
  });

  test("createFilterMatcher builds the provider set once and agrees with matchesFilters (item 8)", () => {
    const providerIds = [8];
    const filters = { onMyServices: true };
    const matches = createFilterMatcher(filters, providerIds);
    const titles = [cand(1, { providerIds: [8] }), cand(2, { providerIds: [9] }), cand(3)];
    expect(titles.map(matches)).toEqual([true, false, false]);
    expect(titles.map((t) => matchesFilters(t, filters, providerIds))).toEqual([true, false, false]);
    // The set is a snapshot taken when the matcher was built, not rebuilt per call.
    providerIds.push(9);
    expect(titles.map(matches)).toEqual([true, false, false]);
  });
});

describe("createVisibilityCheck (shared with the deck service)", () => {
  test("hides exactly what buildDeck hides", () => {
    const states: UserTitleState[] = [
      { mediaType: "movie", tmdbId: 1, status: "watchlist" },
      { mediaType: "movie", tmdbId: 2, status: "skipped", skipUntil: new Date(NOW.getTime() + 1) },
      { mediaType: "movie", tmdbId: 3, status: "skipped", skipUntil: NOW },
      { mediaType: "movie", tmdbId: 4, status: "skipped", skipUntil: "not a date" },
    ];
    const visible = createVisibilityCheck(states, NOW);
    const titles = [1, 2, 3, 4, 5].map((id) => cand(id)).concat([cand(1, { mediaType: "tv" })]);
    expect(titles.filter(visible).map((c) => `${c.mediaType}:${c.tmdbId}`)).toEqual(
      keys({ pools: { popular: titles }, states }),
    );
    expect(visible({ mediaType: "person", tmdbId: 9 })).toBe(false);
  });
});

describe("rowVisible (one title, the same rule)", () => {
  const ref = { mediaType: "movie", tmdbId: 1 } as const;
  test("no row is visible, a list status is not", () => {
    expect(rowVisible(ref, null, NOW)).toBe(true);
    for (const status of ["watchlist", "passed", "seen"] as const) expect(rowVisible(ref, { status }, NOW)).toBe(false);
  });
  test("a skip hides until its return time, and fails closed without one", () => {
    expect(rowVisible(ref, { status: "skipped", skipUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(false);
    expect(rowVisible(ref, { status: "skipped", skipUntil: NOW }, NOW)).toBe(true);
    expect(rowVisible(ref, { status: "skipped", skipUntil: NOW.toISOString() }, NOW)).toBe(true);
    expect(rowVisible(ref, { status: "skipped", skipUntil: null }, NOW)).toBe(false);
  });
});

describe("buildDeck: a shuffle seed", () => {
  const keys = (r: DeckResult) => {
    if (r.kind !== "cards") throw new Error("expected cards");
    return r.cards.map((c) => `${c.mediaType}:${c.tmdbId}`);
  };
  const popular = Array.from({ length: 20 }, (_, i) => cand(i + 1, { popularity: 100 - i }));

  test("deals the same titles as the ranked deck, in another order", () => {
    const ranked = keys(run({ pools: { popular } }));
    const shuffled = keys(run({ pools: { popular }, seed: "s1" }));
    expect(ranked).toEqual(popular.map((c) => `movie:${c.tmdbId}`));
    expect([...shuffled].sort()).toEqual([...ranked].sort());
    expect(shuffled).not.toEqual(ranked);
  });

  test("the same seed gives the same deck, whatever order the pool arrived in, and a new seed gives a new one", () => {
    const a = keys(run({ pools: { popular }, seed: "s1" }));
    expect(keys(run({ pools: { popular }, seed: "s1" }))).toEqual(a);
    expect(keys(run({ pools: { popular: [...popular].reverse() }, seed: "s1" }))).toEqual(a);
    expect(keys(run({ pools: { popular }, seed: "s2" }))).not.toEqual(a);
  });

  test("null or no seed is the ranked deck", () => {
    const ranked = keys(run({ pools: { popular } }));
    expect(keys(run({ pools: { popular }, seed: null }))).toEqual(ranked);
    expect(keys(run({ pools: { popular }, seed: undefined }))).toEqual(ranked);
  });

  test("each pool keeps its gate: top rated still needs the votes, and a deep cut its band and score", () => {
    const imdb = VOTE_THRESHOLDS.imdb;
    const pool = [
      cand(1, { imdb: { rating: 9, votes: imdb.topRatedMin } }),
      cand(2, { imdb: { rating: 9, votes: imdb.topRatedMin - 1 } }),
      cand(3, { imdb: { rating: DEEP_CUTS_MIN_SCORE, votes: imdb.deepCutsMin } }),
      cand(4, { imdb: { rating: DEEP_CUTS_MIN_SCORE - 0.1, votes: imdb.deepCutsMin } }),
      cand(5, { imdb: { rating: 9, votes: imdb.deepCutsMin - 1 } }),
    ];
    for (const seed of ["s1", "s2", "s3"]) {
      expect(keys(run({ mode: "top_rated", pools: { top_rated: pool }, seed }))).toEqual(["movie:1"]);
      expect(keys(run({ mode: "deep_cuts", pools: { deep_cuts: pool }, seed })).sort()).toEqual(["movie:2", "movie:3"]);
    }
  });

  test("still hides listed titles and applies the filters", () => {
    const pool = [cand(1), cand(2), cand(3, { year: 1990 }), cand(4)];
    const out = keys(
      run({
        pools: { popular: pool },
        states: [{ mediaType: "movie", tmdbId: 2, status: "passed" }],
        filters: { era: { fromYear: 2000 } },
        seed: "s1",
      }),
    );
    expect([...out].sort()).toEqual(["movie:1", "movie:4"]);
  });

  test("the blend still deals each title once and keeps its pools taking turns", () => {
    const shared = Array.from({ length: 6 }, (_, i) => cand(i + 1, { imdb: { rating: 8, votes: VOTE_THRESHOLDS.imdb.topRatedMin } }));
    const result = run({ mode: "blend", pools: { popular: shared, top_rated: shared }, seed: "s1" });
    if (result.kind !== "cards") throw new Error("expected cards");
    expect(keys(result).sort()).toEqual(shared.map((c) => `movie:${c.tmdbId}`).sort());
    // Both pools hold the same shuffled list, so each title is dealt by whichever pool reaches it first: popular leads.
    expect(result.cards[0].source).toBe("popular");
  });

  test("a seed that is not 1 to 32 URL-safe characters throws", () => {
    for (const seed of ["", "a|b", "x".repeat(33), 7 as unknown as string]) {
      expect(() => run({ pools: { popular }, seed })).toThrow(RangeError);
    }
  });
});
