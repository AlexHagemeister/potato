import { describe, expect, test } from "bun:test";
import {
  DEV_TEST_USER,
  devDatabaseRefusal,
  devTestUser,
  parseDevUserSlug,
  validateDevUserSlug,
} from "./dev-user";

describe("validateDevUserSlug", () => {
  test("accepts short lowercase slugs with digits and inner dashes", () => {
    for (const slug of ["a", "7", "pr90", "review-86", "i76-r2", "a".repeat(24)]) {
      expect(validateDevUserSlug(slug)).toEqual({ ok: true, slug });
    }
  });

  test("refuses anything else", () => {
    for (const slug of [
      "",
      "PR90",
      "pr_90",
      "pr.90",
      "pr 90",
      "-pr90",
      "pr90-",
      "pr90@x",
      "pr90/../x",
      "é",
      "a".repeat(25),
    ]) {
      expect(validateDevUserSlug(slug).ok).toBe(false);
    }
  });

  test('refuses "user", which would name the shared test user', () => {
    expect(devTestUser("user").email).toBe(DEV_TEST_USER.email);
    expect(validateDevUserSlug("user").ok).toBe(false);
  });
});

describe("parseDevUserSlug", () => {
  test("no ?as= means the shared user", () => {
    expect(parseDevUserSlug([])).toEqual({ ok: true, slug: null });
  });

  test("one valid value names that user", () => {
    expect(parseDevUserSlug(["pr90"])).toEqual({ ok: true, slug: "pr90" });
  });

  test("an empty, repeated, or invalid value is refused", () => {
    expect(parseDevUserSlug([""]).ok).toBe(false);
    expect(parseDevUserSlug(["pr90", "pr91"]).ok).toBe(false);
    expect(parseDevUserSlug(["pr90", "pr90"]).ok).toBe(false);
    expect(parseDevUserSlug(["Bad!"]).ok).toBe(false);
    expect(parseDevUserSlug(["user"]).ok).toBe(false);
  });
});

describe("devTestUser", () => {
  test("a slug names its own example.com user", () => {
    expect(devTestUser("pr90")).toEqual({ email: "dev-test-pr90@example.com", name: "Dev Test pr90" });
  });

  test("null is the shared user", () => {
    expect(devTestUser(null)).toEqual({ ...DEV_TEST_USER });
  });
});

describe("devDatabaseRefusal", () => {
  test("allows only potato_dev", () => {
    expect(devDatabaseRefusal("potato_dev", "x")).toBeNull();
  });

  test("refuses production, near misses, and a missing name", () => {
    for (const name of ["neondb", "potato_dev_old", "Potato_dev", "", null, undefined]) {
      expect(devDatabaseRefusal(name, "The connected database")).toContain("The connected database");
    }
  });
});
