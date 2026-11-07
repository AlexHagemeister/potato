import { describe, expect, test } from "bun:test";
import { MemoryCacheStore } from "../cache/cache-store";
import { getWatchRegions, normalizeRegions } from "./regions";
import { json, scriptedFetch } from "./test-fixtures";

const payload = {
  results: [
    { iso_3166_1: "US", english_name: "United States", native_name: "United States" },
    { iso_3166_1: "AD", english_name: "Andorra", native_name: "Andorra" },
    { iso_3166_1: "us", english_name: "lowercase" },
    { iso_3166_1: "GB", english_name: "  " },
    { english_name: "No code" },
  ],
};

describe("normalizeRegions", () => {
  test("keeps valid codes, falls back to the code for a blank name, sorts by name", () => {
    expect(normalizeRegions(payload)).toEqual([
      { code: "AD", name: "Andorra" },
      { code: "GB", name: "GB" },
      { code: "US", name: "United States" },
    ]);
  });

  test("handles an empty or odd payload", () => {
    expect(normalizeRegions(null)).toEqual([]);
    expect(normalizeRegions({})).toEqual([]);
  });
});

describe("getWatchRegions", () => {
  test("fetches once, then answers from the cache until it expires", async () => {
    const scripted = scriptedFetch({ "/watch/providers/regions": json(payload) });
    const cache = new MemoryCacheStore();
    const clock = { now: new Date("2026-11-06T12:00:00Z") };
    const opts = { token: "t", cache, fetch: scripted.fetch, now: () => clock.now, sleep: async () => {} };

    const first = await getWatchRegions(opts);
    const second = await getWatchRegions(opts);
    expect(second).toEqual(first);
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0].params.get("language")).toBe("en-US");

    clock.now = new Date(clock.now.getTime() + 13 * 60 * 60 * 1000);
    await getWatchRegions(opts);
    expect(scripted.calls).toHaveLength(2);
  });
});
