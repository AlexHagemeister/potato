// The Better Auth server instance. Users, sessions, and Google accounts live in
// our own Postgres through the Drizzle adapter (src/db/schema.ts).
//
// Lazy, like the database client: nothing is constructed at import time, so
// `next build` needs neither a database nor the auth secret.
//
// Framework-free on purpose (CLAUDE.md rule 3). The Next.js glue (the route
// handler, reading request headers) lives in src/app and src/lib.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb } from "@/db/client";
import { accounts, sessions, users, verifications } from "@/db/schema";
import { ensureUserSettings } from "@/core/settings/user-settings";

const DAY = 60 * 60 * 24;
/** A session ends after 60 days without use. */
export const SESSION_EXPIRES_IN = 60 * DAY;
/** Use renews the session at most once a day. */
export const SESSION_UPDATE_AGE = DAY;

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!googleClientId || !googleClientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }

  return betterAuth({
    secret,
    // The app origin. Google's console registers
    // <BETTER_AUTH_URL>/api/auth/callback/google for localhost:3000 and production.
    baseURL: process.env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    // In development, accept requests from any localhost port, so agents can
    // run dev servers on ports other than 3000 and still sign out.
    trustedOrigins:
      process.env.NODE_ENV === "development" ? ["http://localhost:*"] : [],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        prompt: "select_account",
      },
    },
    // Sliding sessions: a session lasts SESSION_EXPIRES_IN past its last
    // refresh, and any use more than SESSION_UPDATE_AGE after the last
    // refresh renews it. Server components can't set cookies, so the renewed
    // cookie reaches the browser through SessionRefresher (src/app), which
    // calls /api/auth/get-session from the client on every app open.
    session: {
      expiresIn: SESSION_EXPIRES_IN,
      updateAge: SESSION_UPDATE_AGE,
    },
    databaseHooks: {
      user: {
        create: {
          // Every new user starts with a settings row (country 'US').
          after: async (user) => {
            await ensureUserSettings(user.id);
          },
        },
      },
      session: {
        create: {
          // Again on every sign-in, so a user whose first insert failed gets
          // the row the next time. Reads also get-or-create (getUserSettings).
          after: async (session) => {
            await ensureUserSettings(session.userId);
          },
        },
      },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let auth: Auth | undefined;

export function getAuth(): Auth {
  auth ??= createAuth();
  return auth;
}
