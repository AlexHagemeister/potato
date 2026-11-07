// A key-value cache with expiry, used by the external-data modules
// (CLAUDE.md architecture rule 4). The Postgres implementation backs it with
// the tmdb_cache table. Tests use the in-memory one.

export interface CacheEntry {
  data: unknown;
  expiresAt: Date;
}

export interface CacheStore {
  /** The stored entry, expired or not. The caller decides what expired means, so it can use its own clock. */
  get(key: string): Promise<CacheEntry | null>;
  /**
   * Many entries in one read, keyed by cache key. Missing keys are absent.
   * Optional: callers fall back to one get per key without it.
   */
  getMany?(keys: readonly string[]): Promise<Map<string, CacheEntry>>;
  /** Insert or replace. */
  set(key: string, data: unknown, expiresAt: Date): Promise<void>;
}

/** A process-local cache. For tests and scripts. Values are deep-copied in and out, like a database round trip. */
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { json: string; expiresAt: Date }>();

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return { data: JSON.parse(entry.json), expiresAt: entry.expiresAt };
  }

  async getMany(keys: readonly string[]): Promise<Map<string, CacheEntry>> {
    const out = new Map<string, CacheEntry>();
    for (const key of keys) {
      const entry = await this.get(key);
      if (entry) out.set(key, entry);
    }
    return out;
  }

  async set(key: string, data: unknown, expiresAt: Date): Promise<void> {
    this.entries.set(key, { json: JSON.stringify(data), expiresAt });
  }

  /** Number of stored entries, for tests. */
  get size(): number {
    return this.entries.size;
  }
}
