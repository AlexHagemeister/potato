// Development test users: the names, slugs, and database guard shared by the
// dev login (dev-login.ts, /api/dev/login) and the walk kit script
// (scripts/dev-user.ts). Pure: no database, auth, or environment access, so
// the script and unit tests can import it without side effects.
//
// Each agent walking the app signs in as its own user, named by a slug
// (/api/dev/login?as=pr90 signs in as dev-test-pr90@example.com), so agents
// running at the same time don't see each other's rows (issue 59). No slug
// keeps the one shared test user.

/** The shared test user, signed in when no slug is given. */
export const DEV_TEST_USER = {
  email: "dev-test-user@example.com",
  name: "Dev Test User",
} as const;

/** The only database the dev login and the walk kit may write to. */
export const DEV_DATABASE_NAME = "potato_dev";

/**
 * A per-agent test user's slug: 1 to 24 lowercase letters, digits, and inner
 * dashes, for example "pr90" or "review-86". It becomes part of an email
 * address, so nothing else is allowed.
 */
export const DEV_USER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

/**
 * Slugs that would name the shared test user (dev-test-user@example.com).
 * The shared user is reached only by giving no slug.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(["user"]);

export type DevUserSlugResult = { ok: true; slug: string | null } | { ok: false; reason: string };

/** Checks one slug. */
export function validateDevUserSlug(slug: string): DevUserSlugResult {
  if (!DEV_USER_SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      reason: "a slug is 1 to 24 lowercase letters, digits, and inner dashes (for example pr90)",
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, reason: `"${slug}" would name the shared test user` };
  }
  return { ok: true, slug };
}

/**
 * Reads the `as` query parameter, given every value it carried. No parameter
 * means the shared test user (slug null). One valid slug names a per-agent
 * user. An empty value, a repeated parameter, a malformed slug, or a slug
 * that would name the shared user is refused.
 */
export function parseDevUserSlug(values: readonly string[]): DevUserSlugResult {
  if (values.length === 0) return { ok: true, slug: null };
  if (values.length > 1) return { ok: false, reason: "give at most one ?as= slug" };
  return validateDevUserSlug(values[0]);
}

/** The email and display name of the test user for a slug, or of the shared user for null. */
export function devTestUser(slug: string | null): { email: string; name: string } {
  if (slug === null) return { ...DEV_TEST_USER };
  return { email: `dev-test-${slug}@example.com`, name: `Dev Test ${slug}` };
}

/** The database name in a Postgres connection URL, or null if it can't be read. */
export function databaseNameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Null when `name` is potato_dev, otherwise the reason to refuse. Used twice:
 * on the database name in the URL before connecting, and on the live
 * connection's current_database() before writing.
 */
export function devDatabaseRefusal(name: string | null | undefined, source: string): string | null {
  if (name === DEV_DATABASE_NAME) return null;
  return `${source} is "${name ?? "(none)"}", not "${DEV_DATABASE_NAME}"`;
}
