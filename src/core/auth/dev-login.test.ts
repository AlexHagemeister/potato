import { describe, expect, test } from "bun:test";
import { createDevSession, isDevLoginEnabled } from "./dev-login";

describe("isDevLoginEnabled", () => {
  test("enabled only in local development", () => {
    expect(isDevLoginEnabled({ NODE_ENV: "development" })).toBe(true);
  });

  test("disabled in production and test builds", () => {
    expect(isDevLoginEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isDevLoginEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(isDevLoginEnabled({})).toBe(false);
  });

  test("disabled on every Vercel environment, even with NODE_ENV=development", () => {
    for (const VERCEL_ENV of ["production", "preview", "development"]) {
      expect(isDevLoginEnabled({ NODE_ENV: "development", VERCEL_ENV })).toBe(false);
    }
  });

  test("an empty VERCEL_ENV counts as unset", () => {
    expect(isDevLoginEnabled({ NODE_ENV: "development", VERCEL_ENV: "" })).toBe(true);
  });

  test("NODE_ENV must match exactly", () => {
    expect(isDevLoginEnabled({ NODE_ENV: "Development" })).toBe(false);
    expect(isDevLoginEnabled({ NODE_ENV: "development " })).toBe(false);
  });
});

describe("createDevSession", () => {
  test("refuses to run when the gate is closed, before touching auth or the database", async () => {
    await expect(createDevSession({ NODE_ENV: "production" })).rejects.toThrow(
      "Dev login is disabled",
    );
    await expect(
      createDevSession({ NODE_ENV: "development", VERCEL_ENV: "preview" }),
    ).rejects.toThrow("Dev login is disabled");
  });
});
