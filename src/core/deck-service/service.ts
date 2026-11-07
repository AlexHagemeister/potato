// The deck service: the layer the Discover screen, Search, and a future MCP
// call for cards. It gathers what the pure deck engine needs (the user's
// states, settings, and candidate pools from TMDB), runs the engine, and turns
// its output into full cards.
//
// Dependencies are injected, so tests run with a fake TMDB client and fake
// repositories. index.ts wires the real ones.
//
// The bound on TMDB work per getDeck call (Vercel Hobby, a fast first card,
// and politeness to TMDB, which publishes no fixed rate limit):
// - List lookups: at most MAX_PAGES_PER_STREAM per stream. Streams are one per
//   discover pool and media type (at most 3 * 2) plus one per "for you" seed
//   (at most FOR_YOU_SEED_COUNT), so at most 3 * 11 = 33. Usually one per
//   stream, and discover pages are shared across users in the cache.
// - Details lookups: one per title taken, at most POOL_QUOTA per pool, so 20
//   for a single mode and 32 for the blend. They run DETAILS_CONCURRENCY at a
//   time. The details cache is shared, and getCard reads the same entries.
// - One IMDb ratings query for the whole page.

import { mapWithConcurrency } from "../concurrency";
import { buildDeck, createFilterMatcher, createVisibilityCheck } from "../deck/build-deck";
import { BLEND_ORDER, BLEND_WEIGHTS, FOR_YOU_MIN_RATINGS } from "../deck/constants";
import { getRatings, type RatingsStore } from "../imdb/ratings";
import { parseFilters } from "../library/list";
import { fail, ok, validateUserId, type Result } from "../result";
import { streamingProviderIds, type TmdbClient } from "../tmdb/client";
import type { DiscoverFilters, ResultPage, TitleDetails, TitleSummary } from "../tmdb/types";
import { titleIdError, tryFormatTitleKey } from "../title-id";
import {
  DISCOVERY_MODES,
  type Candidate,
  type DeckFilters,
  type DiscoveryMode,
  type ImdbRating,
  type MediaType,
  type PoolName,
  type TitleId,
  type UserTitleState,
} from "../types";
import { buildCard, imdbState } from "./card";
import {
  DETAILS_CONCURRENCY,
  ERA_YEAR_RANGE,
  FOR_YOU_SEED_COUNT,
  MAX_LIST_PAGE,
  MAX_PAGES_PER_STREAM,
  POOL_QUOTA,
} from "./constants";
import {
  canonicalFilters,
  decodeCursor,
  encodeCursor,
  streamId,
  type CursorState,
  type DiscoverPoolName,
  type StreamPosition,
  type StreamSpec,
} from "./cursor";
import type { Card, CardUserState, DeckPage, DeckPageCard, DeckRequest, DeckStats } from "./types";

/** The TMDB calls the service makes. The app passes getTmdb(). */
export type DeckTmdb = Pick<TmdbClient, "discover" | "recommendations" | "getTitleDetails">;

/** The library reads the service makes. index.ts wires them to the library core. */
export interface DeckLibrary {
  getUserTitleStates(userId: string): Promise<Result<UserTitleState[]>>;
  getRatedCount(userId: string): Promise<Result<number>>;
  getUserSettings(userId: string): Promise<Result<{ country: string; providerIds: number[] }>>;
  /** The user's row for one title, or null. */
  getTitleState(userId: string, ref: TitleId): Promise<Result<CardUserState | null>>;
  /** The user's Seen titles of these media types, highest rating first (ties: most recently changed first), at most `limit`. */
  getTopRatedSeen(userId: string, mediaTypes: readonly MediaType[], limit: number): Promise<Result<TitleId[]>>;
}

export interface DeckServiceDeps {
  tmdb: DeckTmdb;
  ratings: RatingsStore;
  library: DeckLibrary;
  now?: () => Date;
  /** Called with each getDeck call's counts. For the smoke test and tuning. */
  onStats?: (stats: DeckStats) => void;
}

export type DeckService = ReturnType<typeof createDeckService>;

const MEDIA_TYPES: readonly MediaType[] = ["movie", "tv"];
const DISCOVER_POOLS: readonly DiscoverPoolName[] = ["popular", "deep_cuts", "top_rated"];

