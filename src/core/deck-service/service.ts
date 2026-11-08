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
// - Details lookups: one per title taken, at most POOL_QUOTA per pool (times
//   the pool's blend weight in the blend), so 20 for a single mode and 32 for
//   the blend at even weights. With a minimum IMDb rating a thin page takes up
//   to MIN_RATING_TAKE_ROUNDS rounds, so at most 3 times that (60 and 96).
//   They run DETAILS_CONCURRENCY at a time. The details cache is shared, and
//   getCard reads the same entries.
// - One IMDb ratings query per round, plus a one-row probe of the ratings
//   table when a query finds nothing (see lookupRatings).

import { mapWithConcurrency } from "../concurrency";
import { MEDIA_TYPES } from "@/db/schema";
import { activePools, buildDeck, createFilterMatcher, createVisibilityCheck, dealsForYou, forYouLock, isForYouUnlocked } from "../deck/build-deck";
import { getRatings, type RatingsDatasetProbe, type RatingsStore } from "../imdb/ratings";
import { parseFilters } from "../library/list";
import { fail, ok, validateUserId, type Result } from "../result";
import { DISCOVER_POOLS, streamingProviderIds, type DiscoverPool, type TmdbClient } from "../tmdb/client";
import { TMDB_MAX_PAGE, TMDB_YEAR_RANGE } from "../tmdb/constants";
import { isPermanentTmdbFailure } from "../tmdb/http";
import type { DiscoverFilters, ResultPage, TitleDetails, TitleSummary } from "../tmdb/types";
import { formatTitleKey, titleIdError, toTitleId, tryFormatTitleKey } from "../title-id";
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
  DETAILS_OUTAGE_MIN_FAILURES,
  FOR_YOU_SEED_COUNT,
  MAX_HIDDEN_CHECK,
  MAX_PAGES_PER_STREAM,
  MIN_RATING_PAGE_TARGET,
  MIN_RATING_TAKE_ROUNDS,
  POOL_QUOTA,
  RATINGS_PROBE_TTL_MS,
} from "./constants";
import {
  canonicalFilters,
  decodeCursor,
  encodeCursor,
  fingerprint,
  seedStreamHash,
  streamId,
  type CursorState,
  type StreamPosition,
  type StreamSpec,
} from "./cursor";
import type { Card, CardUserState, DeckPage, DeckPageCard, DeckRequest, DeckStats } from "./types";
import { cardUserState } from "./user-state";

/** The TMDB calls the service makes. The app passes getTmdb(). */
export type DeckTmdb = Pick<TmdbClient, "discover" | "recommendations" | "getTitleDetails">;

/** The library reads the service makes. index.ts wires them to the library core. */
export interface DeckLibrary {
  /** Every row the user has. The rated count that gates "for you" is its Seen rows (a Seen row always carries a rating). */
  getUserTitleStates(userId: string): Promise<Result<UserTitleState[]>>;
  getUserSettings(userId: string): Promise<Result<{ country: string; providerIds: number[] }>>;
  /** The user's row for one title, or null. */
  getTitleState(userId: string, ref: TitleId): Promise<Result<CardUserState | null>>;
  /** The user's Seen titles of these media types, highest rating first (ties: most recently changed first), at most `limit`. */
  getTopRatedSeen(userId: string, mediaTypes: readonly MediaType[], limit: number): Promise<Result<TitleId[]>>;
  /** The user's rows for these titles only. Titles with no row are absent. */
  getTitleStatesFor(userId: string, refs: readonly TitleId[]): Promise<Result<UserTitleState[]>>;
}

export interface DeckServiceDeps {
  tmdb: DeckTmdb;
  ratings: RatingsStore & RatingsDatasetProbe;
  library: DeckLibrary;
  now?: () => Date;
  /** Called with each getDeck call's counts. For the smoke test and tuning. */
  onStats?: (stats: DeckStats) => void;
}

export type DeckService = ReturnType<typeof createDeckService>;

