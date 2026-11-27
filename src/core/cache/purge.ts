// The nightly purge of expired tmdb_cache rows (issue 14). The TMDB client
// overwrites an expired entry when its key is asked for again, but keys that
// are never asked for again (most search keys: one per query and page) would
// stay forever. The daily cron (src/app/api/cron/imdb/route.ts) calls this.
//
// Expired rows are not useless: when a TMDB call fails, the client serves the
// expired copy instead (src/core/tmdb/client.ts, "serving stale"). So a row is
// deleted only once it has been expired for the whole grace period, and the
// grace period is the outage cover kept for titles nobody has opened lately.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a row stays after it expires. The longest TMDB TTL is 7 days (details, genres). */
export const CACHE_PURGE_GRACE_MS = 30 * DAY_MS;

/** Rows deleted per run at most, so one night's statement stays small. A larger backlog drains over several nights. */
export const CACHE_PURGE_BATCH_LIMIT = 10_000;

/** The one store method the purge needs. PostgresCacheStore and MemoryCacheStore both have it. */
export interface ExpiredEntryDeleter {
  /** Deletes up to `limit` entries whose expiry is strictly before `cutoff`, and returns how many went. */
  deleteExpiredBefore(cutoff: Date, limit: number): Promise<number>;
}

export interface CachePurgeResult {
  /** Rows with an expiry strictly before this were eligible. */
  cutoff: string;
  deleted: number;
  /** True when the run hit the batch limit, so more eligible rows may remain for the next run. */
  hitLimit: boolean;
}

export interface PurgeExpiredCacheOptions {
  store: ExpiredEntryDeleter;
  now?: () => Date;
  graceMs?: number;
  limit?: number;
}

/**
 * Deletes cache rows that expired more than `graceMs` ago. Throws before
 * touching the store when the grace period or limit is not a positive
 * finite number, or the clock is not a valid date, since a bad cutoff could
 * delete rows that are still fresh.
 */
export async function purgeExpiredCache({
  store,
  now = () => new Date(),
  graceMs = CACHE_PURGE_GRACE_MS,
  limit = CACHE_PURGE_BATCH_LIMIT,
}: PurgeExpiredCacheOptions): Promise<CachePurgeResult> {
  if (!Number.isFinite(graceMs) || graceMs <= 0) {
    throw new Error(`cache purge refused: grace period must be a positive number of ms, got ${graceMs}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`cache purge refused: limit must be a positive integer, got ${limit}`);
  }
  const nowMs = now().getTime();
  if (!Number.isFinite(nowMs)) throw new Error("cache purge refused: the clock returned an invalid date");
  const cutoff = new Date(nowMs - graceMs);
  const deleted = await store.deleteExpiredBefore(cutoff, limit);
  return { cutoff: cutoff.toISOString(), deleted, hitLimit: deleted >= limit };
}

export type NightlyCachePurgeOutcome = ({ ok: true } & CachePurgeResult) | { ok: false; error: string };

/**
 * The cron's entry point. It never throws: a failed purge is logged and
 * reported, and must not change the outcome of the IMDb load it runs beside.
 */
export async function runNightlyCachePurge(store: ExpiredEntryDeleter): Promise<NightlyCachePurgeOutcome> {
  try {
    const result = await purgeExpiredCache({ store });
    console.log("tmdb cache purge", result);
    return { ok: true, ...result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`TMDB CACHE PURGE FAILED: ${error}`, err);
    return { ok: false, error };
  }
}
