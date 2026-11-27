import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CACHE_PURGE_GRACE_MS } from "../cache";
import { DAILY_JOB_RESPONSE_MARGIN_MS, runDailyJob } from "./daily-job";
import { ImdbLoadGuardError, type LoadImdbRatingsResult } from "./loader";

const LOAD = { linesRead: 5, rowsKept: 4, belowMinVotes: 1, malformed: 0, rowsWritten: 4, durationMs: 12 } as LoadImdbRatingsResult;
const BUDGET = 300_000;

let errors: string[];
const original = { log: console.log, error: console.error };
beforeEach(() => {
  errors = [];
  console.log = () => {};
  console.error = (...a: unknown[]) => void errors.push(String(a[0]));
});
afterEach(() => {
  console.log = original.log;
  console.error = original.error;
});

/** A store that records each call and answers with `answer`. */
function recordingStore(answer: () => Promise<number>) {
  const calls: [Date, number][] = [];
  return {
    calls,
    deleteExpiredBefore: (cutoff: Date, limit: number) => {
      calls.push([cutoff, limit]);
      return answer();
    },
  };
}

describe("runDailyJob", () => {
  test("load ok, purge ok: 200 with the load's fields and the purge result", async () => {
    const store = recordingStore(async () => 3);
    const before = Date.now();
    const { status, body } = await runDailyJob({ loadRatings: async () => LOAD, cacheStore: store, budgetMs: BUDGET });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ...LOAD, tmdbCachePurge: { ok: true, deleted: 3, hitLimit: false } });
    expect(store.calls.length).toBe(1);
    expect(store.calls[0][0].getTime()).toBeGreaterThanOrEqual(before - CACHE_PURGE_GRACE_MS);
    expect(errors).toEqual([]);
  });

  test("load ok, purge fails: still 200, the load's fields unchanged, the failure reported and logged", async () => {
    const store = recordingStore(async () => {
      throw new Error("connection reset");
    });
    const { status, body } = await runDailyJob({ loadRatings: async () => LOAD, cacheStore: store, budgetMs: BUDGET });
    expect(status).toBe(200);
    expect(body).toEqual({ ...LOAD, tmdbCachePurge: { ok: false, error: "connection reset" } });
    expect(errors).toEqual(["TMDB CACHE PURGE FAILED: connection reset"]);
  });

  test("load throws: 500 with the load's error, and the purge still runs once", async () => {
    const store = recordingStore(async () => 2);
    const { status, body } = await runDailyJob({
      loadRatings: async () => {
        throw new Error("download failed");
      },
      cacheStore: store,
      budgetMs: BUDGET,
    });
    expect(status).toBe(500);
    expect(body).toEqual({
      ok: false,
      guard: false,
      error: "download failed",
      tmdbCachePurge: expect.objectContaining({ ok: true, deleted: 2 }),
    });
    expect(store.calls.length).toBe(1);
    expect(errors).toEqual(["IMDB RATINGS LOAD FAILED: download failed"]);
  });

  test("the load's guard stops the swap: 500 with guard true, purge still runs", async () => {
    const store = recordingStore(async () => 0);
    const { status, body } = await runDailyJob({
      loadRatings: async () => {
        throw new ImdbLoadGuardError("too few rows");
      },
      cacheStore: store,
      budgetMs: BUDGET,
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, guard: true, tmdbCachePurge: { ok: true } });
    expect(store.calls.length).toBe(1);
  });

  test("a purge that stalls is cut off at the time left, and the load's 200 is still sent", async () => {
    const store = recordingStore(() => new Promise<number>(() => {})); // never settles
    // The load "took" all but 200 ms over the response margin, so the purge gets 1200 ms.
    let t = 0;
    const now = () => (t++ === 0 ? 0 : BUDGET - DAILY_JOB_RESPONSE_MARGIN_MS - 1_200);
    const start = Date.now();
    const { status, body } = await runDailyJob({ loadRatings: async () => LOAD, cacheStore: store, budgetMs: BUDGET, now });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(status).toBe(200);
    expect(body.tmdbCachePurge).toEqual({ ok: false, error: "timed out after 1200 ms" });
    expect(errors).toEqual(["TMDB CACHE PURGE FAILED: timed out after 1200 ms"]);
  });

  test("too little time left after the load: the purge is skipped, not started", async () => {
    const store = recordingStore(async () => 1);
    let t = 0;
    const now = () => (t++ === 0 ? 0 : BUDGET - DAILY_JOB_RESPONSE_MARGIN_MS - 500);
    const { status, body } = await runDailyJob({ loadRatings: async () => LOAD, cacheStore: store, budgetMs: BUDGET, now });
    expect(status).toBe(200);
    expect(body.tmdbCachePurge).toEqual({ ok: false, error: "skipped: only 500 ms left in the budget" });
    expect(store.calls.length).toBe(0);
  });
});
