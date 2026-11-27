// The development database guard (issue 18, item 1). `.env.local` points at
// the production database, and `.env.development.local` overrides the
// database variables with potato_dev. A checkout missing the second file
// would run `next dev` against real users' rows. So in development the
// database client refuses any database but potato_dev.
//
// The dangerous half is the other direction: a guard that fires in production
// takes the app down. It can only fire when NODE_ENV is exactly "development"
// and VERCEL_ENV is unset. Every other value, a missing one included, lets
// the connection through untouched. Pure: no database or environment access.

import { DEV_DATABASE_NAME, databaseNameFromUrl } from "@/core/auth/dev-user";

export interface DevDatabaseGuardEnv {
  /**
   * The caller must pass the literal `process.env.NODE_ENV`, which Next.js
   * replaces with "production" when it builds, so the guard is dead code in
   * a production build whatever the runtime environment says.
   */
  nodeEnv: string | undefined;
  /** process.env.VERCEL_ENV. Vercel sets it on every deployment, preview included. */
  vercelEnv: string | undefined;
  /** The connection URL about to be used. */
  url: string | undefined;
  /** The name of the variable the URL came from, for the message. */
  variable: string;
}

/**
 * Null when the connection may open, otherwise the reason to refuse it.
 * Refuses only a local development run (NODE_ENV "development", no
 * VERCEL_ENV) whose URL does not name potato_dev. The message names the
 * database but never the URL, which holds the password.
 */
export function devDatabaseGuardRefusal(env: DevDatabaseGuardEnv): string | null {
  if (env.nodeEnv !== "development") return null;
  if (env.vercelEnv) return null;
  const name = databaseNameFromUrl(env.url);
  if (name === DEV_DATABASE_NAME) return null;
  return (
    `Refusing to open a database connection in development: ${env.variable} names the database ` +
    `"${name ?? "(none)"}", not "${DEV_DATABASE_NAME}". ` +
    "This checkout is probably missing .env.development.local, so the dev server fell back to " +
    ".env.local, which points at production. Copy .env.development.local from the main checkout " +
    `into this one (it sets DATABASE_URL and DATABASE_URL_UNPOOLED to ${DEV_DATABASE_NAME}), ` +
    "then restart the dev server."
  );
}
