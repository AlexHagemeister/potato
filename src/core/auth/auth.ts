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
    databaseHooks: {
      user: {
        create: {
          // Every new user starts with a settings row (country 'US').
          after: async (user) => {
            await ensureUserSettings(user.id);
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
