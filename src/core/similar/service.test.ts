import { describe, expect, test } from "bun:test";
import { detailsFor, NOW, summary } from "../deck-service/test-fakes";
import { MemoryRatingsStore } from "../imdb/ratings";
import { fail, ok, type Result } from "../result";
import type { ResultPage, TitleDetails, TitleSummary } from "../tmdb/types";
import { formatTitleKey } from "../title-id";
import type { ImdbRating, TitleId, UserTitleState } from "../types";
import { FAVORITE_MIN_RATING } from "./constants";
import { createSimilarService } from "./service";
import type { SimilarTitle } from "./types";

const USER = "user-1";
const VIEWED: TitleId = { mediaType: "movie", tmdbId: 1 };

interface World {
  /** Recommendation pages by seed key ("movie:1"). Page n is index n - 1. */
  recs: Record<string, TitleSummary[][]>;
  /** Overrides on the default details (built from a summary, IMDb ID tt<padded id>). */
  details?: Record<string, Partial<TitleDetails> | null>;
  ratings?: Map<string, ImdbRating>;
  states?: UserTitleState[];
  liked?: (TitleId & { rating: number })[];
  failingRecs?: Set<string>;
  failingDetails?: Set<string>;
  statesResult?: Result<UserTitleState[]>;
}

const byKey = new Map<string, TitleSummary>();
function s(mediaType: "movie" | "tv", id: number, o: Partial<TitleSummary> = {}) {
  const t = summary(mediaType, id, { tmdbVoteCount: 500, ...o });
  byKey.set(formatTitleKey(t), t);
  return t;
}
const imdbOf = (t: TitleId) => detailsFor(summary(t.mediaType, t.tmdbId)).imdbId!;

function service(w: World) {
  const calls = { recs: [] as string[], details: [] as string[], liked: [] as [number, number][] };
  const ratings = w.ratings ?? new Map([...byKey.values()].map((t) => [imdbOf(t), { rating: 7.5, votes: 20_000 }]));
  const svc = createSimilarService({
    now: () => NOW,
    ratings: new MemoryRatingsStore(ratings),
    tmdb: {
      async recommendations(seed, _filters, page = 1): Promise<ResultPage<TitleSummary>> {
        const key = formatTitleKey(seed);
        calls.recs.push(`${key}#${page}`);
        if (w.failingRecs?.has(`${key}#${page}`)) throw new Error("TMDB 503");
        const pages = w.recs[key] ?? [];
        return { results: pages[page - 1] ?? [], page, totalPages: pages.length };
      },
      async getTitleDetails(mediaType, tmdbId) {
        const key = formatTitleKey({ mediaType, tmdbId });
        calls.details.push(key);
        if (w.failingDetails?.has(key)) throw new Error("TMDB 503");
        const o = w.details?.[key];
        if (o === null) return null;
        const base = byKey.get(key) ?? summary(mediaType, tmdbId);
        return detailsFor(base, o ?? {});
      },
    },
    library: {
      async getUserTitleStates() {
        return w.statesResult ?? ok(w.states ?? []);
      },
      async getFavoriteSeen(_u, minRating, limit) {
        calls.liked.push([minRating, limit]);
        return ok((w.liked ?? []).slice(0, limit));
      },
    },
  });
  return { svc, calls };
}