interface ParsedRequest {
  mode: DiscoveryMode;
  filters: DeckFilters;
  cursor: CursorState | null;
}

export function createDeckService(deps: DeckServiceDeps) {
  const { tmdb, ratings, library } = deps;
  const clock = deps.now ?? (() => new Date());

  /** IMDb ratings for these IDs, or "unavailable" when the lookup fails, so one bad query never sinks the deck. */
  async function lookupRatings(imdbIds: readonly string[]): Promise<ReadonlyMap<string, ImdbRating> | "unavailable"> {
    try {
      return await getRatings(ratings, imdbIds);
    } catch (err) {
      console.warn("deck: IMDb ratings lookup failed, cards show the rating as unavailable:", err);
      return "unavailable";
    }
  }

  /**
   * One page of the deck for the user. See DeckPage for how paging works.
   * Bad input (mode, filters, cursor) returns a typed error. A TMDB outage
   * that leaves every list unreadable throws, so a caller never loops on a
   * cursor that cannot move.
   */
  async function getDeck(userId: string, request: DeckRequest = {}): Promise<Result<DeckPage>> {
    const u = validateUserId(userId);
    if (!u.ok) return u;
    const parsed = parseRequest(request);
    if (!parsed.ok) return parsed;
    const { mode, filters, cursor } = parsed.value;
    const now = clock();
    const mediaTypes = filters.mediaTypes?.length ? MEDIA_TYPES.filter((m) => filters.mediaTypes!.includes(m)) : MEDIA_TYPES;
    const wantsForYou = mode === "for_you" || (mode === "blend" && BLEND_WEIGHTS.for_you !== 0);

    // Independent reads, in parallel. The seeds are wasted if "for you" turns out locked, but they cost one query.
    const [states, ratedCount, settings, seeds] = await Promise.all([
      library.getUserTitleStates(u.value),
      library.getRatedCount(u.value),
      library.getUserSettings(u.value),
      wantsForYou && !cursor ? library.getTopRatedSeen(u.value, mediaTypes, FOR_YOU_SEED_COUNT) : ok<TitleId[]>([]),
    ]);
    if (!states.ok) return states;
    if (!ratedCount.ok) return ratedCount;
    if (!settings.ok) return settings;
    if (!seeds.ok) return seeds;

    const forYouUnlocked = ratedCount.value >= FOR_YOU_MIN_RATINGS;
    if (mode === "for_you" && !forYouUnlocked) {
      // The engine owns the lock rule and its shape. With no pools it does no work.
      const locked = buildDeck({ states: [], userProviderIds: [], filters: {}, mode, now, ratedCount: ratedCount.value, pools: {} });
      if (locked.kind !== "locked") throw new Error("getDeck: expected the engine to lock for you");
      return ok(locked);
    }

    const { country, providerIds } = settings.value;
    // With no services, "on my services" matches nothing. An empty provider list would also drop TMDB's server-side filter.
    if (filters.onMyServices && providerIds.length === 0) return ok({ kind: "cards", cards: [], nextCursor: null });

    const pools: PoolName[] = (mode === "blend" ? BLEND_ORDER : [mode]).filter(
      (p) => (mode !== "blend" || BLEND_WEIGHTS[p] !== 0) && (p !== "for_you" || forYouUnlocked),
    );
    const specs = cursor
      ? // Only streams this request would have made. Anything else in the cursor is ignored, never fetched.
        cursor.streams.filter(({ spec }) => pools.includes(spec.pool) && mediaTypes.includes(specMediaType(spec)))
      : freshStreams(pools, mediaTypes, seeds.value);

    const stats: DeckStats = { listLookups: 0, detailLookups: 0, pools: {} };
    const discoverFilters = toDiscoverFilters(filters, providerIds, country);
    const streams = specs.map(
      ({ spec, position }) =>
        new Stream(spec, position, (page) => {
          stats.listLookups++;
          return spec.pool === "for_you"
            ? tmdb.recommendations(spec.seed, { genreIds: discoverFilters.genreIds, era: discoverFilters.era }, page)
            : tmdb.discover(spec.pool, { ...discoverFilters, mediaType: spec.mediaType }, page);
        }),
    );

    // Read every stream's current page in parallel, then take titles pool by pool.
    await Promise.all(streams.map((s) => s.load()));
    const visible = createVisibilityCheck(states.value, now);
    // "On my services" needs availability, which the details bring. It is checked by the engine after enrichment.
    const matches = createFilterMatcher({ ...filters, onMyServices: false }, []);
    const quota = mode === "blend" ? POOL_QUOTA.blend : POOL_QUOTA.single;
    const taken = await Promise.all(
      pools.map((pool) =>
        takeFromPool(
          streams.filter((s) => s.spec.pool === pool),
          quota,
          (c) => visible(c) && matches(c),
        ),
      ),
    );

    const live = streams.filter((s) => !s.exhaustedAtStart);
    if (live.length > 0 && !live.some((s) => s.progressed)) {
      throw new Error("getDeck: every TMDB list lookup failed, so the deck cannot move forward");
    }

    // Enrich each taken title once, even when two pools took it.
    const unique = new Map<string, TitleSummary>();
    for (const list of taken) for (const s of list) unique.set(tryFormatTitleKey(s)!, s);
    const details = new Map<string, TitleDetails>();
    await mapWithConcurrency([...unique], DETAILS_CONCURRENCY, async ([key, s]) => {
      stats.detailLookups++;
      try {
        const d = await tmdb.getTitleDetails(s.mediaType, s.tmdbId);
        if (d) details.set(key, d);
      } catch (err) {
        console.warn(`deck: details lookup failed for ${key}, leaving it out of this page:`, err);
      }
    });
    const imdbIds = [...details.values()].map((d) => d.imdbId).filter((id): id is string => id !== null);
    const ratingMap = await lookupRatings(imdbIds);

    const candidatePools: Partial<Record<PoolName, Candidate[]>> = {};
    pools.forEach((pool, i) => {
      const enriched = taken[i].flatMap((s) => {
        const d = details.get(tryFormatTitleKey(s)!);
        return d ? [toCandidate(s, d, ratingMap, country)] : [];
      });
      candidatePools[pool] = enriched;
      stats.pools[pool] = { taken: taken[i].length, enriched: enriched.length, dealt: 0 };
    });

    const result = buildDeck({
      states: states.value,
      userProviderIds: providerIds,
      filters,
      mode,
      now,
      ratedCount: ratedCount.value,
      pools: candidatePools,
    });
    if (result.kind !== "cards") throw new Error("getDeck: the engine locked a deck the service had unlocked");

    const stateByKey = new Map(states.value.map((s) => [tryFormatTitleKey(s), s]));
    const cards = result.cards.map((c): DeckPageCard => {
      const key = tryFormatTitleKey(c)!;
      const d = details.get(key)!;
      stats.pools[c.source]!.dealt++;
      const card = buildCard({
        details: d,
        imdb: imdbState(d.imdbId, ratingMap),
        country,
        userProviderIds: providerIds,
        userState: deckUserState(stateByKey.get(key)),
      });
      return { ...card, source: c.source };
    });

    const positions = specs.map(({ spec }, i) => ({ spec, position: streams[i].position }));
    const nextCursor = positions.every((p) => p.position.page === 0)
      ? null
      : encodeCursor({ mode, filters: canonicalFilters(filters), streams: positions });

    deps.onStats?.(stats);
    return ok({ kind: "cards", cards, nextCursor });
  }

  /**
   * The full card for one title, the same card the deck shows. For Search,
   * and for any screen that opens a title by its (media type, TMDB ID).
   */
  async function getCard(userId: string, ref: TitleId): Promise<Result<Card>> {
    const u = validateUserId(userId);
    if (!u.ok) return u;
    const error = titleIdError(ref);
    if (error) return fail({ code: "invalid_title", message: error });
    const id: TitleId = { mediaType: ref.mediaType, tmdbId: ref.tmdbId };

    const [settings, state, details] = await Promise.all([
      library.getUserSettings(u.value),
      library.getTitleState(u.value, id),
      tmdb.getTitleDetails(id.mediaType, id.tmdbId),
    ]);
    if (!settings.ok) return settings;
    if (!state.ok) return state;
    if (!details) return fail({ code: "unknown_title" });

    const ratingMap = details.imdbId ? await lookupRatings([details.imdbId]) : new Map<string, ImdbRating>();
    return ok(
      buildCard({
        details,
        imdb: imdbState(details.imdbId, ratingMap),
        country: settings.value.country,
        userProviderIds: settings.value.providerIds,
        userState: state.value,
      }),
    );
  }

  return { getDeck, getCard };
}

