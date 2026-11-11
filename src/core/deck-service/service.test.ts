import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FOR_YOU_MIN_RATINGS } from "../deck/constants";
import { isShuffleSeed, seededFrontWeightedOrder } from "../deck/shuffle";
import { formatTitleKey } from "../title-id";
import type { DeckFilters, UserTitleState } from "../types";
import type { CardStreaming, DeckPage, DeckPageCard, DeckRequest, KnownStreaming } from "./types";
import {
  FOR_YOU_SEED_COUNT,
  JUSTWATCH_ATTRIBUTION,
  MAX_HIDDEN_CHECK,
  MAX_PAGES_PER_STREAM,
  MIN_RATING_PAGE_TARGET,
  MIN_RATING_TAKE_ROUNDS,
  POOL_QUOTA,
  SHUFFLE_FRONT_BIAS,
  SHUFFLE_WINDOW_PAGES,
} from "./constants";
import { canonicalFilters, decodeCursor, encodeCursor } from "./cursor";
import { NOW, detailsFor, emptyCountry, fakeService, provider, range, summary, world, type FakeWorld } from "./test-fakes";

const USER = "user-1";
const TOP = { tmdbVoteCount: 5000 }; // passes the engine's TMDB top-rated gate

function cardsOf(page: DeckPage): DeckPageCard[] {
  if (page.kind !== "cards") throw new Error(`expected cards, got ${page.kind}`);
  return page.cards;
}

function known(s: CardStreaming): KnownStreaming {
  if (s.kind !== "known") throw new Error("expected known streaming");
  return s;
}

async function deck(w: FakeWorld, request: Parameters<ReturnType<typeof fakeService>["service"]["getDeck"]>[1] = {}) {
  const { service, calls } = fakeService(w);
  const result = await service.getDeck(USER, request);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return { page: result.value, calls, service };
}

/** Mutes console.warn for a describe block: its failure paths log on purpose. */
function muteWarnings() {
  const warn = console.warn;
  beforeAll(() => {
    console.warn = () => {};
  });
  afterAll(() => {
    console.warn = warn;
  });
}

const keysOf = (cards: readonly { mediaType: string; tmdbId: number }[]) => cards.map((c) => `${c.mediaType}:${c.tmdbId}`);

describe("getDeck: a first page", () => {
  test("deals full cards from every pool, tagged with their source", async () => {
    const w = world({
      lists: {
        "popular:movie": [range("movie", 1, 3)],
        "popular:tv": [range("tv", 11, 3)],
        "deep_cuts:movie": [range("movie", 21, 2)],
        "top_rated:movie": [range("movie", 31, 2, TOP)],
      },
      ratings: new Map([["tt0000001", { rating: 8.1, votes: 50_000 }]]),
    });
    const { page } = await deck(w);
    const cards = cardsOf(page);
    expect(new Set(cards.map((c) => c.source))).toEqual(new Set(["popular", "deep_cuts", "top_rated"]));
    expect(cards[0]).toMatchObject({ source: "popular", mediaType: "movie", tmdbId: 1 });

    const first = cards.find((c) => c.tmdbId === 1)!;
    expect(first.imdb).toEqual({ kind: "rated", imdbId: "tt0000001", rating: 8.1, votes: 50_000 });
    expect(first.posterUrl).toBe("https://image.tmdb.org/t/p/w500/p1.jpg");
    expect(first.trailerYouTubeKey).toBe("yt1");
    expect(first.runtimeMinutes).toBe(120);
    expect(first.numberOfSeasons).toBeNull();
    expect(first.streaming.attribution).toEqual(JUSTWATCH_ATTRIBUTION);
    expect(first.userState).toBeNull();

    const series = cards.find((c) => c.mediaType === "tv")!;
    expect(series.runtimeMinutes).toBeNull();
    expect(series.numberOfSeasons).toBe(3);
    expect(series.imdb.kind).toBe("none");
  });

  test("defaults to the blend and reads each pool once per media type", async () => {
    const { calls } = await deck(world());
    expect(calls.lists.map((c) => c.stream).sort()).toEqual(
      ["deep_cuts:movie", "deep_cuts:tv", "popular:movie", "popular:tv", "top_rated:movie", "top_rated:tv"].sort(),
    );
  });

  test("a single mode reads only its own pool, for the chosen media type", async () => {
    const { calls } = await deck(world(), { mode: "top_rated", filters: { mediaTypes: ["tv"] } });
    expect(calls.lists.map((c) => c.stream)).toEqual(["top_rated:tv"]);
  });

  test("a movie and a series with the same TMDB ID stay two titles", async () => {
    const w = world({ lists: { "popular:movie": [[summary("movie", 603)]], "popular:tv": [[summary("tv", 603)]] } });
    const { page, calls } = await deck(w, { mode: "popular" });
    expect(keysOf(cardsOf(page)).sort()).toEqual(["movie:603", "tv:603"]);
    expect(calls.details.sort()).toEqual(["movie:603", "tv:603"]);
  });

  test("passes genre and era to TMDB discover", async () => {
    const { calls } = await deck(world(), { mode: "popular", filters: { genreIds: [878, 10765], era: { fromYear: 2015, toYear: null } } });
    expect(calls.lists[0].filters).toEqual({ mediaType: "movie", genreIds: [878, 10765], era: { fromYear: 2015, toYear: undefined } });
  });
});

describe("getDeck: hidden titles cost nothing", () => {
  test("listed titles and skips not yet due are dropped before any details lookup, and the pool refills from later titles", async () => {
    const w = world({
      lists: { "popular:movie": [range("movie", 1, 5)] },
      states: [
        { mediaType: "movie", tmdbId: 1, status: "seen" },
        { mediaType: "movie", tmdbId: 2, status: "passed" },
        { mediaType: "movie", tmdbId: 3, status: "skipped", skipUntil: new Date("2026-11-08T12:00:00Z") },
        { mediaType: "movie", tmdbId: 4, status: "skipped", skipUntil: new Date("2026-11-01T00:00:00Z") },
      ],
    });
    const { page, calls } = await deck(w, { mode: "popular", filters: { mediaTypes: ["movie"] } });
    expect(calls.details.sort()).toEqual(["movie:4", "movie:5"]);
    const cards = cardsOf(page);
    expect(keysOf(cards)).toEqual(["movie:4", "movie:5"]);
    expect(cards[0].userState).toMatchObject({ status: "skipped", rating: null });
  });

  test("a user who has sorted the first pages skips past them, up to the page budget", async () => {
    const pages = Array.from({ length: 6 }, (_, p) => range("movie", p * 20 + 1, 20));
    const states = pages.slice(0, 4).flat().map((s) => ({ mediaType: s.mediaType, tmdbId: s.tmdbId, status: "passed" as const }));
    const w = world({ lists: { "popular:movie": pages }, states });
    const { page, calls } = await deck(w, { mode: "popular", filters: { mediaTypes: ["movie"] } });
    // Pages 1 to 3 are all sorted. The budget stops the stream there, with nothing looked up.
    expect(calls.lists.map((c) => c.page)).toEqual([1, 2, 3].slice(0, MAX_PAGES_PER_STREAM));
    expect(calls.details).toEqual([]);
    expect(cardsOf(page)).toEqual([]);
    expect(page.kind === "cards" && page.nextCursor).not.toBeNull();

    // The next call moves on from page 4, and reaches page 5's titles.
    const { service, calls: calls2 } = fakeService(w);
    const next = await service.getDeck(USER, { mode: "popular", filters: { mediaTypes: ["movie"] }, cursor: (page as { nextCursor: string }).nextCursor });
    if (!next.ok) throw new Error("expected ok");
    expect(calls2.lists.map((c) => c.page)).toEqual([4, 5]);
    expect(cardsOf(next.value)[0].tmdbId).toBe(81);
  });
});

