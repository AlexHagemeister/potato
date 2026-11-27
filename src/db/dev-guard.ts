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
//
// A known hole, left open on purpose: a local run with VERCEL_ENV set (for
// example `vercel dev`, or a shell that exports it) is not guarded, and would
// reach whatever database its URL names without a word. Vercel sets
// VERCEL_ENV on every deployment, so honouring it is the second, independent
// lock that keeps the guard from ever firing there. A guard that goes quiet
// locally costs a warning. One that fires on Vercel costs the app.

import { DEV_DATABASE_NAME, databaseNameFromUrl } from "@/core/auth/dev-user";

/** What a database name may look like in the message. */
const PRINTABLE_DATABASE_NAME = /^[A-Za-z0-9_-]{1,63}$/;

/**
 * The database name as the message may show it: the name, or a fixed
 * placeholder. A malformed URL can put its password or host where the name
 * is read from (`postgresql:user:pw@host/db` parses with all of that as the
 * path, and `postgresql:pw` with the password alone). So the name is printed
 * only when it is plainly shaped and the URL around it is well formed: a
 * Postgres scheme, a user, and a host, which puts the password before the
 * host and the name after it.
 */
function printableDatabaseName(url: string | undefined, name: string | null): string {
  if (name === null) return "(none)";
  if (!PRINTABLE_DATABASE_NAME.test(name)) return "(unreadable)";
  try {
    const parsed = new URL(url ?? "");
    const wellFormed =
      (parsed.protocol === "postgresql:" || parsed.protocol === "postgres:") &&
      parsed.username !== "" &&
      parsed.hostname !== "";
    return wellFormed ? name : "(unreadable)";
  } catch {
    return "(unreadable)";
  }
}

export interface DevDatabaseGuardEnv {
  /**
   * The caller must pass the literal `process.env.NODE_ENV`, which Next.js
   * replaces with "production" when it builds, so the guard is dead code in
   * a production build whatever the runtime environment says.
   */
  nodeEnv: string | undefined;
  /**
   * process.env.VERCEL_ENV. Vercel sets it on every deployment, preview
   * included. Any value turns the guard off, a local one too (see the header).
   */
  vercelEnv: string | undefined;
  /** The connection URL about to be used. */
  url: string | undefined;
  /** The name of the variable the URL came from, for the message. */
  variable: string;
}

/**
 * Null when the connection may open, otherwise the reason to refuse it.
 * Refuses only a local development run (NODE_ENV "development", no
 * VERCEL_ENV) whose URL does not name potato_dev. The message never holds
 * the URL or any part of it but a plainly shaped database name, since the
 * URL holds the password.
 */
export function devDatabaseGuardRefusal(env: DevDatabaseGuardEnv): string | null {
  if (env.nodeEnv !== "development") return null;
  if (env.vercelEnv) return null;
  const name = databaseNameFromUrl(env.url);
  if (name === DEV_DATABASE_NAME) return null;
  return (
    `Refusing to open a database connection in development: ${env.variable} names the database ` +
    `"${printableDatabaseName(env.url, name)}", not "${DEV_DATABASE_NAME}". ` +
    "This checkout is probably missing .env.development.local, so the dev server fell back to " +
    ".env.local, which points at production. Copy .env.development.local from the main checkout " +
    `into this one (it sets DATABASE_URL and DATABASE_URL_UNPOOLED to ${DEV_DATABASE_NAME}), ` +
    "then restart the dev server."
  );
}
