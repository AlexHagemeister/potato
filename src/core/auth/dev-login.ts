// Development-only test session (CLAUDE.md: "Behind sign-in, use a
// development-only test session"). Agents can't sign in to Google, so this
// signs a test user in with a real Better Auth session in potato_dev: the
// shared test user, or a per-agent user named by a slug (dev-user.ts).
//
// It must never work in a production build, on Vercel, or against any
// database but potato_dev. The gate fails closed on three independent checks,
// and createDevSession repeats them against the live connection before it
// writes anything.

import { sql } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { getDb } from "@/db/client";
import { getAuth } from "./auth";
import {
  DEV_DATABASE_NAME,
  databaseNameFromUrl,
  devDatabaseRefusal,
  devTestUser,
  parseDevUserSlug,
} from "./dev-user";

export { DEV_DATABASE_NAME, DEV_TEST_USER, databaseNameFromUrl, parseDevUserSlug } from "./dev-user";

export interface DevLoginEnv {
  /**
   * The caller must pass the literal `process.env.NODE_ENV`, which Next.js
   * replaces with "production" when it builds, so a production build can't
   * be opened by setting NODE_ENV at runtime.
   */
  nodeEnv: string | undefined;
  /** process.env.VERCEL_ENV. Vercel sets it on every deployment, preview included. */
  vercelEnv: string | undefined;
  /** process.env.DATABASE_URL. */
  databaseUrl: string | undefined;
}

/**
 * True only in a local `next dev` run against potato_dev: NODE_ENV is
 * 'development' (inlined at build time), VERCEL_ENV is unset, and
 * DATABASE_URL names potato_dev. Any missing or unexpected value closes it.
 */
export function isDevLoginEnabled(env: DevLoginEnv): boolean {
  return (
    env.nodeEnv === "development" &&
    !env.vercelEnv &&
    databaseNameFromUrl(env.databaseUrl) === DEV_DATABASE_NAME
  );
}

/**
 * Accepts only requests a person or a test made directly: a typed URL or
 * Playwright's page.goto (Sec-Fetch-Site "none"), or the app itself
 * ("same-origin"). A link or form on another site can't sign the developer's
 * browser in as the test user.
 */
export function isDirectRequest(secFetchSite: string | null): boolean {
  return secFetchSite === "none" || secFetchSite === "same-origin";
}

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * Finds or creates the test user for `slug` (the shared user when null),
 * opens a session for it, and returns the Set-Cookie header value that
 * carries the session. Safe to call concurrently: a second request racing
 * the first one's insert re-reads the user instead of failing.
 */
export async function createDevSession(
  env: DevLoginEnv,
  slug: string | null = null,
): Promise<{ setCookie: string }> {
  if (!isDevLoginEnabled(env)) throw new Error("Dev login is disabled outside local development");
  // The route validates the slug first. Checked again here so no caller can
  // build an email from an unchecked slug.
  const parsed = parseDevUserSlug(slug === null ? [] : [slug]);
  if (!parsed.ok) throw new Error(`Dev login refused: ${parsed.reason}`);
  const testUser = devTestUser(parsed.slug);

  // Check the live connection too, not just the URL string.
  const result = await getDb().execute<{ name: string }>(sql`select current_database() as name`);
  const refusal = devDatabaseRefusal(result.rows[0]?.name, "the connected database");
  if (refusal) throw new Error(`Dev login refused: ${refusal}`);

  const ctx = await getAuth().$context;
  const findUser = async () =>
    (await ctx.internalAdapter.findUserByEmail(testUser.email))?.user ?? null;

  let user = await findUser();
  if (!user) {
    try {
      user = await ctx.internalAdapter.createUser(
        { email: testUser.email, name: testUser.name, emailVerified: true },
        { method: "dev-login" },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      user = await findUser();
      if (!user) throw error;
    }
  }

  const session = await ctx.internalAdapter.createSession(user.id);

  // Same cookie Better Auth sets on a real sign-in: the token, a dot, and its
  // HMAC signature, URI-encoded (as better-call's signed cookies are).
  const { name, attributes } = ctx.authCookies.sessionToken;
  const signed = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  const parts = [
    `${name}=${encodeURIComponent(signed)}`,
    `Path=${attributes.path ?? "/"}`,
    `Max-Age=${ctx.sessionConfig.expiresIn}`,
    "HttpOnly",
    `SameSite=${attributes.sameSite ?? "Lax"}`,
  ];
  if (attributes.secure) parts.push("Secure");
  return { setCookie: parts.join("; ") };
}