describe("getDeck: paging", () => {
  test("the cursor continues each stream where it stopped, never repeating a title, and ends null", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 20), range("movie", 21, 15)] } });
    const request = { mode: "popular" as const, filters: { mediaTypes: ["movie" as const] } };
    const { service } = fakeService(w);
    const dealt: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await service.getDeck(USER, { ...request, cursor });
      if (!result.ok) throw new Error("expected ok");
      const page = result.value;
      if (page.kind !== "cards") throw new Error("expected cards");
      dealt.push(...keysOf(page.cards));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(2);
    expect(dealt.length).toBe(35);
    expect(new Set(dealt).size).toBe(35);
    expect(dealt.slice(0, POOL_QUOTA.single)).toEqual(range("movie", 1, 20).map(formatTitleKey));
  });

  test("every call moves the cursor forward", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 20), range("movie", 21, 20)] } });
    const { page } = await deck(w, { mode: "popular", filters: { mediaTypes: ["movie"] } });
    const state = decodeCursor((page as { nextCursor: string }).nextCursor);
    if (typeof state === "string") throw new Error(state);
    expect([...state.positions]).toEqual([["popular:movie", { page: 1, offset: 20 }]]);
  });

  test("garbage, a tampered page, too many streams, a repeated stream, or an old cursor is a typed error", async () => {
    const { service } = fakeService(world());
    const forge = (s: unknown[], v = 3) =>
      Buffer.from(JSON.stringify({ v, m: "blend", f: canonicalFilters({}), c: "ctx", s })).toString("base64url");
    for (const cursor of [
      "not a cursor",
      "",
      forge([["popular:movie", 501, 0]]),
      forge([["popular:movie", 1, -1]]),
      forge([["popular:person", 1, 0]]),
      forge([["for_you:5", 1, 0]]),
      forge([["for_you:movie:603", 1, 0]]),
      forge([["for_you:abcdefghijklm", 1, 0]]),
      forge([["popular:movie", 1, 0], ["popular:movie", 2, 0]]),
      forge(Array.from({ length: 3 * 2 + FOR_YOU_SEED_COUNT + 1 }, (_, i) => [`for_you:${String(i).padStart(12, "a")}`, 1, 0])),
      forge([["popular:movie", 1, 0]], 2),
    ]) {
      const result = await service.getDeck(USER, { cursor });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_deck_query" } });
    }
  });

  test("a cursor from another mode or other filters is a typed error", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 30)] } });
    const { page, service } = await deck(w, { mode: "popular" });
    const cursor = (page as { nextCursor: string }).nextCursor;
    expect(await service.getDeck(USER, { mode: "top_rated", cursor })).toMatchObject({
      ok: false,
      error: { code: "invalid_deck_query", message: "cursor belongs to a different mode or filters" },
    });
    expect(await service.getDeck(USER, { mode: "popular", filters: { genreIds: [18] }, cursor })).toMatchObject({
      ok: false,
      error: { code: "invalid_deck_query" },
    });
  });

  test("a cursor stream the request would not make is ignored, never fetched", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 30)] } });
    const request = { mode: "popular" as const, filters: { mediaTypes: ["movie" as const] } };
    const { page } = await deck(w, request);
    const state = decodeCursor((page as { nextCursor: string }).nextCursor);
    if (typeof state === "string") throw new Error(state);
    state.positions.set("top_rated:movie", { page: 1, offset: 0 });
    const { service, calls } = fakeService(w);
    expect((await service.getDeck(USER, { ...request, cursor: encodeCursor(state) })).ok).toBe(true);
    expect(calls.lists.map((c) => c.stream)).toEqual(["popular:movie"]);
  });

  const stale = { ok: false, error: { code: "invalid_deck_query", message: expect.stringContaining("start again without a cursor") } };

  test("a cursor is bound to its user, and names no titles", async () => {
    const w = world({
      ratedCount: FOR_YOU_MIN_RATINGS,
      seeds: [{ mediaType: "movie", tmdbId: 603 }],
      settings: { country: "US", providerIds: [8, 15] },
      lists: { "for_you:movie:603": [range("movie", 100, 30)] },
    });
    const { page, service } = await deck(w, { mode: "for_you" });
    const cursor = (page as { nextCursor: string }).nextCursor;
    const body = Buffer.from(cursor, "base64url").toString("utf8");
    expect(body).not.toContain("603");
    expect(body).not.toContain("US");
    expect(await service.getDeck("user-2", { mode: "for_you", cursor })).toMatchObject(stale);
    // Without "on my services" the lists do not depend on country or services, so changing them keeps the cursor.
    w.settings = { country: "GB", providerIds: [337] };
    expect((await service.getDeck(USER, { mode: "for_you", cursor })).ok).toBe(true);
  });

  test("with on my services, a cursor is also bound to the country and services", async () => {
    const w = world({ settings: { country: "US", providerIds: [8, 15] }, lists: { "popular:movie": [range("movie", 1, 30)] } });
    const request = { mode: "popular" as const, filters: { mediaTypes: ["movie" as const], onMyServices: true } };
    const { page, service } = await deck(w, request);
    const cursor = (page as { nextCursor: string }).nextCursor;
    expect(cursor).not.toBeNull();
    w.settings = { country: "US", providerIds: [15, 8] }; // the same services in another order: the same deck
    expect((await service.getDeck(USER, { ...request, cursor })).ok).toBe(true);
    w.settings = { country: "US", providerIds: [8] };
    expect(await service.getDeck(USER, { ...request, cursor })).toMatchObject(stale);
    w.settings = { country: "GB", providerIds: [8, 15] };
    expect(await service.getDeck(USER, { ...request, cursor })).toMatchObject(stale);
  });
});

describe("getDeck: for you", () => {
  test("locked: returns the lock state with no TMDB calls", async () => {
    const w = world({ ratedCount: FOR_YOU_MIN_RATINGS - 1, lists: { "popular:movie": [range("movie", 1, 3)] } });
    const { page, calls } = await deck(w, { mode: "for_you" });
    expect(page).toEqual({ kind: "locked", mode: "for_you", ratedCount: 9, required: FOR_YOU_MIN_RATINGS, remaining: 1 });
    expect(calls.lists).toEqual([]);
    expect(calls.details).toEqual([]);
  });

  test("locked in the blend: no for-you streams", async () => {
    const w = world({ ratedCount: 3, seeds: [{ mediaType: "movie", tmdbId: 603 }] });
    const { calls } = await deck(w);
    expect(calls.lists.some((c) => c.stream.startsWith("for_you"))).toBe(false);
  });

  test("unlocked: recommendations from the top-rated seeds, taken in turn, in seed order", async () => {
    const w = world({
      ratedCount: FOR_YOU_MIN_RATINGS,
      seeds: [
        { mediaType: "movie", tmdbId: 603 },
        { mediaType: "tv", tmdbId: 1396 },
      ],
      states: [
        { mediaType: "movie", tmdbId: 603, status: "seen" },
        { mediaType: "tv", tmdbId: 1396, status: "seen" },
      ],
      lists: {
        "for_you:movie:603": [range("movie", 100, 3)],
        "for_you:tv:1396": [range("tv", 200, 3)],
      },
    });
    const { page, calls } = await deck(w, { mode: "for_you" });
    expect(calls.seeds).toEqual([{ mediaTypes: ["movie", "tv"], limit: FOR_YOU_SEED_COUNT }]);
    expect(keysOf(cardsOf(page))).toEqual(["movie:100", "tv:200", "movie:101", "tv:201", "movie:102", "tv:202"]);
    expect(cardsOf(page).every((c) => c.source === "for_you")).toBe(true);
  });

  test("seeds follow the media type filter, and the next page continues their streams", async () => {
    const w = world({
      ratedCount: FOR_YOU_MIN_RATINGS,
      seeds: [
        { mediaType: "movie", tmdbId: 603 },
        { mediaType: "tv", tmdbId: 1396 },
      ],
      lists: { "for_you:tv:1396": [range("tv", 200, 20), range("tv", 300, 5)] },
    });
    const request = { mode: "for_you" as const, filters: { mediaTypes: ["tv" as const] } };
    const { page, calls, service } = await deck(w, request);
    expect(calls.seeds[0].mediaTypes).toEqual(["tv"]);
    expect(calls.lists.map((c) => c.stream)).toEqual(["for_you:tv:1396"]);
    const next = await service.getDeck(USER, { ...request, cursor: (page as { nextCursor: string }).nextCursor });
    if (!next.ok) throw new Error("expected ok");
    expect(calls.seeds.length).toBe(2); // seeds are read on every call, never carried in the cursor
    expect(keysOf(cardsOf(next.value))).toEqual(range("tv", 300, 5).map(formatTitleKey));
  });

  test("when the seeds change between pages, each seed keeps its place and a new seed starts at page 1", async () => {
    const w = world({
      ratedCount: FOR_YOU_MIN_RATINGS,
      seeds: [{ mediaType: "movie", tmdbId: 603 }],
      lists: {
        "popular:movie": [range("movie", 1, 30)],
        "for_you:movie:603": [range("movie", 100, 30)],
        "for_you:movie:550": [range("movie", 200, 30)],
      },
    });
    const request = { filters: { mediaTypes: ["movie" as const] } };
    const { page, service } = await deck(w, request);
    w.seeds = [
      { mediaType: "movie", tmdbId: 550 },
      { mediaType: "movie", tmdbId: 603 },
    ];
    const next = await service.getDeck(USER, { ...request, cursor: (page as { nextCursor: string }).nextCursor });
    if (!next.ok) throw new Error("expected ok");
    const from = (source: string) => keysOf(cardsOf(next.value).filter((c) => c.source === source));
    expect(from("popular")[0]).toBe(`movie:${POOL_QUOTA.blend + 1}`); // page 1 took the first 8
    expect(from("for_you")[0]).toBe("movie:200"); // the new top seed, from its start
    expect(from("for_you")).toContain(`movie:${100 + POOL_QUOTA.blend}`); // the old seed, now second, where it stopped
    expect(from("for_you")).not.toContain("movie:100");
  });

  test("unlocked with no seeds of the filtered type: a distinct state, not an empty finished deck", async () => {
    const w = world({ ratedCount: FOR_YOU_MIN_RATINGS, seeds: [{ mediaType: "movie", tmdbId: 603 }] });
    const { page, calls } = await deck(w, { mode: "for_you", filters: { mediaTypes: ["tv"] } });
    expect(page).toEqual({ kind: "no_seeds", mode: "for_you", mediaTypes: ["tv"] });
    expect(calls.lists).toEqual([]);
  });
});

