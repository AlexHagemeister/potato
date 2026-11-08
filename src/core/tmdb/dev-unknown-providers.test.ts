import { describe, expect, test } from "bun:test";
import { MemoryCacheStore } from "../cache/cache-store";
import { createTmdbClient } from "./client";
import { devUnknownProviderTitles, withUnknownProviders, type DevUnknownProvidersEnv } from "./dev-unknown-providers";
import { breakingBadDetails, json, matrixDetails, scriptedFetch } from "./test-fixtures";

const DEV_DB = "postgresql://u:p@host.example/potato_dev?sslmode=require";
const on: DevUnknownProvidersEnv = { nodeEnv: "development", vercelEnv: undefined, databaseUrl: DEV_DB, titles: "movie:603" };

describe("devUnknownProviderTitles: the gate", () => {
  test("on only in local dev against potato_dev, with the variable set", () => {
    expect(devUnknownProviderTitles(on)).toEqual(new Set(["movie:603"]));
  });

  test("off in a build, on Vercel, on any other database, or without the variable", () => {
    for (const env of [
      { ...on, nodeEnv: "production" },
      { ...on, nodeEnv: "test" },
      { ...on, nodeEnv: undefined },
      { ...on, vercelEnv: "preview" },
      { ...on, vercelEnv: "production" },
      { ...on, databaseUrl: "postgresql://u:p@host.example/neondb?sslmode=require" },
      { ...on, databaseUrl: undefined },
      { ...on, titles: undefined },
      { ...on, titles: "" },
      { ...on, titles: "person:1, movie:0, 603" },
    ]) {
      expect(devUnknownProviderTitles(env)).toBeNull();
    }
  });

  test("reads several keys and skips malformed ones", () => {
    expect(devUnknownProviderTitles({ ...on, titles: " movie:603 ,tv:1396,bad,," })).toEqual(new Set(["movie:603", "tv:1396"]));
  });
});

describe("withUnknownProviders", () => {
  test("a listed title's availability becomes unknown once its details are cached; others are untouched", async () => {
    const scripted = scriptedFetch({ "/movie/603": json(matrixDetails), "/tv/1396": json(breakingBadDetails) });
    const seam = withUnknownProviders(new Set(["movie:603"]), new MemoryCacheStore(), scripted.fetch);
    const client = createTmdbClient({ token: "t", cache: seam.cache, fetch: seam.fetch, sleep: async () => {} });
    const warn = console.warn;
    console.warn = () => {};
    try {
      // Cold: one request brings details and providers together, so the first load is known.
      expect((await client.getTitleDetails("movie", 603))?.providersByCountry).not.toBeNull();
      // Warm: details cached, providers hidden, and the providers request fails without reaching TMDB.
      const d = await client.getTitleDetails("movie", 603);
      expect(d?.title).toBe("The Matrix");
      expect(d?.providersByCountry).toBeNull();
      await client.getTitleDetails("tv", 1396);
      expect((await client.getTitleDetails("tv", 1396))?.providersByCountry).not.toBeNull();
    } finally {
      console.warn = warn;
    }
    expect(scripted.calls.map((c) => c.path)).toEqual(["/movie/603", "/tv/1396"]);
  });

  test("getMany hides the same entries, and is left out when the store has none", async () => {
    const store = new MemoryCacheStore();
    const until = new Date(Date.now() + 60_000);
    const hiddenKey = "tmdb:v1:providers:/movie/603/watch/providers";
    const shownKey = "tmdb:v1:providers:/tv/1396/watch/providers";
    await store.set(hiddenKey, {}, until);
    await store.set(shownKey, {}, until);
    const fetchFn = async () => new Response("{}");
    const seam = withUnknownProviders(new Set(["movie:603"]), store, fetchFn);
    expect([...(await seam.cache.getMany!([hiddenKey, shownKey])).keys()]).toEqual([shownKey]);
    expect(await seam.cache.get(hiddenKey)).toBeNull();
    const noBatch = withUnknownProviders(new Set(["movie:603"]), { get: store.get.bind(store), set: store.set.bind(store) }, fetchFn);
    expect(noBatch.cache.getMany).toBeUndefined();
  });
});
