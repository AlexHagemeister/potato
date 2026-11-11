// Fakes for deck-service tests: a TMDB client and library that answer from
// tables and record every call. No network, no database.

import { MemoryRatingsStore } from "../imdb/ratings";
import { TmdbError } from "../tmdb/http";
import { ok, type Result } from "../result";
import type { CountryProviders, TitleDetails, TitleSummary } from "../tmdb/types";
import { formatTitleKey } from "../title-id";
import type { ImdbRating, MediaType, TitleId, UserTitleState } from "../types";
import { createDeckService, type DeckLibrary, type DeckTmdb } from "./service";
import type { CardUserState, DeckStats } from "./types";

export const NOW = new Date("2026-11-07T12:00:00Z");

/** A list result. Popular by default, with TMDB numbers that pass every pool's own gate unless overridden. */
export function summary(mediaType: MediaType, tmdbId: number, overrides: Partial<TitleSummary> = {}): TitleSummary {
  return {
    mediaType,
    tmdbId,
    title: `${mediaType} ${tmdbId}`,
    year: 2020,
    genreIds: [18],
    popularity: 1000 - tmdbId,
    tmdbVoteAverage: 7.5,
    tmdbVoteCount: 500,
    posterPath: `/p${tmdbId}.jpg`,
    overview: `About ${mediaType} ${tmdbId}.`,
    ...overrides,
  };
}

export function emptyCountry(overrides: Partial<CountryProviders> = {}): CountryProviders {
  return { link: null, flatrate: [], free: [], ads: [], rent: [], buy: [], ...overrides };
}

export function provider(id: number, name: string, displayPriority = id) {
  return { id, name, logoPath: `/logo${id}.png`, displayPriority };
}

/** Details for a summary. IMDb ID tt<id> by default. */
export function detailsFor(s: TitleSummary, overrides: Partial<TitleDetails> = {}): TitleDetails {
  return {
    ...s,
    genres: s.genreIds.map((id) => ({ id, name: `Genre ${id}` })),
    runtimeMinutes: s.mediaType === "movie" ? 120 : null,
    numberOfSeasons: s.mediaType === "tv" ? 3 : null,
    posterUrl: s.posterPath ? `https://image.tmdb.org/t/p/w500${s.posterPath}` : null,
    imdbId: `tt${String(s.tmdbId).padStart(7, "0")}${s.mediaType === "tv" ? "9" : ""}`,
    trailerYouTubeKey: `yt${s.tmdbId}`,
    providersByCountry: {},
    ...overrides,
  };
}

export interface FakeWorld {
  /** List pages by TMDB list: "popular:movie", "top_rated:tv", and "for_you:movie:603" for a seed's recommendations. Page n is index n - 1. */
  lists: Record<string, TitleSummary[][]>;
  /** Details by title key. A title missing here has details built from the first summary seen. */
  details: Record<string, TitleDetails | null>;
  /** List streams whose lookups throw. */
  failingLists?: Set<string>;
  /** Titles whose details lookups throw. */
  failingDetails?: Set<string>;
  /** List streams, and titles, that TMDB refuses with an HTTP 400 on every try (a failure a retry will not change). */
  refusedLists?: Set<string>;
  refusedDetails?: Set<string>;
  ratings: Map<string, ImdbRating>;
  ratingsThrow?: boolean;
  states: UserTitleState[];
  /** The user's rated (Seen) count. The fake pads `states` with Seen rows of unused IDs up to it. */
  ratedCount: number;
  settings: { country: string; providerIds: number[] };
  rows: Record<string, CardUserState>;
  seeds: TitleId[];
  /** The shuffle seed each new deck gets. Missing or null: decks are dealt in ranked order, as before the shuffle. */
  shuffleSeed?: string | null;
  /** Leave the service's own seed maker in place, so every new deck gets a random seed as in the app. */
  randomSeeds?: boolean;
}

export function world(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    lists: {},
    details: {},
    // One unrelated row, so the table reads as loaded and a missing rating as "none". Pass an empty map for "not loaded".
    ratings: new Map([["tt9999999", { rating: 5, votes: 10 }]]),
    states: [],
    ratedCount: 0,
    settings: { country: "US", providerIds: [] },
    rows: {},
    seeds: [],
    ...overrides,
  };
}