describe("getDeck: on my services", () => {
  test("with no services: an empty, finished page and no TMDB calls", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 3)] } });
    const { page, calls } = await deck(w, { filters: { onMyServices: true } });
    expect(page).toEqual({ kind: "cards", cards: [], nextCursor: null });
    expect(calls.lists).toEqual([]);
  });

  test("passes the user's services and country to discover, and drops titles that do not stream on them", async () => {
    const netflix = provider(8, "Netflix");
    const s1 = summary("tv", 1, { genreIds: [10765] });
    const s2 = summary("tv", 2, { genreIds: [10765] });
    const w = world({
      settings: { country: "GB", providerIds: [8] },
      lists: { "popular:tv": [[s1, s2]] },
      details: {
        "tv:1": detailsFor(s1, { providersByCountry: { GB: emptyCountry({ flatrate: [netflix] }) } }),
        // Streams on Netflix, but not in the user's country.
        "tv:2": detailsFor(s2, { providersByCountry: { US: emptyCountry({ flatrate: [netflix] }) } }),
      },
    });
    // The VISION test case: a modern sci-fi series on something I already pay for.
    const filters = { mediaTypes: ["tv" as const], genreIds: [10765], era: { fromYear: 2015 }, onMyServices: true };
    const { page, calls } = await deck(w, { mode: "popular", filters });
    expect(calls.lists[0].filters).toMatchObject({ mediaType: "tv", providerIds: [8], watchRegion: "GB", genreIds: [10765] });
    const cards = cardsOf(page);
    expect(keysOf(cards)).toEqual(["tv:1"]);
    expect(cards[0].streaming).toMatchObject({ kind: "known", country: "GB", onMyServices: true });
    expect(known(cards[0].streaming).providers[0]).toMatchObject({ id: 8, isMine: true, streams: true, offers: ["subscription"] });
  });

  test("unknown availability (issue 30): left out under the filter, dealt without it with its card saying unknown", async () => {
    const netflix = provider(8, "Netflix");
    const s1 = summary("tv", 1);
    const s2 = summary("tv", 2);
    const s3 = summary("tv", 3);
    const details = {
      "tv:1": detailsFor(s1, { providersByCountry: { GB: emptyCountry({ flatrate: [netflix] }) } }),
      "tv:2": detailsFor(s2, { providersByCountry: null }), // the providers lookup failed, nothing cached
      "tv:3": detailsFor(s3, { providersByCountry: {} }), // known: streams nowhere
    };
    const make = () => world({ settings: { country: "GB", providerIds: [8] }, lists: { "popular:tv": [[s1, s2, s3]] }, details });

    const filtered = cardsOf((await deck(make(), { mode: "popular", filters: { mediaTypes: ["tv"], onMyServices: true } })).page);
    expect(keysOf(filtered)).toEqual(["tv:1"]);

    const all = cardsOf((await deck(make(), { mode: "popular", filters: { mediaTypes: ["tv"] } })).page);
    const byKey = new Map(all.map((c) => [formatTitleKey(c), c.streaming]));
    expect(byKey.get("tv:2") as unknown).toEqual({ kind: "unknown", country: "GB", attribution: JUSTWATCH_ATTRIBUTION, providers: [] }); // providers: [] only for pre-#30 bundles
    expect(byKey.get("tv:3")).toMatchObject({ kind: "known", providers: [], onMyServices: false });
  });
});

describe("getDeck: on my services during a providers outage (issue 104)", () => {
  muteWarnings();

  const netflix = provider(8, "Netflix");
  const mine = { mode: "popular" as const, filters: { mediaTypes: ["movie" as const], onMyServices: true } };
  /** A filtered world whose titles all stream on the user's Netflix, until a test marks some unknown. */
  function onNetflix(pages: ReturnType<typeof range>[]): FakeWorld {
    const w = world({ settings: { country: "US", providerIds: [8] }, lists: { "popular:movie": pages } });
    for (const page of pages) for (const s of page) w.details[formatTitleKey(s)] = detailsFor(s, { providersByCountry: { US: emptyCountry({ flatrate: [netflix] }) } });
    return w;
  }
  function markUnknown(w: FakeWorld, titles: readonly ReturnType<typeof summary>[]) {
    for (const s of titles) w.details[formatTitleKey(s)] = detailsFor(s, { providersByCountry: null });
  }
  const cursorOf = (page: DeckPage) => (page as { nextCursor: string | null }).nextCursor;

  test("most of a page unknown is an outage: it throws, and the same cursor deals those titles once providers are back", async () => {
    const pages = [range("movie", 1, 20), range("movie", 21, 20), range("movie", 41, 20)];
    const w = onNetflix(pages);
    const { page, service } = await deck(w, mine);
    const cursor = cursorOf(page)!;
    // Page 2's details are cached but 15 of its providers lookups fail with nothing cached.
    const healthy = { ...w.details };
    markUnknown(w, pages[1].slice(5));
    await expect(service.getDeck(USER, { ...mine, cursor })).rejects.toThrow(/unknown for 15 of 20 titles/);
    w.details = healthy;
    const healed = await service.getDeck(USER, { ...mine, cursor });
    if (!healed.ok) throw new Error("expected ok");
    expect(keysOf(cardsOf(healed.value))).toEqual(pages[1].map(formatTitleKey));
  });

  test("a few unknown titles are skipped: the rest of the page is dealt, and the cursor moves on", async () => {
    const pages = [range("movie", 1, 20), range("movie", 21, 20)];
    const w = onNetflix(pages);
    markUnknown(w, [pages[0][2], pages[0][9]]);
    const { page } = await deck(w, mine);
    const cards = cardsOf(page);
    expect(cards.length).toBe(18);
    expect(keysOf(cards)).not.toContain("movie:3");
    expect(keysOf(cards)).not.toContain("movie:10");
    const state = decodeCursor(cursorOf(page)!);
    if (typeof state === "string") throw new Error(state);
    expect(state.positions.get("popular:movie")).toEqual({ page: 1, offset: 20 });
  });

  test("unknown titles and failed details count together: neither is most of the page alone, both are", async () => {
    const w = onNetflix([range("movie", 1, 20)]);
    markUnknown(w, range("movie", 1, 6));
    w.failingDetails = new Set(range("movie", 7, 5).map(formatTitleKey));
    const { service } = fakeService(w);
    await expect(service.getDeck(USER, mine)).rejects.toThrow(/unknown for 6 of 20 titles and 5 details lookups failed/);
  });

  test("a few unknown titles never block the deck, even as the last titles left", async () => {
    const pages = [range("movie", 1, 20), range("movie", 21, 2)];
    const w = onNetflix(pages);
    markUnknown(w, [pages[0][0], ...pages[1]]);
    const { service } = fakeService(w);
    const dealt: string[] = [];
    let cursor: string | null = null;
    let calls = 0;
    do {
      const result = await service.getDeck(USER, { ...mine, cursor });
      if (!result.ok) throw new Error("expected ok");
      dealt.push(...keysOf(cardsOf(result.value)));
      cursor = cursorOf(result.value);
    } while (cursor !== null && ++calls < 5);
    expect(cursor).toBeNull();
    expect(dealt).toEqual(range("movie", 2, 19).map(formatTitleKey));
  });

  test("without the filter, the same outage deals every title, each card saying its availability is unknown", async () => {
    const w = onNetflix([range("movie", 1, 20)]);
    markUnknown(w, range("movie", 1, 20));
    const { page } = await deck(w, { ...mine, filters: { mediaTypes: ["movie"] } });
    const cards = cardsOf(page);
    expect(cards.length).toBe(20);
    expect(cards.every((c) => c.streaming.kind === "unknown")).toBe(true);
  });
});

