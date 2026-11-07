// The database client. It is lazy: importing this module opens no connection
// and reads no environment variable, so `next build` works without a database.
//
// The driver is Neon's HTTP driver: one HTTPS request per query, no socket to
// hold open, which suits short-lived Vercel functions. It does not support
// interactive transactions. Code that needs one should add a WebSocket Pool
// client here (drizzle-orm/neon-serverless) rather than work around it.

import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    db = drizzle({ client: neon(url), schema });
  }
  return db;
}