interface ParsedRequest {
  mode: DiscoveryMode;
  filters: DeckFilters;
  cursor: CursorState | null;
}

export function createDeckService(deps: DeckServiceDeps) {
  const { tmdb, ratings, library } = deps;
  const clock = deps.now ?? (() => new Date());
  /** Until when "the ratings table has rows" is trusted without asking again. */
  let datasetLoadedUntil = 0;

  /**
   * IMDb ratings for these IDs, or "unavailable" when they cannot be trusted
   * to mean what they say, so one bad query never sinks the deck and a card
   * never claims "no rating" on IMDb's behalf (VISION invariant 5):
   * - the lookup failed, or
   * - it found nothing and the ratings table turns out to be empty (the first
   *   daily load has not landed), so a missing row says nothing about IMDb.
   * A lookup that finds any rating proves the table is loaded, so the probe
   * runs only when it finds none.
   */
  async function lookupRatings(imdbIds: readonly string[]): Promise<ReadonlyMap<string, ImdbRating> | "unavailable"> {
    try {
      const found = await getRatings(ratings, imdbIds);
      if (found.size === 0 && imdbIds.length > 0 && !(await datasetLoaded())) {
        console.warn("deck: the IMDb ratings table is empty");
        return "unavailable";
      }
      return found;
    } catch (err) {
      console.warn("deck: IMDb ratings lookup failed:", err);
      return "unavailable";
    }
  }

  async function datasetLoaded(): Promise<boolean> {
    const now = clock().getTime();
    if (now < datasetLoadedUntil) return true;
    const loaded = await ratings.hasAnyRatings();
    if (loaded) datasetLoadedUntil = now + RATINGS_PROBE_TTL_MS;
    return loaded;
  }

  /**
   * One page of the deck for the user. See DeckPage for how paging works.
   * Bad input (mode, filters, cursor) returns a typed error, and so does a
   * cursor from another user or from before a change to the settings its
   * lists depend on. A TMDB outage throws, so a caller never loops on a cursor
   * that cannot move and never reads an outage as the end of the deck: every
   * list lookup failing, or most of a page's details lookups failing (see
   * DETAILS_OUTAGE_MIN_FAILURES). A single title whose details fail is skipped.
   */
  async function getDeck(userId: string, request: DeckRequest = {}): Promise<Result<DeckPage>> {
    const u = validateUserId(userId);
    if (!u.ok) return u;
    const parsed = parseRequest(request);
    if (!parsed.ok) return parsed;
    const { mode, filters, cursor } = parsed.value;
    const now = clock();
    const mediaTypes: MediaType[] = filters.mediaTypes?.length
      ? MEDIA_TYPES.filter((m) => filters.mediaTypes!.includes(m))
      : [...MEDIA_TYPES];

    // Independent reads, in parallel. The seeds are read on every call, so the cursor never carries titles.
    // They are wasted if "for you" turns out locked, but they cost one small query.
    const [states, settings, seedRead] = await Promise.all([
      library.getUserTitleStates(u.value),
      library.getUserSettings(u.value),
      dealsForYou(mode) ? library.getTopRatedSeen(u.value, mediaTypes, FOR_YOU_SEED_COUNT) : ok<TitleId[]>([]),
    ]);
    if (!states.ok) return states;
    if (!settings.ok) return settings;
    if (!seedRead.ok) return seedRead;
    const ratedCount = states.value.filter((s) => s.status === "seen").length;

    const { country, providerIds } = settings.value;
    // Country and services shape the lists only through "on my services", so only then do they bind the cursor.
    const context = fingerprint(
      filters.onMyServices ? [u.value, country, ...[...new Set(providerIds)].sort((a, b) => a - b)] : [u.value],
    );
    if (cursor && cursor.context !== context) {
      return invalid("cursor belongs to another user or to changed country or services, start again without a cursor");
    }

    if (mode === "for_you" && !isForYouUnlocked(ratedCount)) return ok(forYouLock(ratedCount));

    const seeds = dedupeSeeds(seedRead.value, mediaTypes);
    if (mode === "for_you" && seeds.length === 0) return ok({ kind: "no_seeds", mode, mediaTypes: [...mediaTypes] });

    // With no services, "on my services" matches nothing. An empty provider list would also drop TMDB's server-side filter.
    if (filters.onMyServices && providerIds.length === 0) return ok({ kind: "cards", cards: [], nextCursor: null });

    const active = activePools(mode, ratedCount);
    const pools = active.map((p) => p.pool);
    // The streams this request reads, each resumed from its place in the cursor if it has one. Anything else in the
    // cursor is ignored, never fetched. A seed's stream is named by its title, so it keeps its place when the seeds
    // reorder, and a seed new to the top 5 starts at page 1.
    const specs = requestStreams(pools, mediaTypes, seeds, u.value).map((spec) => ({
      spec,
      position: cursor?.positions.get(streamId(spec)) ?? { page: 1, offset: 0 },
    }));

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
    // "On my services" needs availability, and a minimum IMDb rating needs the IMDb ID, both of which the details
    // bring. The engine checks them after enrichment. A list summary has neither, so checking them here would take nothing.
    const matches = createFilterMatcher({ ...filters, onMyServices: false, minImdbRating: undefined }, []);
    const quotas = active.map(({ weight }) => (mode === "blend" ? Math.ceil(POOL_QUOTA.blend * weight) : POOL_QUOTA.single));
    // A minimum IMDb rating drops titles only after their details, so a thin page takes more rounds, within a fixed
    // bound (MIN_RATING_TAKE_ROUNDS). Without a minimum one round is the whole call, as before.
    const maxRounds = typeof filters.minImdbRating === "number" ? MIN_RATING_TAKE_ROUNDS : 1;
    const taken: TitleSummary[][] = active.map(() => []);
    const takenKeys = active.map(() => new Set<string>());
    const details = new Map<string, TitleDetails>();
    const lookedUp = new Set<string>();
    let ratingMap: ReadonlyMap<string, ImdbRating> | "unavailable" = new Map();
    let result: ReturnType<typeof buildDeck> | null = null;

    for (let round = 0; round < maxRounds; round++) {
      const fresh = await Promise.all(
        active.map(({ pool }, i) =>
          takeFromPool(
            streams.filter((s) => s.spec.pool === pool),
            quotas[i],
            (c) => visible(c) && matches(c),
            takenKeys[i],
          ),
        ),
      );
      if (round === 0) {
        const live = streams.filter((s) => !s.exhaustedAtStart);
        if (live.length > 0 && !live.some((s) => s.progressed)) {
          throw new Error("getDeck: every TMDB list lookup failed, so the deck cannot move forward");
        }
      } else if (fresh.every((list) => list.length === 0)) {
        break;
      }
      fresh.forEach((list, i) => taken[i].push(...list));

      // Enrich each new title once, even when two pools took it.
      const unique = new Map<string, TitleSummary>();
      for (const list of fresh) for (const s of list) {
        const key = tryFormatTitleKey(s)!;
        if (!lookedUp.has(key)) unique.set(key, s);
      }
      for (const key of unique.keys()) lookedUp.add(key);
      const before = new Set(details.keys());
      let detailFailures = 0;
      await mapWithConcurrency([...unique], DETAILS_CONCURRENCY, async ([key, s]) => {
        stats.detailLookups++;
        try {
          const d = await tmdb.getTitleDetails(s.mediaType, s.tmdbId);
          if (d) details.set(key, d);
        } catch (err) {
          // A request TMDB will always refuse is a title it cannot serve, like a 404: skip it, never count it as an outage.
          if (!isPermanentTmdbFailure(err)) detailFailures++;
          console.warn(`deck: details lookup failed for ${key}, leaving it out of this page:`, err);
        }
      });
      // Most lookups failing is an outage: an empty or thin page with a cursor past these titles would lose them, and
      // could end the deck. Throw before the cursor moves. A few failures are titles TMDB cannot serve right now: skip
      // them, so one title that always fails never blocks the deck.
      if (detailFailures >= DETAILS_OUTAGE_MIN_FAILURES && detailFailures * 2 > unique.size) {
        throw new Error(`getDeck: ${detailFailures} of ${unique.size} TMDB details lookups failed, so the deck cannot move forward`);
      }
      const imdbIds = [...details].flatMap(([key, d]) => (!before.has(key) && d.imdbId !== null ? [d.imdbId] : []));
      const found = await lookupRatings(imdbIds);
      if (found === "unavailable") {
        // With a minimum IMDb rating, ratings that can't be read would drop every title while the cursor moves past
        // them, and the deck would read as empty. That is an outage: throw before the cursor moves, as for TMDB.
        if (typeof filters.minImdbRating === "number") {
          throw new Error("getDeck: IMDb ratings are unavailable, so a minimum IMDb rating can't be applied");
        }
        console.warn("deck: IMDb ratings are unavailable, cards show the rating as unavailable");
        ratingMap = "unavailable";
      } else if (ratingMap !== "unavailable") {
        ratingMap = new Map([...ratingMap, ...found]);
      }

      const candidatePools: Partial<Record<PoolName, Candidate[]>> = {};
      pools.forEach((pool, i) => {
        candidatePools[pool] = taken[i].flatMap((s) => {
          const d = details.get(tryFormatTitleKey(s)!);
          return d ? [toCandidate(s, d, ratingMap, country)] : [];
        });
      });
      result = buildDeck({
        states: states.value,
        userProviderIds: providerIds,
        filters,
        mode,
        now,
        ratedCount,
        pools: candidatePools,
      });
      if (result.kind !== "cards") throw new Error("getDeck: the engine locked a deck the service had unlocked");
      if (result.cards.length >= MIN_RATING_PAGE_TARGET) break;
    }
    if (result === null || result.kind !== "cards") throw new Error("getDeck: the engine locked a deck the service had unlocked");
    const dealt = result;
    pools.forEach((pool, i) => {
      const enriched = taken[i].filter((s) => details.has(tryFormatTitleKey(s)!)).length;
      stats.pools[pool] = { taken: taken[i].length, enriched, dealt: 0 };
    });

    const stateByKey = new Map(states.value.map((s) => [tryFormatTitleKey(s), s]));
    const cards = dealt.cards.map((c): DeckPageCard => {
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
      : encodeCursor({
          mode,
          filters: canonicalFilters(filters),
          context,
          positions: new Map(positions.map(({ spec, position }) => [streamId(spec), position])),
        });

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
        // An expired skip shows as untouched, as in Search (one rule, in cardUserState).
        userState: cardUserState(id, state.value, clock()),
      }),
    );
  }

  /**
   * Which of these titles the deck must no longer show, by the deck's own
   * hiding rule (on a list, or skipped until later). The Discover screen keeps
   * its queued cards across tab switches, and a title in that queue may have
   * been sorted elsewhere since (Search, Lists, another device): it sends the
   * queued titles here when it comes back, and drops the ones returned (VISION
   * invariant 3). One database read, no TMDB call. `refs` comes from the
   * client, so it is checked: a list of at most MAX_HIDDEN_CHECK titles.
   */
  async function hiddenTitles(userId: string, refs: unknown): Promise<Result<TitleId[]>> {
    const u = validateUserId(userId);
    if (!u.ok) return u;
    if (!Array.isArray(refs)) return fail({ code: "invalid_title", message: "expected a list of titles" });
    if (refs.length > MAX_HIDDEN_CHECK) {
      return fail({ code: "invalid_title", message: `at most ${MAX_HIDDEN_CHECK} titles per check` });
    }
    const ids = new Map<string, TitleId>();
    for (const ref of refs) {
      const error = titleIdError(ref);
      if (error) return fail({ code: "invalid_title", message: error });
      const id = toTitleId(ref as TitleId);
      ids.set(formatTitleKey(id), id);
    }
    if (ids.size === 0) return ok([]);
    const states = await library.getTitleStatesFor(u.value, [...ids.values()]);
    if (!states.ok) return states;
    const visible = createVisibilityCheck(states.value, clock());
    return ok([...ids.values()].filter((id) => !visible(id)));
  }

  return { getDeck, getCard, hiddenTitles };
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
    if (typeof year === "number" && (year < TMDB_YEAR_RANGE.min || year > TMDB_YEAR_RANGE.max)) {
      return invalid(`era years must be from ${TMDB_YEAR_RANGE.min} to ${TMDB_YEAR_RANGE.max}, got ${year}`);
    }
  }
  const { fromYear, toYear } = f.value.era ?? {};
  if (typeof fromYear === "number" && typeof toYear === "number" && fromYear > toYear) {
    return invalid(`era fromYear ${fromYear} is after toYear ${toYear}`);
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

/** The seeds in order, of the wanted media types, each once, at most FOR_YOU_SEED_COUNT. */
function dedupeSeeds(seeds: readonly TitleId[], mediaTypes: readonly MediaType[]): TitleId[] {
  const seen = new Set<string>();
  const out: TitleId[] = [];
  for (const { mediaType, tmdbId } of seeds) {
    const key = tryFormatTitleKey({ mediaType, tmdbId });
    if (key === null || seen.has(key) || !mediaTypes.includes(mediaType)) continue;
    seen.add(key);
    out.push({ mediaType, tmdbId });
    if (out.length === FOR_YOU_SEED_COUNT) break;
  }
  return out;
}

/** The streams a request reads: each discover pool per media type, then one per "for you" seed, in seed order. */
function requestStreams(
  pools: readonly PoolName[],
  mediaTypes: readonly MediaType[],
  seeds: readonly TitleId[],
  userId: string,
): StreamSpec[] {
  const specs: StreamSpec[] = [];
  for (const pool of pools) {
    if (pool === "for_you") for (const seed of seeds) specs.push({ pool, seedHash: seedStreamHash(userId, seed), seed });
    else if ((DISCOVER_POOLS as readonly string[]).includes(pool)) {
      for (const mediaType of mediaTypes) specs.push({ pool: pool as DiscoverPool, mediaType });
    }
  }
  return specs;
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
  };
  // Unknown availability (null) leaves providerIds undefined, as attachProviderIds does. "On my services" then leaves the title out.
  if (d.providersByCountry !== null) c.providerIds = streamingProviderIds(d.providersByCountry[country]);
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
 * where it was, so the next call retries it, unless TMDB refused the request
 * in a way a retry will not change (isPermanentTmdbFailure): then the stream
 * ends, as on a 404, so a list that always fails cannot block the deck.
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
      if (isPermanentTmdbFailure(err)) {
        this.exhausted = true;
        this.progressed = true;
        console.warn(`deck: TMDB refused ${streamId(this.spec)} page ${this.page} for good, ending that stream:`, err);
        return false;
      }
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
      if (this.page >= Math.min(this.totalPages, TMDB_MAX_PAGE)) {
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
 *
 * Each round reads its streams in parallel, so a user who has sorted the
 * first pages of every stream waits for one round of page skips, not one per
 * stream. A round asks only as many streams as the quota has room for, so no
 * stream reads past a title it will not take. Titles land in stream order.
 */
async function takeFromPool(
  streams: readonly Stream[],
  quota: number,
  admit: (c: TitleSummary) => boolean,
  keys: Set<string> = new Set(),
): Promise<TitleSummary[]> {
  const out: TitleSummary[] = [];
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
    const round = live.slice(0, quota - out.length);
    // nextAdmitted checks and claims a key with no await in between, so parallel streams never take one title twice.
    const got = await Promise.all(round.map(nextAdmitted));
    const still: Stream[] = [];
    round.forEach((s, i) => {
      const c = got[i];
      if (c === undefined) return;
      out.push(c);
      still.push(s);
    });
    live = [...still, ...live.slice(round.length)];
  }
  return out;
}