describe("getDeck: failures", () => {
  muteWarnings();

  test("the IMDb store failing still serves the deck, with the rating unavailable", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 2)] }, ratingsThrow: true });
    const { page } = await deck(w, { mode: "popular", filters: { mediaTypes: ["movie"] } });
    const cards = cardsOf(page);
    expect(cards.length).toBe(2);
    expect(cards[0].imdb).toEqual({ kind: "unavailable", imdbId: "tt0000001" });
  });

  test("a title whose details fail is left out, and the rest of the page survives", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 3)] }, failingDetails: new Set(["movie:2"]) });
    const { page } = await deck(w, { mode: "popular", filters: { mediaTypes: ["movie"] } });
    expect(keysOf(cardsOf(page))).toEqual(["movie:1", "movie:3"]);
  });

  test("one failing list: the page serves the others and the cursor keeps the failed stream's place", async () => {
    const w = world({
      lists: { "popular:movie": [range("movie", 1, 25)], "popular:tv": [range("tv", 1, 25)] },
      failingLists: new Set(["popular:tv"]),
    });
    const { page } = await deck(w, { mode: "popular" });
    expect(cardsOf(page).every((c) => c.mediaType === "movie")).toBe(true);
    const state = decodeCursor((page as { nextCursor: string }).nextCursor);
    if (typeof state === "string") throw new Error(state);
    expect(state.positions.get("popular:tv")).toEqual({ page: 1, offset: 0 });
  });

  const moviesOnly = { mode: "popular" as const, filters: { mediaTypes: ["movie" as const] } };

  test("most details lookups failing is an outage: it throws, and the same cursor deals those titles once TMDB is back", async () => {
    const pages = [range("movie", 1, 20), range("movie", 21, 20), range("movie", 41, 20)];
    const w = world({ lists: { "popular:movie": pages } });
    const { page, service } = await deck(w, moviesOnly);
    const cursor = (page as { nextCursor: string }).nextCursor;
    // 19 of page 2's 20 lookups throw, the shape of an outage where only cached details answer.
    w.failingDetails = new Set(pages[1].slice(1).map(formatTitleKey));
    await expect(service.getDeck(USER, { ...moviesOnly, cursor })).rejects.toThrow(/19 of 20 TMDB details lookups failed/);
    // 19 throwing and the other one unknown to TMDB (null) is an outage too.
    w.details["movie:21"] = null;
    await expect(service.getDeck(USER, { ...moviesOnly, cursor })).rejects.toThrow(/19 of 20/);
    delete w.details["movie:21"];
    w.failingDetails = new Set();
    const healed = await service.getDeck(USER, { ...moviesOnly, cursor });
    if (!healed.ok) throw new Error("expected ok");
    expect(keysOf(cardsOf(healed.value))).toEqual(pages[1].map(formatTitleKey));
  });

  test("one failed details lookup of 20 skips just that title: 19 cards, and the cursor moves on", async () => {
    const pages = [range("movie", 1, 20), range("movie", 21, 20)];
    const w = world({ lists: { "popular:movie": pages }, failingDetails: new Set(["movie:5"]) });
    const { page } = await deck(w, moviesOnly);
    const cards = cardsOf(page);
    expect(cards.length).toBe(19);
    expect(keysOf(cards)).not.toContain("movie:5");
    const state = decodeCursor((page as { nextCursor: string }).nextCursor);
    if (typeof state === "string") throw new Error(state);
    expect(state.positions.get("popular:movie")).toEqual({ page: 1, offset: 20 });
  });

  test("a title whose details always fail never blocks the deck, even as the last title left", async () => {
    const pages = [range("movie", 1, 20), range("movie", 21, 1)];
    const w = world({ lists: { "popular:movie": pages }, failingDetails: new Set(["movie:7", "movie:21"]) });
    const { service } = fakeService(w);
    const dealt: string[] = [];
    let cursor: string | null = null;
    let calls = 0;
    do {
      const result = await service.getDeck(USER, { ...moviesOnly, cursor });
      if (!result.ok) throw new Error("expected ok");
      if (result.value.kind !== "cards") throw new Error("expected cards");
      dealt.push(...keysOf(result.value.cards));
      cursor = result.value.nextCursor;
      calls++;
    } while (cursor !== null && calls < 10);
    expect(cursor).toBeNull();
    expect(dealt.length).toBe(19);
    expect(dealt).not.toContain("movie:7");
  });

  test("an empty IMDb ratings table (no daily load yet) reads as unavailable, never as no rating", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 3)] }, ratings: new Map() });
    const { page } = await deck(w, { mode: "popular", filters: { mediaTypes: ["movie"] } });
    expect(cardsOf(page).map((c) => c.imdb.kind)).toEqual(["unavailable", "unavailable", "unavailable"]);
  });

  test("a list TMDB refuses for good ends that stream, so it never blocks the deck as the last one left", async () => {
    const w = world({
      lists: { "popular:movie": [range("movie", 1, 5)], "popular:tv": [range("tv", 1, 5)] },
      refusedLists: new Set(["popular:tv"]),
    });
    const { page } = await deck(w, { mode: "popular" });
    expect(keysOf(cardsOf(page))).toEqual(range("movie", 1, 5).map(formatTitleKey));
    expect((page as { nextCursor: string | null }).nextCursor).toBeNull();
    // A transient failure on the same list keeps its place instead (the test above), so an outage never ends it.
    w.refusedLists = new Set();
    w.failingLists = new Set(["popular:tv"]);
    await expect(fakeService(w).service.getDeck(USER, { mode: "popular", filters: { mediaTypes: ["tv"] } })).rejects.toThrow(
      /every TMDB list lookup failed/,
    );
  });

  test("titles TMDB refuses for good never count as an outage, even a final page of three", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 3)] }, refusedDetails: new Set(["movie:1", "movie:2", "movie:3"]) });
    const { page } = await deck(w, moviesOnly);
    expect(cardsOf(page)).toEqual([]);
    expect((page as { nextCursor: string | null }).nextCursor).toBeNull();
  });

  test("every list failing throws instead of returning a cursor that cannot move", async () => {
    const w = world({ failingLists: new Set(["popular:movie", "popular:tv"]) });
    const { service } = fakeService(w);
    await expect(service.getDeck(USER, { mode: "popular" })).rejects.toThrow(/every TMDB list lookup failed/);
  });

  test("bad mode, filters, or era is a typed error, with no calls", async () => {
    const { service, calls } = fakeService(world());
    for (const request of [
      { mode: "bogus" },
      { filters: { mediaTypes: "tv" } },
      { filters: { era: { fromYear: 1500 } } },
      { filters: { era: { toYear: 10_000 } } },
      { filters: { era: { fromYear: 2020, toYear: 2010 } } },
      "not an object",
    ]) {
      const result = await service.getDeck(USER, request as never);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_deck_query" } });
    }
    expect(await service.getDeck("", {})).toMatchObject({ ok: false, error: { code: "invalid_user" } });
    expect(calls.lists).toEqual([]);
  });
});

