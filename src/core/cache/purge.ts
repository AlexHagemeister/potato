// The nightly purge of expired tmdb_cache rows (issue 14). The TMDB client
// overwrites an expired entry when its key is asked for again, but keys that
// are never asked for again (most search keys: one per query and page) would
// stay forever. The daily cron (src/core/imdb/daily-job.ts) calls this.
//
// Some expired rows are still useful. For three kinds of row (title details,
// a title's watch providers, and the watch-regions list) the TMDB client
// serves the expired copy when a TMDB call fails (src/core/tmdb/client.ts,
// "serving stale"). The grace period keeps that outage cover for a month
// after expiry. The other kinds (search, discover, recommendations, genres,
// the provider list) are read fresh-only, so for them the grace period buys
// nothing: they simply wait the same 30 days before they go. One grace period
// for all kinds keeps the purge free of any knowledge of TMDB's key format.

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
 * finite number, or the clock or the cutoff is not a valid date, since a bad
 * cutoff could delete rows that are still fresh.
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
  // A huge but finite grace period still makes an invalid date.
  if (!Number.isFinite(cutoff.getTime())) throw new Error("cache purge refused: the cutoff is not a valid date");
  const deleted = await store.deleteExpiredBefore(cutoff, limit);
  return { cutoff: cutoff.toISOString(), deleted, hitLimit: deleted >= limit };
}

/** How long the nightly purge may take before the cron stops waiting for it. */
export const CACHE_PURGE_TIMEOUT_MS = 20_000;

export type NightlyCachePurgeOutcome = ({ ok: true } & CachePurgeResult) | { ok: false; error: string };

/**
 * The cron's entry point. It never throws and never waits longer than
 * `timeoutMs`: a failed or slow purge is logged and reported, and must not
 * change the outcome of the IMDb load it runs beside. On a timeout the
 * statement may still finish in the database; only the wait is cut short.
 */
export async function runNightlyCachePurge(
  store: ExpiredEntryDeleter,
  { timeoutMs = CACHE_PURGE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<NightlyCachePurgeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([purgeExpiredCache({ store }), timeout]);
    console.log("tmdb cache purge", result);
    return { ok: true, ...result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`TMDB CACHE PURGE FAILED: ${error}`, err);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}