function invalid<T>(message: string): Result<T> {
  return fail({ code: "invalid_deck_query", message });
}

/** Checks a request that may have come from JSON (the API, an MCP call). */
function parseRequest(request: unknown): Result<ParsedRequest> {
  const raw = request ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) return invalid("request must be an object");
  const { mode = "blend", filters, cursor } = raw as Record<string, unknown>;
  if (!(DISCOVERY_MODES as readonly unknown[]).includes(mode)) return invalid(`unknown discovery mode ${JSON.stringify(mode)}`);
  const f = parseFilters(filters);
  if (!f.ok) return invalid(f.error.code === "invalid_list_query" ? f.error.message : "filters are invalid");
  for (const year of [f.value.era?.fromYear, f.value.era?.toYear]) {
    if (typeof year === "number" && (year < ERA_YEAR_RANGE.min || year > ERA_YEAR_RANGE.max)) {
      return invalid(`era years must be from ${ERA_YEAR_RANGE.min} to ${ERA_YEAR_RANGE.max}, got ${year}`);
    }
  }
  let state: CursorState | null = null;
  if (cursor !== undefined && cursor !== null) {
    const decoded = decodeCursor(cursor);
    if (typeof decoded === "string") return invalid(decoded);
    if (decoded.mode !== mode || decoded.filters !== canonicalFilters(f.value)) {
      return invalid("cursor belongs to a different mode or filters");
    }
    state = decoded;
  }
  return ok({ mode: mode as DiscoveryMode, filters: f.value, cursor: state });
}