describe("getDeck: minimum IMDb rating (issue 52)", () => {
  muteWarnings();
  const tt = (id: number) => `tt${String(id).padStart(7, "0")}`;
  const moviesAt = (min: number) => ({ mode: "popular" as const, filters: { mediaTypes: ["movie" as const], minImdbRating: min } });

  test("deals only titles IMDb rates at or above the minimum, and still looks up every title it reads", async () => {
    const w = world({
      lists: { "popular:movie": [range("movie", 1, 6)] },
      // movie:5 has no dataset row, movie:6 no IMDb ID at all. Both have a high TMDB vote average (the fake's 7.5).
      details: { "movie:6": detailsFor(summary("movie", 6), { imdbId: null }) },
      ratings: new Map([
        [tt(1), { rating: 8.2, votes: 90_000 }],
        [tt(2), { rating: 7.5, votes: 3_000 }],
        [tt(3), { rating: 7.4, votes: 50_000 }],
        [tt(4), { rating: 5.1, votes: 200 }],
      ]),
    });
    const { page, calls } = await deck(w, moviesAt(7.5));
    const cards = cardsOf(page);
    expect(keysOf(cards)).toEqual(["movie:1", "movie:2"]);
    expect(cards.map((c) => c.imdb.kind === "rated" && c.imdb.rating)).toEqual([8.2, 7.5]);
    // A list summary carries no IMDb data, so the rating can't be checked before the details: all six were read.
    expect(calls.details.sort()).toEqual(range("movie", 1, 6).map(formatTitleKey).sort());
    expect(calls.lists[0].filters).toEqual({ mediaType: "movie" });
  });

  test("a thin deck pages forward to its end: each call moves the cursor, and the last one is null", async () => {
    const pages = Array.from({ length: 4 }, (_, p) => range("movie", p * 20 + 1, 20));
    // One title in twenty clears the bar.
    const ratings = new Map(pages.flat().map((s) => [tt(s.tmdbId), { rating: s.tmdbId % 20 === 7 ? 8.5 : 6.5, votes: 9_000 }]));
    const { service } = fakeService(world({ lists: { "popular:movie": pages }, ratings }));
    const dealt: string[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    let calls = 0;
    do {
      const result = await service.getDeck(USER, { ...moviesAt(8), cursor });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const page = result.value as { cards: DeckPageCard[]; nextCursor: string | null };
      dealt.push(...keysOf(page.cards));
      expect(page.nextCursor === null || !seen.has(page.nextCursor)).toBe(true);
      if (page.nextCursor) seen.add(page.nextCursor);
      cursor = page.nextCursor;
      calls++;
    } while (cursor !== null && calls < 20);
    expect(cursor).toBeNull();
    expect(dealt).toEqual(["movie:7", "movie:27", "movie:47", "movie:67"]);
  });

  test("ratings that can't be read are an outage: it throws, never deals an empty page that moves the cursor", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 3)] }, ratingsThrow: true });
    await expect(fakeService(w).service.getDeck(USER, moviesAt(7))).rejects.toThrow(/IMDb ratings are unavailable/);
    // An empty table (the first daily load has not landed) too.
    const empty = world({ lists: { "popular:movie": [range("movie", 1, 3)] }, ratings: new Map() });
    await expect(fakeService(empty).service.getDeck(USER, moviesAt(7))).rejects.toThrow(/IMDb ratings are unavailable/);
    // Without a minimum the same outage still serves the deck (the rating shows as unavailable).
    expect(cardsOf((await deck(w, { mode: "popular", filters: { mediaTypes: ["movie"] } })).page).length).toBe(3);
  });

  test("a cursor is bound to its minimum, and cursors from before the filter existed still continue", async () => {
    const pages = Array.from({ length: 5 }, (_, p) => range("movie", p * 20 + 1, 20));
    const w = world({ lists: { "popular:movie": pages }, ratings: new Map([[tt(1), { rating: 9, votes: 1 }]]) });
    const { page, service } = await deck(w, moviesAt(7.5));
    const cursor = (page as { nextCursor: string }).nextCursor;
    expect(cursor).toBeTruthy();
    for (const filters of [{ mediaTypes: ["movie" as const] }, { mediaTypes: ["movie" as const], minImdbRating: 8 }]) {
      expect(await service.getDeck(USER, { mode: "popular", filters, cursor })).toMatchObject({
        ok: false,
        error: { code: "invalid_deck_query" },
      });
    }
    expect((await service.getDeck(USER, { ...moviesAt(7.5), cursor })).ok).toBe(true);
    // No minimum: the same canonical string as before this filter, so a cursor issued before the deploy stays valid.
    expect(canonicalFilters({ mediaTypes: ["movie"], onMyServices: true })).toBe('{"t":["movie"],"g":[],"y":[null,null],"s":true}');
  });

  test("a thin page reaches deeper, within a fixed bound: up to MIN_RATING_TAKE_ROUNDS rounds of the quota", async () => {
    // Ten pages of twenty; only every twentieth title clears 8, so one round of 20 finds one card at most.
    const pages = Array.from({ length: 10 }, (_, p) => range("movie", p * 20 + 1, 20));
    const ratings = new Map(pages.flat().map((s) => [tt(s.tmdbId), { rating: s.tmdbId % 20 === 3 ? 8.4 : 6.1, votes: 9_000 }]));
    const w = world({ lists: { "popular:movie": pages }, ratings });
    const { page, calls } = await deck(w, moviesAt(8));
    // Three rounds of 20 read 60 titles and found the three that clear the bar, then stopped at the bound.
    expect(keysOf(cardsOf(page))).toEqual(["movie:3", "movie:23", "movie:43"]);
    expect(calls.stats[0].detailLookups).toBe(POOL_QUOTA.single * MIN_RATING_TAKE_ROUNDS);
    expect(calls.stats[0].listLookups).toBeLessThanOrEqual(MAX_PAGES_PER_STREAM);
    expect((page as { nextCursor: string | null }).nextCursor).toBeTruthy();
    // Without a minimum the same deck takes one round, as before.
    const plain = await deck(w, { mode: "popular", filters: { mediaTypes: ["movie"] } });
    expect(plain.calls.stats[0].detailLookups).toBe(POOL_QUOTA.single);
  });

  test("deeper rounds stop once the page has enough cards", async () => {
    const pages = Array.from({ length: 10 }, (_, p) => range("movie", p * 20 + 1, 20));
    // A quarter clear the bar: the first round of 20 deals 5, which meets the target.
    const ratings = new Map(pages.flat().map((s) => [tt(s.tmdbId), { rating: s.tmdbId % 4 === 0 ? 8 : 6, votes: 9_000 }]));
    const { page, calls } = await deck(world({ lists: { "popular:movie": pages }, ratings }), moviesAt(7.5));
    expect(cardsOf(page).length).toBeGreaterThanOrEqual(MIN_RATING_PAGE_TARGET);
    expect(calls.stats[0].detailLookups).toBe(POOL_QUOTA.single);
  });

  test("the blend's deeper reach stays within its stated bound, and never deals a title twice", async () => {
    const lists: FakeWorld["lists"] = {};
    for (const pool of ["popular", "deep_cuts", "top_rated"]) {
      for (const mt of ["movie", "tv"] as const) lists[`${pool}:${mt}`] = Array.from({ length: 10 }, (_, p) => range(mt, p * 20 + 1, 20, TOP));
    }
    // Nothing clears 9.5, so every round runs.
    const ratings = new Map(Array.from({ length: 200 }, (_, i) => [tt(i + 1), { rating: 7, votes: 9_000 }]));
    const { calls, page } = await deck(world({ lists, ratings }), { mode: "blend", filters: { minImdbRating: 9.5 } });
    expect(cardsOf(page)).toEqual([]);
    const stats = calls.stats[0];
    expect(stats.detailLookups).toBeLessThanOrEqual(POOL_QUOTA.blend * 4 * MIN_RATING_TAKE_ROUNDS);
    expect(stats.listLookups).toBeLessThanOrEqual(MAX_PAGES_PER_STREAM * 3 * 2);
    expect(new Set(calls.details).size).toBe(calls.details.length);
    expect((page as { nextCursor: string | null }).nextCursor).toBeTruthy();
  });

  test("a minimum that is not a number from 0 to 10 is a typed error, with no calls", async () => {
    const { service, calls } = fakeService(world());
    for (const minImdbRating of [11, -1, "7", Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await service.getDeck(USER, { filters: { minImdbRating } } as never);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_deck_query" } });
    }
    expect(calls.lists).toEqual([]);
  });
});

