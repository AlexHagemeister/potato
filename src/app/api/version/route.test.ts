import { afterEach, describe, expect, test } from "bun:test";
import { GET } from "./route";

const saved = { sha: process.env.VERCEL_GIT_COMMIT_SHA, env: process.env.VERCEL_ENV };

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("VERCEL_GIT_COMMIT_SHA", saved.sha);
  restore("VERCEL_ENV", saved.env);
});

describe("GET /api/version", () => {
  test("reports the commit and environment when set", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    process.env.VERCEL_ENV = "preview";
    expect(await GET().json()).toEqual({ sha: "abc123", env: "preview" });
  });

  test("an empty value reads as null, like a missing one", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "";
    delete process.env.VERCEL_ENV;
    expect(await GET().json()).toEqual({ sha: null, env: null });
  });
});
