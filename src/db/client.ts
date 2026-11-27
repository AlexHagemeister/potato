// The database client. It is lazy: importing this module opens no connection
// and reads no environment variable, so `next build` works without a database.
//
// getDb() uses Neon's HTTP driver: one HTTPS request per query, no socket to
// hold open, which suits short-lived Vercel functions. It does not support
// interactive transactions. Code that needs one uses withTransaction() below,
// which opens a WebSocket Pool connection for that one transaction.
//
// In local development both refuse any database but potato_dev (dev-guard.ts).

import { neon, Pool, type PoolClient } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { devDatabaseGuardRefusal } from "./dev-guard";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;
export type { PoolClient };

let db: Db | undefined;

/**
 * Throws in local development when `url` names any database but potato_dev,
 * before a client exists. `process.env.NODE_ENV` is a literal member access on
 * purpose: Next.js replaces it with "production" in `next build` output, so
 * this can't fire in a production build.
 */
function refuseNonDevDatabaseInDevelopment(url: string, variable: string): void {
  const refusal = devDatabaseGuardRefusal({
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    url,
    variable,
  });
  if (refusal) throw new Error(refusal);
}

export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    refuseNonDevDatabaseInDevelopment(url, "DATABASE_URL");
    db = drizzle({ client: neon(url), schema });
  }
  return db;
}

/**
 * Runs `fn` inside one interactive transaction on a WebSocket connection
 * (Neon's Pool driver). Commits when `fn` resolves, rolls back when it throws.
 * Use it only where a transaction must span several round trips with work in
 * between (the daily IMDb ratings swap). Everything else uses getDb().
 *
 * Neon's guidance for serverless functions is to open and close a Pool within
 * one invocation, so each call gets its own Pool and ends it. It uses the
 * direct (unpooled) connection when one is set, since the transaction can run
 * for tens of seconds.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const unpooled = process.env.DATABASE_URL_UNPOOLED;
  const url = unpooled || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  refuseNonDevDatabaseInDevelopment(url, unpooled ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL");
  const pool = new Pool({ connectionString: url, max: 1 });
  // A connection that drops outside a query is reported here. Without a
  // listener it would be an uncaught exception. The in-flight query still
  // fails and the transaction rolls back.
  pool.on("error", (err: Error) => console.error("postgres pool error:", err));
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
