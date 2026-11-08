import { describe, expect, test } from "bun:test";
import { isValidRating } from "../src/core/library/validate";
import { SEED_ROWS, parseDevUserArgs } from "./dev-user-kit";

describe("parseDevUserArgs", () => {
  test("a command and a slug target that slug's user", () => {
    for (const command of ["show", "reset", "seed", "delete"]) {
      const r = parseDevUserArgs([command, "pr90"]);
      if (!r.ok) throw new Error(r.error);
      expect(r.target).toEqual({
        command: command as typeof r.target.command,
        slug: "pr90",
        email: "dev-test-pr90@example.com",
        name: "Dev Test pr90",
      });
    }
  });

  test("the shared user needs --shared, in either position", () => {
    for (const args of [["reset", "--shared"], ["--shared", "reset"]]) {
      const r = parseDevUserArgs(args);
      expect(r.ok && r.target.email).toBe("dev-test-user@example.com");
      expect(r.ok && r.target.slug).toBeNull();
    }
  });

  test("no slug and no flag is refused, never read as the shared user", () => {
    const r = parseDevUserArgs(["reset"]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("--shared");
  });

  test('the slug "user" cannot reach the shared user without the flag', () => {
    const r = parseDevUserArgs(["reset", "user"]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("--shared");
  });

  test("refuses a slug together with --shared", () => {
    expect(parseDevUserArgs(["reset", "pr90", "--shared"]).ok).toBe(false);
  });

  test("refuses bad slugs, unknown commands and options, and extra arguments", () => {
    expect(parseDevUserArgs(["reset", "PR90"]).ok).toBe(false);
    expect(parseDevUserArgs(["reset", "pr_90"]).ok).toBe(false);
    expect(parseDevUserArgs(["wipe", "pr90"]).ok).toBe(false);
    expect(parseDevUserArgs(["reset", "pr90", "--force"]).ok).toBe(false);
    expect(parseDevUserArgs(["reset", "pr90", "pr91"]).ok).toBe(false);
    expect(parseDevUserArgs([]).ok).toBe(false);
  });
});

describe("SEED_ROWS", () => {
  test("two titles in each list, no title twice", () => {
    for (const status of ["watchlist", "passed", "seen", "skipped"]) {
      expect(SEED_ROWS.filter((r) => r.status === status)).toHaveLength(2);
    }
    const keys = new Set(SEED_ROWS.map((r) => `${r.mediaType}:${r.tmdbId}`));
    expect(keys.size).toBe(SEED_ROWS.length);
  });

  test("rows satisfy title_status's checks: half-step rating iff seen, review only on seen", () => {
    for (const r of SEED_ROWS) {
      expect(r.tmdbId).toBeGreaterThan(0);
      expect(r.rating !== null).toBe(r.status === "seen");
      if (r.rating !== null) expect(isValidRating(r.rating)).toBe(true);
      if (r.review !== null) expect(r.status).toBe("seen");
    }
    expect(SEED_ROWS.some((r) => r.review !== null)).toBe(true);
  });
});
