// The CacheStore backed by the tmdb_cache table. This is the cache store the
// app uses. Reads and writes are single statements over the HTTP driver.

import { eq, inArray, sql } from "drizzle-orm";
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

  /** One statement for the whole batch, so a list of titles costs one round trip, not one per title. */
  async getMany(keys: readonly string[]): Promise<Map<string, CacheEntry>> {
    const out = new Map<string, CacheEntry>();
    if (keys.length === 0) return out;
    const rows = await this.db()
      .select({ key: tmdbCache.key, data: tmdbCache.data, expiresAt: tmdbCache.expiresAt })
      .from(tmdbCache)
      .where(inArray(tmdbCache.key, [...new Set(keys)]));
    for (const { key, data, expiresAt } of rows) out.set(key, { data, expiresAt });
    return out;
  }

  async set(key: string, data: unknown, expiresAt: Date): Promise<void> {
    const fetchedAt = new Date();
    await this.db()
      .insert(tmdbCache)
      .values({ key, data, fetchedAt, expiresAt })
      .onConflictDoUpdate({ target: tmdbCache.key, set: { data, fetchedAt, expiresAt } });
  }

  /**
   * Deletes up to `limit` rows whose expires_at is strictly before `cutoff`,
   * and returns how many went. The nightly purge (purge.ts) is the only
   * caller. Every row in tmdb_cache is a copy of a TMDB response, so a
   * deleted row is refetched the next time it is needed. One statement, using
   * tmdb_cache_expires_at_idx.
   */
  async deleteExpiredBefore(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db().execute(sql`
      delete from tmdb_cache
      where key in (
        select key from tmdb_cache
        where expires_at < ${cutoff.toISOString()}::timestamptz
        order by expires_at
        limit ${limit}
      )`);
    return result.rowCount ?? 0;
  }
}