export interface Calls {
  lists: { stream: string; page: number; filters: unknown }[];
  details: string[];
  seeds: { mediaTypes: readonly MediaType[]; limit: number }[];
  stats: DeckStats[];
  ratingLookups: number;
  ratingProbes: number;
  /** Each getTitleStatesFor call's titles, by key. */
  stateLookups: string[][];
}

export function fakeService(w: FakeWorld) {
  const calls: Calls = { lists: [], details: [], seeds: [], stats: [], ratingLookups: 0, ratingProbes: 0, stateLookups: [] };
  const known = new Map<string, TitleSummary>();
  for (const pages of Object.values(w.lists)) for (const page of pages) for (const s of page) known.set(formatTitleKey(s), s);

  const page = (stream: string, n: number, filters: unknown) => {
    calls.lists.push({ stream, page: n, filters });
    if (w.failingLists?.has(stream)) return Promise.reject(new Error(`TMDB down for ${stream}`));
    if (w.refusedLists?.has(stream)) return Promise.reject(new TmdbError(`TMDB 400 for ${stream}`, 400, stream));
    const pages = w.lists[stream] ?? [];
    return Promise.resolve({ results: pages[n - 1] ?? [], page: n, totalPages: pages.length });
  };

  const tmdb: DeckTmdb = {
    discover: (pool, filters, n = 1) => page(`${pool}:${filters.mediaType}`, n, filters),
    recommendations: (seed, filters = {}, n = 1) => page(`for_you:${seed.mediaType}:${seed.tmdbId}`, n, filters),
    getTitleDetails: async (mediaType, tmdbId) => {
      const key = formatTitleKey({ mediaType, tmdbId });
      calls.details.push(key);
      if (w.failingDetails?.has(key)) throw new Error(`TMDB down for ${key}`);
      if (w.refusedDetails?.has(key)) throw new TmdbError(`TMDB 400 for ${key}`, 400, key);
      if (key in w.details) return w.details[key];
      const s = known.get(key);
      return s ? detailsFor(s) : null;
    },
  };

  const store = new MemoryRatingsStore(w.ratings);
  const ratings = {
    getMany: (ids: readonly string[]) => {
      calls.ratingLookups++;
      return w.ratingsThrow ? Promise.reject(new Error("db down")) : store.getMany(ids);
    },
    hasAnyRatings: () => {
      calls.ratingProbes++;
      return w.ratingsThrow ? Promise.reject(new Error("db down")) : store.hasAnyRatings();
    },
  };

  const library: DeckLibrary = {
    getUserTitleStates: async () => {
      const padding = Math.max(0, w.ratedCount - w.states.filter((s) => s.status === "seen").length);
      const seen = Array.from({ length: padding }, (_, i): UserTitleState => ({ mediaType: "movie", tmdbId: 9_000_000 + i, status: "seen" }));
      return ok([...w.states, ...seen]);
    },
    getUserSettings: async () => ok(w.settings),
    getTitleState: async (_u, ref): Promise<Result<CardUserState | null>> => ok(w.rows[formatTitleKey(ref)] ?? null),
    getTitleStatesFor: async (_u, refs) => {
      calls.stateLookups.push(refs.map(formatTitleKey));
      const wanted = new Set(refs.map(formatTitleKey));
      return ok(w.states.filter((s) => wanted.has(formatTitleKey(s))));
    },
    getTopRatedSeen: async (_u, mediaTypes, limit) => {
      calls.seeds.push({ mediaTypes, limit });
      return ok(w.seeds.filter((s) => mediaTypes.includes(s.mediaType)).slice(0, limit));
    },
  };

  const service = createDeckService({
    tmdb,
    ratings,
    library,
    now: () => NOW,
    ...(w.randomSeeds ? {} : { newSeed: () => w.shuffleSeed ?? null }),
    onStats: (s) => calls.stats.push(s),
  });
  return { service, calls };
}

/** n list results of one media type, IDs from `first`. */
export function range(mediaType: MediaType, first: number, n: number, overrides: Partial<TitleSummary> = {}): TitleSummary[] {
  return Array.from({ length: n }, (_, i) => summary(mediaType, first + i, overrides));
}