describe("getDeck: the bound on TMDB work", () => {
  test("the blend with both media types and every seed stays within the stated bound", async () => {
    const seeds = Array.from({ length: FOR_YOU_SEED_COUNT + 2 }, (_, i) => ({ mediaType: "movie" as const, tmdbId: 9000 + i }));
    const lists: FakeWorld["lists"] = {};
    for (const pool of ["popular", "deep_cuts", "top_rated"]) {
      for (const mt of ["movie", "tv"] as const) lists[`${pool}:${mt}`] = Array.from({ length: 10 }, (_, p) => range(mt, p * 20 + 1, 20, TOP));
    }
    for (const s of seeds) lists[`for_you:movie:${s.tmdbId}`] = Array.from({ length: 10 }, (_, p) => range("movie", 5000 + p * 20, 20));
    const w = world({ lists, seeds, ratedCount: 50 });
    const { calls } = await deck(w);
    const stats = calls.stats[0];
    expect(stats.listLookups).toBeLessThanOrEqual(MAX_PAGES_PER_STREAM * (3 * 2 + FOR_YOU_SEED_COUNT));
    expect(stats.detailLookups).toBeLessThanOrEqual(POOL_QUOTA.blend * 4);
    expect(new Set(calls.lists.filter((c) => c.stream.startsWith("for_you")).map((c) => c.stream)).size).toBe(FOR_YOU_SEED_COUNT);
  });
});