function specMediaType(spec: StreamSpec): MediaType {
  return spec.pool === "for_you" ? spec.seed.mediaType : spec.mediaType;
}

/** The streams for a first page: each discover pool per media type, then one per "for you" seed, all at page 1. */
function freshStreams(pools: readonly PoolName[], mediaTypes: readonly MediaType[], seeds: readonly TitleId[]) {
  const start = (): StreamPosition => ({ page: 1, offset: 0 });
  const specs: { spec: StreamSpec; position: StreamPosition }[] = [];
  for (const pool of pools) {
    if (pool === "for_you") {
      for (const seed of seeds.slice(0, FOR_YOU_SEED_COUNT)) {
        if (mediaTypes.includes(seed.mediaType)) specs.push({ spec: { pool, seed: { mediaType: seed.mediaType, tmdbId: seed.tmdbId } }, position: start() });
      }
    } else if (DISCOVER_POOLS.includes(pool)) {
      for (const mediaType of mediaTypes) specs.push({ spec: { pool, mediaType }, position: start() });
    }
  }
  // A seed listed twice would make two identical streams.
  const seen = new Set<string>();
  return specs.filter(({ spec }) => !seen.has(streamId(spec)) && seen.add(streamId(spec)));
}

/** The deck's filters in TMDB discover's terms. "On my services" becomes the user's providers in their country. */
function toDiscoverFilters(filters: DeckFilters, providerIds: readonly number[], country: string): Omit<DiscoverFilters, "mediaType"> {
  const out: Omit<DiscoverFilters, "mediaType"> = {};
  if (filters.genreIds?.length) out.genreIds = [...filters.genreIds];
  const fromYear = filters.era?.fromYear ?? undefined;
  const toYear = filters.era?.toYear ?? undefined;
  if (fromYear !== undefined || toYear !== undefined) out.era = { fromYear, toYear };
  if (filters.onMyServices) {
    out.providerIds = [...providerIds];
    out.watchRegion = country;
  }
  return out;
}

