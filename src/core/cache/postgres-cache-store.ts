// The CacheStore backed by the tmdb_cache table. This is the cache store the
// app uses. Reads and writes are single statements over the HTTP driver.

import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { tmdbCache } from "@/db/schema";
import type { CacheEntry, CacheStore } from "./cache-store";

export class PostgresCacheStore implements CacheStore {
  /** `db` defaults to the shared lazy client, so constructing the store opens no connection. */
  constructor(private readonly db: () => Db = getDb) {}

  async get(key: string): Promise<CacheEntry | null> {
    const rows = await this.db()
      .select({ data: tmdbCache.data, expiresAt: tmdbCache.expiresAt })
      .from(tmdbCache)
      .where(eq(tmdbCache.key, key))
      .limit(1);
    return rows[0] ?? null;
  }

  async set(key: string, data: unknown, expiresAt: Date): Promise<void> {
    const fetchedAt = new Date();
    await this.db()
      .insert(tmdbCache)
      .values({ key, data, fetchedAt, expiresAt })
      .onConflictDoUpdate({ target: tmdbCache.key, set: { data, fetchedAt, expiresAt } });
  }
}
