// The nightly cron job behind /api/cron/imdb: the IMDb ratings load, then the
// tmdb_cache purge (issue 14). The route checks the cron secret and calls this
// with the real load and store; tests call it with fakes.
//
// The status code says only whether the ratings load worked. The purge runs
// after the load, whatever its outcome, so the load gets the time budget first,
// and it is bounded by the time left in the function's budget, so a slow purge
// cannot keep a good load's response from being sent.

import { runNightlyCachePurge, CACHE_PURGE_TIMEOUT_MS, type ExpiredEntryDeleter, type NightlyCachePurgeOutcome } from "../cache";
import { ImdbLoadGuardError, type LoadImdbRatingsResult } from "./loader";

/** Time kept back at the end of the budget for sending the response. */
export const DAILY_JOB_RESPONSE_MARGIN_MS = 10_000;
/** Below this much time left, the purge is skipped rather than started. */
export const DAILY_JOB_MIN_PURGE_MS = 1_000;

export interface DailyJobDeps {
  loadRatings: () => Promise<LoadImdbRatingsResult>;
  cacheStore: ExpiredEntryDeleter;
  /** The function's whole time budget (the route's maxDuration), in ms. */
  budgetMs: number;
  now?: () => number;
}

export interface DailyJobResponse {
  status: 200 | 500;
  body: Record<string, unknown> & { tmdbCachePurge: NightlyCachePurgeOutcome };
}

export async function runDailyJob({ loadRatings, cacheStore, budgetMs, now = Date.now }: DailyJobDeps): Promise<DailyJobResponse> {
  const started = now();
  let status: 200 | 500;
  let body: Record<string, unknown>;
  try {
    const result = await loadRatings();
    console.log("imdb ratings load", result);
    status = 200;
    body = { ...result };
  } catch (err) {
    // A failed run keeps yesterday's ratings (the load rolls back). The 500
    // marks the run as failed in Vercel's cron log, and the message says why.
    const guard = err instanceof ImdbLoadGuardError;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`IMDB RATINGS LOAD FAILED${guard ? " (guard stopped the swap)" : ""}: ${message}`, err);
    status = 500;
    body = { ok: false, guard, error: message };
  }

  const left = budgetMs - (now() - started) - DAILY_JOB_RESPONSE_MARGIN_MS;
  let tmdbCachePurge: NightlyCachePurgeOutcome;
  if (left < DAILY_JOB_MIN_PURGE_MS) {
    tmdbCachePurge = { ok: false, error: `skipped: only ${Math.max(0, left)} ms left in the budget` };
    console.error(`TMDB CACHE PURGE FAILED: ${tmdbCachePurge.error}`);
  } else {
    tmdbCachePurge = await runNightlyCachePurge(cacheStore, { timeoutMs: Math.min(CACHE_PURGE_TIMEOUT_MS, left) });
  }
  return { status, body: { ...body, tmdbCachePurge } };
}
