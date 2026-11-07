// The Postgres-backed CacheStore, over the tmdb_cache table. Vercel function
// instances come and go, so an in-memory cache would be lost on every cold
// start. Postgres survives cold starts and is shared between instances.

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { tmdbCache } from "@/db/schema";
import type { CacheEntry, CacheStore } from "./cache-store";

export class PgCacheStore implements CacheStore {
  async get(key: string): Promise<CacheEntry | null> {
    const rows = await getDb()
      .select({ data: tmdbCache.data, expiresAt: tmdbCache.expiresAt })
      .from(tmdbCache)
      .where(eq(tmdbCache.key, key))
      .limit(1);
    const row = rows[0];
    return row ? { data: row.data, expiresAt: row.expiresAt } : null;
  }

  async set(key: string, data: unknown, expiresAt: Date): Promise<void> {
    const fetchedAt = new Date();
    await getDb()
      .insert(tmdbCache)
      .values({ key, data, fetchedAt, expiresAt })
      .onConflictDoUpdate({ target: tmdbCache.key, set: { data, fetchedAt, expiresAt } });
  }
}