function toCandidate(
  s: TitleSummary,
  d: TitleDetails,
  ratingMap: ReadonlyMap<string, ImdbRating> | "unavailable",
  country: string,
): Candidate {
  const imdb = imdbState(d.imdbId, ratingMap);
  const c: Candidate = {
    mediaType: s.mediaType,
    tmdbId: s.tmdbId,
    title: s.title,
    year: s.year,
    genreIds: s.genreIds,
    popularity: s.popularity,
    tmdbVoteAverage: s.tmdbVoteAverage,
    tmdbVoteCount: s.tmdbVoteCount,
    providerIds: streamingProviderIds(d.providersByCountry[country]),
  };
  if (imdb.kind === "rated") c.imdb = { rating: imdb.rating, votes: imdb.votes };
  return c;
}

/** The user state on a deck card. A dealt title is never on a list, so it is either unsorted or a skip that has come back. */
function deckUserState(s: UserTitleState | undefined): CardUserState | null {
  if (!s) return null;
  const skipUntil = s.skipUntil instanceof Date ? s.skipUntil : typeof s.skipUntil === "string" ? new Date(s.skipUntil) : null;
  return { status: s.status, rating: null, review: null, skipUntil };
}

/**
 * One TMDB list, read forward from a position. It reads at most
 * MAX_PAGES_PER_STREAM pages per call. A failed read leaves the position
 * where it was, so the next call retries it.
 */
class Stream {
  private page: number;
  private offset: number;
  private exhausted: boolean;
  private failed = false;
  private fetches = 0;
  private results: TitleSummary[] | null = null;
  private totalPages = 0;
  /** True once the position has moved (or the stream ran out) during this call. */
  progressed = false;
  readonly exhaustedAtStart: boolean;

  constructor(
    readonly spec: StreamSpec,
    start: StreamPosition,
    private readonly fetchPage: (page: number) => Promise<ResultPage<TitleSummary>>,
  ) {
    this.page = start.page;
    this.offset = start.offset;
    this.exhausted = start.page === 0;
    this.exhaustedAtStart = this.exhausted;
  }

  get position(): StreamPosition {
    return this.exhausted ? { page: 0, offset: 0 } : { page: this.page, offset: this.offset };
  }

  /** Makes sure the current page is loaded. False when the stream is out, failed, or over its page budget. */
  async load(): Promise<boolean> {
    if (this.results !== null) return true;
    if (this.exhausted || this.failed || this.fetches >= MAX_PAGES_PER_STREAM) return false;
    this.fetches++;
    try {
      const page = await this.fetchPage(this.page);
      this.results = page.results;
      this.totalPages = page.totalPages;
      return true;
    } catch (err) {
      this.failed = true;
      console.warn(`deck: TMDB list lookup failed for ${streamId(this.spec)} page ${this.page}:`, err);
      return false;
    }
  }

  /** The next title in the list, or undefined when there is none to read in this call. */
  async next(): Promise<TitleSummary | undefined> {
    for (;;) {
      if (!(await this.load())) return undefined;
      const results = this.results!;
      if (this.offset < results.length) {
        this.progressed = true;
        return results[this.offset++];
      }
      this.progressed = true;
      if (this.page >= Math.min(this.totalPages, MAX_LIST_PAGE)) {
        this.exhausted = true;
        return undefined;
      }
      this.page++;
      this.offset = 0;
      this.results = null;
    }
  }
}

/**
 * Takes up to `quota` titles from a pool's streams, one per stream in turn,
 * skipping titles `admit` rejects and repeats within the pool. Keeping the
 * streams in turn mixes movies with series, and "for you" seeds with each
 * other, in the order they were given.
 */
async function takeFromPool(streams: readonly Stream[], quota: number, admit: (c: TitleSummary) => boolean): Promise<TitleSummary[]> {
  const out: TitleSummary[] = [];
  const keys = new Set<string>();
  const nextAdmitted = async (s: Stream): Promise<TitleSummary | undefined> => {
    for (;;) {
      const c = await s.next();
      if (c === undefined) return undefined;
      const key = tryFormatTitleKey(c);
      if (key !== null && !keys.has(key) && admit(c)) {
        keys.add(key);
        return c;
      }
    }
  };
  let live = [...streams];
  while (out.length < quota && live.length > 0) {
    const still: Stream[] = [];
    for (const s of live) {
      if (out.length >= quota) break;
      const c = await nextAdmitted(s);
      if (c === undefined) continue;
      out.push(c);
      still.push(s);
    }
    live = still;
  }
  return out;
}