async function run(w: World): Promise<SimilarTitle[]> {
  const r = await service(w).svc.similarTitles(USER, VIEWED);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
const keys = (out: SimilarTitle[]) => out.map(formatTitleKey);

describe("similarTitles", () => {
  test("TMDB's recommendations, both pages, minus titles on a list or skipped until later", async () => {
    const out = await run({
      recs: { "movie:1": [[s("movie", 10), s("movie", 11)], [s("movie", 12), s("movie", 13)]] },
      states: [
        { mediaType: "movie", tmdbId: 11, status: "watchlist" },
        { mediaType: "movie", tmdbId: 12, status: "skipped", skipUntil: new Date(NOW.getTime() + 86_400_000) },
        // An expired skip is back in the deck, so it shows here too.
        { mediaType: "movie", tmdbId: 13, status: "skipped", skipUntil: new Date(NOW.getTime() - 1) },
      ],
    });
    expect(keys(out)).toEqual(["movie:10", "movie:13"]);
    expect(out[0].imdbRating).toBe(7.5);
  });

  test("liked titles rated FAVORITE_MIN_RATING or more boost the ones they agree on, the viewed title excluded", async () => {
    const { svc, calls } = service({
      recs: {
        "movie:1": [[s("movie", 10), s("movie", 11), s("movie", 12)]],
        "movie:50": [[s("movie", 12)]],
        "tv:60": [[s("movie", 12), s("movie", 11)]],
      },
      details: { "movie:50": { title: "Arrival" }, "tv:60": { title: "Severance" } },
      liked: [
        { ...VIEWED, rating: 10 },
        { mediaType: "movie", tmdbId: 50, rating: 9 },
        { mediaType: "tv", tmdbId: 60, rating: 8 },
      ],
    });
    const r = await svc.similarTitles(USER, VIEWED);
    if (!r.ok) throw new Error();
    expect(keys(r.value)).toEqual(["movie:12", "movie:11", "movie:10"]);
    expect(r.value[0].because).toEqual(["Arrival", "Severance"]);
    expect(r.value[2].because).toEqual([]);
    expect(calls.liked[0][0]).toBe(FAVORITE_MIN_RATING);
    expect(calls.recs.filter((c) => c.startsWith("movie:1#"))).toEqual(["movie:1#1", "movie:1#2"]);
  });

  test("a liked title whose lookups fail only loses its boost", async () => {
    const out = await run({
      recs: { "movie:1": [[s("movie", 10), s("movie", 11)]], "movie:50": [[s("movie", 11)]] },
      liked: [{ mediaType: "movie", tmdbId: 50, rating: 9 }],
      failingRecs: new Set(["movie:50#1"]),
    });
    expect(keys(out)).toEqual(["movie:10", "movie:11"]);
  });

  test("ratings table not loaded yet: the row shows, with no floor and no rating", async () => {
    const out = await run({ recs: { "movie:1": [[s("movie", 10)]] }, ratings: new Map() });
    expect(keys(out)).toEqual(["movie:10"]);
    expect(out[0].imdbRating).toBeNull();
  });

  test("ratings loaded: a title IMDb hasn't rated, or rated low, is left out", async () => {
    const out = await run({
      recs: { "movie:1": [[s("movie", 10), s("movie", 11), s("movie", 12)]] },
      ratings: new Map([
        [imdbOf({ mediaType: "movie", tmdbId: 10 }), { rating: 5.1, votes: 90_000 }],
        [imdbOf({ mediaType: "movie", tmdbId: 12 }), { rating: 8, votes: 90_000 }],
      ]),
    });
    expect(keys(out)).toEqual(["movie:12"]);
  });

  test("a title whose details fail is left out, the rest still show", async () => {
    const out = await run({ recs: { "movie:1": [[s("movie", 10), s("movie", 11)]] }, failingDetails: new Set(["movie:10"]) });
    expect(keys(out)).toEqual(["movie:11"]);
  });

  test("one per franchise", async () => {
    const out = await run({
      recs: { "movie:1": [[s("movie", 10), s("movie", 11), s("movie", 12)]] },
      details: { "movie:10": { collectionId: 9 }, "movie:11": { collectionId: 9 } },
    });
    expect(keys(out)).toEqual(["movie:10", "movie:12"]);
  });

  test("no recommendations: an empty row, without lookups for liked titles", async () => {
    const { svc, calls } = service({ recs: {}, liked: [{ mediaType: "movie", tmdbId: 50, rating: 9 }] });
    expect(await svc.similarTitles(USER, VIEWED)).toEqual(ok([]));
    expect(calls.details).toEqual([]);
  });

  test("TMDB down on the first page throws, a later page failing does not", async () => {
    await expect(run({ recs: { "movie:1": [[s("movie", 10)]] }, failingRecs: new Set(["movie:1#1"]) })).rejects.toThrow();
    const out = await run({ recs: { "movie:1": [[s("movie", 10)], [s("movie", 11)]] }, failingRecs: new Set(["movie:1#2"]) });
    expect(keys(out)).toEqual(["movie:10"]);
  });

  test("bad input and a failed library read are typed errors", async () => {
    const { svc } = service({ recs: {} });
    expect((await svc.similarTitles(USER, { mediaType: "book", tmdbId: 1 } as unknown as TitleId)).ok).toBe(false);
    expect((await svc.similarTitles("", VIEWED)).ok).toBe(false);
    const down = fail({ code: "db_error" } as never);
    expect(await service({ recs: { "movie:1": [[s("movie", 10)]] }, statesResult: down }).svc.similarTitles(USER, VIEWED)).toEqual(down);
  });
});