describe("getCard", () => {
  muteWarnings();

  const s = summary("movie", 603);
  const netflix = provider(8, "Netflix", 1);
  const apple = provider(2, "Apple TV", 5);
  const hulu = provider(15, "Hulu", 3);
  const base = () =>
    world({
      settings: { country: "US", providerIds: [15] },
      details: {
        "movie:603": detailsFor(s, {
          providersByCountry: {
            US: emptyCountry({ link: "https://tmdb.example/603", flatrate: [netflix, hulu], rent: [apple], buy: [apple] }),
          },
        }),
        "tv:603": null,
      },
      ratings: new Map([["tt0000603", { rating: 8.7, votes: 2_000_000 }]]),
      rows: { "movie:603": { status: "seen", rating: 4.5, review: "Great.", skipUntil: null } },
    });

  test("returns the full card with the user's status, so Search shows the same card", async () => {
    const { service } = fakeService(base());
    const result = await service.getCard(USER, { mediaType: "movie", tmdbId: 603 });
    if (!result.ok) throw new Error("expected ok");
    const card = result.value;
    expect(card).toMatchObject({
      mediaType: "movie",
      tmdbId: 603,
      title: "movie 603",
      year: 2020,
      genres: [{ id: 18, name: "Genre 18" }],
      runtimeMinutes: 120,
      numberOfSeasons: null,
      imdb: { kind: "rated", imdbId: "tt0000603", rating: 8.7, votes: 2_000_000 },
      synopsis: "About movie 603.",
      trailerYouTubeKey: "yt603",
      userState: { status: "seen", rating: 4.5, review: "Great." },
    });
    expect(known(card.streaming).link).toBe("https://tmdb.example/603");
    expect(known(card.streaming).onMyServices).toBe(true);
    expect(card.streaming.attribution).toEqual(JUSTWATCH_ATTRIBUTION);
    // Mine first, then other streaming services, then rent or buy only.
    expect(known(card.streaming).providers.map((p) => [p.name, p.isMine, p.offers])).toEqual([
      ["Hulu", true, ["subscription"]],
      ["Netflix", false, ["subscription"]],
      ["Apple TV", false, ["rent", "buy"]],
    ]);
    expect(known(card.streaming).providers[0].logoUrl).toBe("https://image.tmdb.org/t/p/w92/logo15.png");
  });

  test("an expired skip shows as no status, a live skip as skipped (the deck's rule, as in Search)", async () => {
    const expired = base();
    expired.rows["movie:603"] = { status: "skipped", rating: null, review: null, skipUntil: new Date(NOW.getTime() - 1000) };
    expect(await fakeService(expired).service.getCard(USER, { mediaType: "movie", tmdbId: 603 })).toMatchObject({ ok: true, value: { userState: null } });
    const live = base();
    const until = new Date(NOW.getTime() + 86_400_000);
    live.rows["movie:603"] = { status: "skipped", rating: null, review: null, skipUntil: until };
    expect(await fakeService(live).service.getCard(USER, { mediaType: "movie", tmdbId: 603 })).toMatchObject({
      ok: true,
      value: { userState: { status: "skipped", skipUntil: until } },
    });
  });

  test("a title TMDB does not know is unknown_title", async () => {
    const { service } = fakeService(base());
    expect(await service.getCard(USER, { mediaType: "tv", tmdbId: 603 })).toEqual({ ok: false, error: { code: "unknown_title" } });
  });

  test("a bad reference is invalid_title, with no TMDB call", async () => {
    const { service, calls } = fakeService(base());
    for (const ref of [{ mediaType: "person", tmdbId: 1 }, { mediaType: "movie", tmdbId: 0 }, null]) {
      const result = await service.getCard(USER, ref as never);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_title" } });
    }
    expect(calls.details).toEqual([]);
  });

  test("no country listing: no providers, not on my services", async () => {
    const w = base();
    w.settings = { country: "DE", providerIds: [15] };
    const result = await fakeService(w).service.getCard(USER, { mediaType: "movie", tmdbId: 603 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.streaming).toMatchObject({ kind: "known", country: "DE", providers: [], onMyServices: false, link: null });
  });

  test("availability unknown (issue 30): the card says unknown, with the JustWatch credit, not an empty provider list", async () => {
    const w = base();
    w.details["movie:603"] = detailsFor(s, { providersByCountry: null });
    const result = await fakeService(w).service.getCard(USER, { mediaType: "movie", tmdbId: 603 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.streaming as unknown).toEqual({ kind: "unknown", country: "US", attribution: JUSTWATCH_ATTRIBUTION, providers: [] }); // providers: [] only for pre-#30 bundles, outside the type
  });

  test("IMDb: none without a mapping or a dataset row, unavailable when the lookup fails or the table is empty", async () => {
    const w = base();
    w.details["movie:603"] = detailsFor(s, { imdbId: null });
    expect((await fakeService(w).service.getCard(USER, { mediaType: "movie", tmdbId: 603 })) as unknown).toMatchObject({
      ok: true,
      value: { imdb: { kind: "none", imdbId: null } },
    });
    // The table is loaded (it holds another title's row), so a missing row means IMDb has no rating. That answer is cached.
    const w2 = base();
    w2.ratings = new Map([["tt0000001", { rating: 7, votes: 100 }]]);
    const { service: s2, calls: c2 } = fakeService(w2);
    for (let i = 0; i < 2; i++) {
      expect(await s2.getCard(USER, { mediaType: "movie", tmdbId: 603 })).toMatchObject({
        value: { imdb: { kind: "none", imdbId: "tt0000603" } },
      });
    }
    expect(c2.ratingProbes).toBe(1);
    // An empty table says nothing about IMDb. It is asked about again next time, so the first load shows at once.
    const w4 = base();
    w4.ratings = new Map();
    const { service: s4, calls: c4 } = fakeService(w4);
    expect(await s4.getCard(USER, { mediaType: "movie", tmdbId: 603 })).toMatchObject({
      value: { imdb: { kind: "unavailable", imdbId: "tt0000603" } },
    });
    w4.ratings.set("tt0000603", { rating: 8.7, votes: 2_000_000 });
    expect(await s4.getCard(USER, { mediaType: "movie", tmdbId: 603 })).toMatchObject({ value: { imdb: { kind: "rated" } } });
    expect(c4.ratingProbes).toBe(1);
    const w3 = base();
    w3.ratingsThrow = true;
    expect(await fakeService(w3).service.getCard(USER, { mediaType: "movie", tmdbId: 603 })).toMatchObject({
      value: { imdb: { kind: "unavailable", imdbId: "tt0000603" } },
    });
  });
});

describe("hiddenTitles", () => {
  // NOW is 2026-11-07T12:00:00Z (test-fakes).
  const states: UserTitleState[] = [
    { mediaType: "tv", tmdbId: 2734, status: "watchlist" },
    { mediaType: "movie", tmdbId: 2, status: "passed" },
    { mediaType: "movie", tmdbId: 3, status: "seen" },
    { mediaType: "movie", tmdbId: 4, status: "skipped", skipUntil: new Date("2026-11-21T12:00:00Z") },
    { mediaType: "movie", tmdbId: 5, status: "skipped", skipUntil: new Date("2026-11-01T00:00:00Z") },
  ];
  const ref = (mediaType: "movie" | "tv", tmdbId: number) => ({ mediaType, tmdbId });

  test("returns the titles on a list or skipped until later, by the deck's own rule", async () => {
    const { service, calls } = fakeService(world({ states }));
    const asked = [ref("tv", 2734), ref("movie", 2), ref("movie", 3), ref("movie", 4), ref("movie", 5), ref("movie", 6)];
    const result = await service.hiddenTitles(USER, asked);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    // movie:5's skip has expired (that is how the deck dealt it), and movie:6 has no row: both stay.
    expect(keysOf(result.value)).toEqual(["tv:2734", "movie:2", "movie:3", "movie:4"]);
    // One read, for exactly the titles asked about.
    expect(calls.stateLookups).toEqual([keysOf(asked)]);
  });

  test("keeps a movie and a series with the same TMDB ID apart", async () => {
    const { service } = fakeService(world({ states }));
    expect(await service.hiddenTitles(USER, [ref("movie", 2734), ref("tv", 2)])).toEqual({ ok: true, value: [] });
  });

  test("asks about each title once, and an empty list reads nothing", async () => {
    const { service, calls } = fakeService(world({ states }));
    const result = await service.hiddenTitles(USER, [ref("movie", 2), ref("movie", 2)]);
    expect(result.ok && keysOf(result.value)).toEqual(["movie:2"]);
    expect(await service.hiddenTitles(USER, [])).toEqual({ ok: true, value: [] });
    expect(calls.stateLookups).toEqual([["movie:2"]]);
  });

  test("refuses input that is not a short list of titles, before reading anything", async () => {
    const { service, calls } = fakeService(world({ states }));
    for (const bad of [null, "tv:2734", [{ mediaType: "film", tmdbId: 1 }], [{ mediaType: "tv", tmdbId: -1 }]]) {
      expect(await service.hiddenTitles(USER, bad)).toMatchObject({ ok: false, error: { code: "invalid_title" } });
    }
    const tooMany = Array.from({ length: MAX_HIDDEN_CHECK + 1 }, (_, i) => ref("movie", i + 1));
    expect(await service.hiddenTitles(USER, tooMany)).toMatchObject({ ok: false, error: { code: "invalid_title" } });
    expect(await service.hiddenTitles("", [ref("movie", 2)])).toMatchObject({ ok: false, error: { code: "invalid_user" } });
    expect(calls.stateLookups).toEqual([]);
  });

  test("passes only the identity on, not other fields the caller sent", async () => {
    const { service } = fakeService(world({ states }));
    const result = await service.hiddenTitles(USER, [{ mediaType: "movie", tmdbId: 2, status: "seen", extra: 1 }]);
    expect(result).toEqual({ ok: true, value: [{ mediaType: "movie", tmdbId: 2 }] });
  });
});

describe("getDeck: a fresh deal each new deck", () => {
  const request: DeckRequest = { mode: "popular", filters: { mediaTypes: ["movie"] } };
  const PAGE_SIZE = 4;
  /** A popular movie list of `pages` pages. Page n holds IDs (n - 1) * 100 + 1 and up, so an ID names its page. */
  const listOf = (pages: number) => Array.from({ length: pages }, (_, i) => range("movie", i * 100 + 1, PAGE_SIZE));
  const pageOfId = (tmdbId: number) => Math.floor(tmdbId / 100) + 1;
  const order = (seed: string) => seededFrontWeightedOrder(SHUFFLE_WINDOW_PAGES, seed, "pages|popular:movie", SHUFFLE_FRONT_BIAS);

  /** Pages a deck through to its end. Returns each page's cards and every list page read, in order. */
  async function dealAll(w: FakeWorld) {
    const { service, calls } = fakeService(w);
    const dealt: DeckPageCard[][] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const result = await service.getDeck(USER, { ...request, cursor });
      if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
      const page = result.value;
      if (page.kind !== "cards") throw new Error("expected cards");
      dealt.push(page.cards);
      cursor = page.nextCursor;
    } while (cursor !== null && ++guard < 100);
    expect(cursor).toBeNull();
    return { dealt, cards: dealt.flat(), pagesRead: calls.lists.map((c) => c.page), calls };
  }

  test("reads the window's pages in the seed's order, then the rest in TMDB's order, each page and title exactly once", async () => {
    const total = SHUFFLE_WINDOW_PAGES + 3;
    const { cards, pagesRead } = await dealAll(world({ lists: { "popular:movie": listOf(total) }, shuffleSeed: "s1" }));
    expect(pagesRead).toEqual([...order("s1"), total - 2, total - 1, total]);
    expect(pagesRead.slice(0, SHUFFLE_WINDOW_PAGES)).not.toEqual(Array.from({ length: SHUFFLE_WINDOW_PAGES }, (_, i) => i + 1));
    expect(new Set(keysOf(cards)).size).toBe(total * PAGE_SIZE);
    expect(cards).toHaveLength(total * PAGE_SIZE);
  });

  test("the same mode and filters open on a different run of cards each time", async () => {
    const w = world({ lists: { "popular:movie": listOf(SHUFFLE_WINDOW_PAGES) } });
    const openings = new Set<string>();
    const firstCards = new Set<string>();
    for (let i = 0; i < 40; i++) {
      w.shuffleSeed = `deal-${i}`;
      const cards = cardsOf((await deck(w, request)).page);
      openings.add(keysOf(cards).join(","));
      firstCards.add(keysOf(cards)[0]);
    }
    expect(openings.size).toBe(40);
    // Not only a new order of the same top titles: the opening card comes from all over the window.
    expect(new Set([...firstCards].map((k) => pageOfId(Number(k.split(":")[1])))).size).toBeGreaterThan(8);
  });

  test("the same seed is the same deck, page for page", async () => {
    const lists = { "popular:movie": listOf(SHUFFLE_WINDOW_PAGES + 2) };
    const a = await dealAll(world({ lists, shuffleSeed: "s1" }));
    const b = await dealAll(world({ lists, shuffleSeed: "s1" }));
    expect(b.dealt.map(keysOf)).toEqual(a.dealt.map(keysOf));
    const c = await dealAll(world({ lists, shuffleSeed: "s2" }));
    expect(keysOf(c.cards)).not.toEqual(keysOf(a.cards));
    expect(keysOf(c.cards).sort()).toEqual(keysOf(a.cards).sort());
  });

  test("a page's titles are dealt in the seed's order, not ranked", async () => {
    const w = world({ lists: { "popular:movie": [range("movie", 1, 20)] }, shuffleSeed: "s1" });
    const got = keysOf(cardsOf((await deck(w, request)).page));
    const ranked = range("movie", 1, 20).map((s) => `movie:${s.tmdbId}`);
    expect([...got].sort()).toEqual([...ranked].sort());
    expect(got).not.toEqual(ranked);
  });

  test("the cursor carries the seed, so one deck keeps its deal even when new decks would get another", async () => {
    const total = SHUFFLE_WINDOW_PAGES;
    const w = world({ lists: { "popular:movie": listOf(total) }, shuffleSeed: "s1" });
    const { service, calls } = fakeService(w);
    const first = await service.getDeck(USER, request);
    if (!first.ok || first.value.kind !== "cards") throw new Error("expected cards");
    const cursor = first.value.nextCursor!;
    const state = decodeCursor(cursor);
    if (typeof state === "string") throw new Error(state);
    expect(state.seed).toBe("s1");

    w.shuffleSeed = "s2";
    const seen = new Set(keysOf(first.value.cards));
    let next: string | null = cursor;
    while (next !== null) {
      const result = await service.getDeck(USER, { ...request, cursor: next });
      if (!result.ok || result.value.kind !== "cards") throw new Error("expected cards");
      for (const key of keysOf(result.value.cards)) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      next = result.value.nextCursor;
    }
    expect(calls.lists.map((c) => c.page)).toEqual(order("s1"));
    expect(seen.size).toBe(total * PAGE_SIZE);
  });

  test("a short list: a first page past its end costs one extra lookup, then only pages that exist are read", async () => {
    // A seed whose order opens past page 2, with page 2 before page 1, so the test also sees the order kept.
    const seed = Array.from({ length: 500 }, (_, i) => `short-${i}`).find((s) => {
      const o = order(s);
      return o[0] > 2 && o.indexOf(2) < o.indexOf(1);
    })!;
    const { cards, pagesRead, dealt } = await dealAll(world({ lists: { "popular:movie": listOf(2) }, shuffleSeed: seed }));
    expect(pagesRead).toEqual([order(seed)[0], 2, 1]);
    expect(keysOf(cards).sort()).toEqual(keysOf([...range("movie", 1, PAGE_SIZE), ...range("movie", 101, PAGE_SIZE)]).sort());
    // One call: the miss, both real pages, and the end all fit the per-stream page budget.
    expect(dealt).toHaveLength(1);
  });

  test("a list with nothing in it is a finished deck, not a stuck one", async () => {
    const { page, calls } = await deck(world({ lists: { "popular:movie": [] }, shuffleSeed: "s1" }), request);
    expect(page).toEqual({ kind: "cards", cards: [], nextCursor: null });
    expect(calls.lists).toHaveLength(1);
  });

  test("a user who has sorted whole pages skips past them in the seed's order, within the page budget", async () => {
    const o = order("s1");
    const sorted = (page: number): UserTitleState[] =>
      range("movie", (page - 1) * 100 + 1, PAGE_SIZE).map((s) => ({ mediaType: "movie", tmdbId: s.tmdbId, status: "passed" }));
    const w = world({
      lists: { "popular:movie": listOf(SHUFFLE_WINDOW_PAGES) },
      states: [...sorted(o[0]), ...sorted(o[1])],
      shuffleSeed: "s1",
    });
    const { page, calls } = await deck(w, request);
    expect(calls.lists.map((c) => c.page)).toEqual(o.slice(0, MAX_PAGES_PER_STREAM));
    expect(new Set(cardsOf(page).map((c) => pageOfId(c.tmdbId)))).toEqual(new Set([o[2]]));
  });

  test("each stream gets its own page order from the one seed", async () => {
    const lists = { "popular:movie": listOf(SHUFFLE_WINDOW_PAGES), "popular:tv": Array.from({ length: SHUFFLE_WINDOW_PAGES }, (_, i) => range("tv", i * 100 + 1, PAGE_SIZE)) };
    let different = 0;
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const { calls } = await deck(world({ lists, shuffleSeed: seed }), { mode: "popular" });
      const first = (stream: string) => calls.lists.find((c) => c.stream === stream)!.page;
      if (first("popular:movie") !== first("popular:tv")) different++;
    }
    expect(different).toBeGreaterThan(0);
  });

  test("with no seed maker given, every new deck gets its own random seed", async () => {
    const w = world({ lists: { "popular:movie": listOf(SHUFFLE_WINDOW_PAGES) }, randomSeeds: true });
    const { service } = fakeService(w);
    const seedsSeen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = await service.getDeck(USER, request);
      if (!result.ok || result.value.kind !== "cards") throw new Error("expected cards");
      const state = decodeCursor(result.value.nextCursor);
      if (typeof state === "string") throw new Error(state);
      expect(isShuffleSeed(state.seed)).toBe(true);
      seedsSeen.add(state.seed!);
    }
    expect(seedsSeen.size).toBe(20);
  });

  test("a cursor from before the shuffle (no seed) continues its deck in ranked order", async () => {
    const w = world({ lists: { "popular:movie": listOf(4) }, shuffleSeed: "s1" });
    const { service, calls } = fakeService(w);
    const first = await service.getDeck(USER, request);
    if (!first.ok || first.value.kind !== "cards") throw new Error("expected cards");
    const context = decodeCursor(first.value.nextCursor);
    if (typeof context === "string") throw new Error(context);
    calls.lists.length = 0;
    const old = encodeCursor({ ...context, seed: null, positions: new Map([["popular:movie", { page: 2, offset: 0 }]]) });
    expect(Buffer.from(old, "base64url").toString("utf8")).not.toContain('"r"');
    const result = await service.getDeck(USER, { ...request, cursor: old });
    if (!result.ok || result.value.kind !== "cards") throw new Error("expected cards");
    expect(calls.lists.map((c) => c.page)).toEqual([2, 3, 4]);
    expect(keysOf(result.value.cards)).toEqual(keysOf([2, 3, 4].flatMap((p) => range("movie", (p - 1) * 100 + 1, PAGE_SIZE))));
  });

  test("a cursor with a tampered seed is a typed error, with no calls", async () => {
    const { service, calls } = fakeService(world({ lists: { "popular:movie": listOf(4) }, shuffleSeed: "s1" }));
    const first = await service.getDeck(USER, request);
    if (!first.ok || first.value.kind !== "cards") throw new Error("expected cards");
    const body = JSON.parse(Buffer.from(first.value.nextCursor!, "base64url").toString("utf8"));
    calls.lists.length = 0;
    for (const r of ["", "a|b", "x".repeat(33), 7, null, { a: 1 }]) {
      const cursor = Buffer.from(JSON.stringify({ ...body, r }), "utf8").toString("base64url");
      expect(await service.getDeck(USER, { ...request, cursor })).toMatchObject({ ok: false, error: { code: "invalid_deck_query", message: "cursor is malformed" } });
    }
    expect(calls.lists).toHaveLength(0);
  });

  test("the blend and for you are shuffled too, and never deal a title twice", async () => {
    const seedsOf: FakeWorld["seeds"] = [{ mediaType: "movie", tmdbId: 9001 }];
    const lists = {
      "popular:movie": [range("movie", 1, 20)],
      "deep_cuts:movie": [range("movie", 101, 20)],
      "top_rated:movie": [range("movie", 201, 20, TOP)],
      "for_you:movie:9001": [range("movie", 301, 20)],
    };
    const filters: DeckFilters = { mediaTypes: ["movie"] };
    const runs = new Set<string>();
    for (const seed of ["a", "b", "c"]) {
      const { page } = await deck(world({ lists, seeds: seedsOf, ratedCount: FOR_YOU_MIN_RATINGS, shuffleSeed: seed }), { filters });
      const cards = cardsOf(page);
      expect(new Set(keysOf(cards)).size).toBe(cards.length);
      expect(new Set(cards.map((c) => c.source))).toEqual(new Set(["popular", "deep_cuts", "top_rated", "for_you"]));
      runs.add(keysOf(cards).join(","));
    }
    expect(runs.size).toBe(3);
  });
});
