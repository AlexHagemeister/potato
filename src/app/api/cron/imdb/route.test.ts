import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GET } from "./route";

// The route's own job is the secret check; what runs after it is tested in
// src/core/imdb/daily-job.test.ts. Here: a refused request starts nothing.
// Any network call (the IMDb download) or database use would go through
// fetch or need DATABASE_URL, so both are fenced off and watched.
const saved = { fetch: globalThis.fetch, secret: process.env.CRON_SECRET, db: process.env.DATABASE_URL };
let fetches = 0;

beforeAll(() => {
  process.env.CRON_SECRET = "route-test-secret";
  delete process.env.DATABASE_URL;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("no network in this test");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = saved.fetch;
  if (saved.secret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved.secret;
  if (saved.db !== undefined) process.env.DATABASE_URL = saved.db;
});

describe("GET /api/cron/imdb", () => {
  for (const [name, headers] of [
    ["no authorization header", {}],
    ["a wrong secret", { authorization: "Bearer not-the-secret" }],
    ["the secret without Bearer", { authorization: "route-test-secret" }],
  ] as const) {
    test(`${name}: 401, and neither the load nor the purge starts`, async () => {
      const res = await GET(new Request("http://localhost/api/cron/imdb", { headers }));
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("Unauthorized");
      expect(fetches).toBe(0);
    });
  }
});
