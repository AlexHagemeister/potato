// The database client. It is lazy: importing this module opens no connection
// and reads no environment variable, so `next build` works without a database.
//
// The driver is Neon's HTTP driver: one HTTPS request per query, no socket to
// hold open, which suits short-lived Vercel functions. It does not support
// interactive transactions. Code that needs one should add a WebSocket Pool
// client here (drizzle-orm/neon-serverless) rather than work around it.

import { neon, Pool, type PoolClient } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;
export type { PoolClient };

let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
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
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url, max: 1 });
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
