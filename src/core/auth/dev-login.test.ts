import { describe, expect, test } from "bun:test";
import {
  createDevSession,
  databaseNameFromUrl,
  isDevLoginEnabled,
  isDirectRequest,
  type DevLoginEnv,
} from "./dev-login";

const DEV_URL = "postgresql://u:p@host.example/potato_dev?sslmode=require";
const PROD_URL = "postgresql://u:p@host.example/neondb?sslmode=require";
const open: DevLoginEnv = { nodeEnv: "development", vercelEnv: undefined, databaseUrl: DEV_URL };

describe("isDevLoginEnabled", () => {
  test("enabled only in local development against potato_dev", () => {
    expect(isDevLoginEnabled(open)).toBe(true);
  });

  test("disabled in production and test builds", () => {
    expect(isDevLoginEnabled({ ...open, nodeEnv: "production" })).toBe(false);
    expect(isDevLoginEnabled({ ...open, nodeEnv: "test" })).toBe(false);
    expect(isDevLoginEnabled({ ...open, nodeEnv: undefined })).toBe(false);
  });

  test("disabled on every Vercel environment, even with NODE_ENV=development", () => {
    for (const vercelEnv of ["production", "preview", "development"]) {
      expect(isDevLoginEnabled({ ...open, vercelEnv })).toBe(false);
    }
  });

  test("an empty VERCEL_ENV counts as unset", () => {
    expect(isDevLoginEnabled({ ...open, vercelEnv: "" })).toBe(true);
  });

  test("disabled against any database but potato_dev", () => {
    expect(isDevLoginEnabled({ ...open, databaseUrl: PROD_URL })).toBe(false);
    expect(isDevLoginEnabled({ ...open, databaseUrl: undefined })).toBe(false);
    expect(isDevLoginEnabled({ ...open, databaseUrl: "" })).toBe(false);
    expect(isDevLoginEnabled({ ...open, databaseUrl: "not a url" })).toBe(false);
    expect(isDevLoginEnabled({ ...open, databaseUrl: "postgresql://h/potato_dev_old" })).toBe(false);
  });

  test("NODE_ENV must match exactly", () => {
    expect(isDevLoginEnabled({ ...open, nodeEnv: "Development" })).toBe(false);
    expect(isDevLoginEnabled({ ...open, nodeEnv: "development " })).toBe(false);
  });
});

describe("databaseNameFromUrl", () => {
  test("reads the path segment, ignoring the query", () => {
    expect(databaseNameFromUrl(DEV_URL)).toBe("potato_dev");
    expect(databaseNameFromUrl(PROD_URL)).toBe("neondb");
  });

  test("null when there is no database name", () => {
    expect(databaseNameFromUrl("postgresql://u:p@host/")).toBeNull();
    expect(databaseNameFromUrl(undefined)).toBeNull();
  });
});

describe("isDirectRequest", () => {
  test("allows typed URLs, page.goto, and same-origin requests", () => {
    expect(isDirectRequest("none")).toBe(true);
    expect(isDirectRequest("same-origin")).toBe(true);
  });

  test("refuses cross-site, same-site, and requests without the header", () => {
    expect(isDirectRequest("cross-site")).toBe(false);
    expect(isDirectRequest("same-site")).toBe(false);
    expect(isDirectRequest(null)).toBe(false);
  });
});

describe("createDevSession", () => {
  test("refuses to run when the gate is closed, before touching auth or the database", async () => {
    await expect(createDevSession({ ...open, nodeEnv: "production" })).rejects.toThrow(
      "Dev login is disabled",
    );
    await expect(createDevSession({ ...open, vercelEnv: "preview" })).rejects.toThrow(
      "Dev login is disabled",
    );
    await expect(createDevSession({ ...open, databaseUrl: PROD_URL })).rejects.toThrow(
      "Dev login is disabled",
    );
  });

  test("refuses a slug the route would reject, before touching auth or the database", async () => {
    for (const slug of ["", "Bad!", "user", "a".repeat(25)]) {
      await expect(createDevSession(open, slug)).rejects.toThrow("Dev login refused");
    }
  });
});
