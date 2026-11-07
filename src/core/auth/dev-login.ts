// Development-only test session (CLAUDE.md: "Behind sign-in, use a
// development-only test session"). Agents can't sign in to Google, so this
// signs a fixed test user in with a real Better Auth session in potato_dev.
//
// It must never work on Vercel or in a production build. The route that uses
// it checks isDevLoginEnabled() on every request and answers 404 otherwise.

import { makeSignature } from "better-auth/crypto";
import { getAuth } from "./auth";

export const DEV_TEST_USER = {
  email: "dev-test-user@example.com",
  name: "Dev Test User",
} as const;

type Env = Record<string, string | undefined>;

/**
 * True only in a local `next dev` run: NODE_ENV is 'development' and
 * VERCEL_ENV is unset (Vercel sets it on every deployment, preview included).
 */
export function isDevLoginEnabled(env: Env): boolean {
  return env.NODE_ENV === "development" && !env.VERCEL_ENV;
}

/**
 * Finds or creates the test user, opens a session for it, and returns the
 * Set-Cookie header value that carries the session. Creating the user goes
 * through Better Auth's adapter, so the same hooks run as on a real sign-up
 * (the user_settings row included).
 */
export async function createDevSession(env: Env): Promise<{ setCookie: string }> {
  if (!isDevLoginEnabled(env)) throw new Error("Dev login is disabled outside local development");

  const ctx = await getAuth().$context;
  const existing = await ctx.internalAdapter.findUserByEmail(DEV_TEST_USER.email);
  const user =
    existing?.user ??
    (await ctx.internalAdapter.createUser(
      { email: DEV_TEST_USER.email, name: DEV_TEST_USER.name, emailVerified: true },
      { method: "dev-login" },
    ));

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
