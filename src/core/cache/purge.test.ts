import { describe, expect, test } from "bun:test";
import { MemoryCacheStore } from "./cache-store";
import { CACHE_PURGE_BATCH_LIMIT, CACHE_PURGE_GRACE_MS, purgeExpiredCache, runNightlyCachePurge } from "./purge";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.UTC(2026, 10, 27, 3, 0, 0));
const now = () => NOW;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("purgeExpiredCache", () => {
  test("deletes only rows expired for longer than the grace period", async () => {
    const store = new MemoryCacheStore();
    await store.set("long-gone", 1, ago(CACHE_PURGE_GRACE_MS + DAY_MS));
    await store.set("just-past-grace", 2, ago(CACHE_PURGE_GRACE_MS + 1));
    await store.set("at-cutoff", 3, ago(CACHE_PURGE_GRACE_MS));
    await store.set("expired-in-grace", 4, ago(DAY_MS));
    await store.set("fresh", 5, new Date(NOW.getTime() + DAY_MS));

    const result = await purgeExpiredCache({ store, now });

    expect(result).toEqual({ cutoff: ago(CACHE_PURGE_GRACE_MS).toISOString(), deleted: 2, hitLimit: false });
    expect(await store.get("long-gone")).toBeNull();
    expect(await store.get("just-past-grace")).toBeNull();
    // Strictly before the cutoff: a row expiring exactly at it stays.
    expect(await store.get("at-cutoff")).not.toBeNull();
    expect(await store.get("expired-in-grace")).not.toBeNull();
    expect(await store.get("fresh")).not.toBeNull();
    expect(store.size).toBe(3);
  });

  test("the grace period covers more than the longest TMDB TTL (7 days)", () => {
    expect(CACHE_PURGE_GRACE_MS).toBeGreaterThan(7 * DAY_MS);
  });

  test("stops at the limit and says so", async () => {
    const store = new MemoryCacheStore();
    for (let i = 0; i < 5; i++) await store.set(`old-${i}`, i, ago(CACHE_PURGE_GRACE_MS + DAY_MS));
    const first = await purgeExpiredCache({ store, now, limit: 3 });
    expect(first.deleted).toBe(3);
    expect(first.hitLimit).toBe(true);
    const second = await purgeExpiredCache({ store, now, limit: 3 });
    expect(second.deleted).toBe(2);
    expect(second.hitLimit).toBe(false);
    expect(store.size).toBe(0);
  });

  test("an empty cache deletes nothing", async () => {
    expect(await purgeExpiredCache({ store: new MemoryCacheStore(), now })).toMatchObject({ deleted: 0, hitLimit: false });
  });

  test("passes the cutoff and the default limit to the store", async () => {
    const calls: [Date, number][] = [];
    const store = { deleteExpiredBefore: async (cutoff: Date, limit: number) => (calls.push([cutoff, limit]), 0) };
    await purgeExpiredCache({ store, now });
    expect(calls).toEqual([[ago(CACHE_PURGE_GRACE_MS), CACHE_PURGE_BATCH_LIMIT]]);
  });

  test("refuses a bad grace period, limit or clock before touching the store", async () => {
    let touched = false;
    const store = { deleteExpiredBefore: async () => ((touched = true), 0) };
    for (const graceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(purgeExpiredCache({ store, now, graceMs })).rejects.toThrow("grace period");
    }
    for (const limit of [0, -5, 1.5, Number.NaN]) {
      await expect(purgeExpiredCache({ store, now, limit })).rejects.toThrow("limit");
    }
    await expect(purgeExpiredCache({ store, now: () => new Date(Number.NaN) })).rejects.toThrow("invalid date");
    // Finite, but the cutoff it makes is not a date.
    await expect(purgeExpiredCache({ store, now, graceMs: 1e300 })).rejects.toThrow("cutoff is not a valid date");
    expect(touched).toBe(false);
  });
});

describe("runNightlyCachePurge", () => {
  test("reports the purge on success", async () => {
    const store = { deleteExpiredBefore: async () => 7 };
    const outcome = await runNightlyCachePurge(store);
    expect(outcome).toMatchObject({ ok: true, deleted: 7, hitLimit: false });
  });

  test("a store that never answers is cut off at the timeout, not waited on", async () => {
    const store = { deleteExpiredBefore: () => new Promise<number>(() => {}) };
    const original = console.error;
    console.error = () => {};
    try {
      expect(await runNightlyCachePurge(store, { timeoutMs: 50 })).toEqual({ ok: false, error: "timed out after 50 ms" });
    } finally {
      console.error = original;
    }
  });

  test("a failing store is reported, not thrown", async () => {
    const store = {
      deleteExpiredBefore: async (): Promise<number> => {
        throw new Error("connection reset");
      },
    };
    const original = console.error;
    console.error = () => {};
    try {
      expect(await runNightlyCachePurge(store)).toEqual({ ok: false, error: "connection reset" });
    } finally {
      console.error = original;
    }
  });
});
