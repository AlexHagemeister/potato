// Daily IMDb ratings load, invoked by Vercel Cron (vercel.json). It also
// purges long-expired tmdb_cache rows (issue 14), since Hobby allows few cron
// jobs and this one already runs nightly. Thin: the auth check, the load and
// the purge all live in src/core.

import { PostgresCacheStore, runNightlyCachePurge } from "@/core/cache";
import { isAuthorizedCronRequest } from "@/core/cron-auth";
import { createPostgresRatingsLoadTarget, ImdbLoadGuardError, loadImdbRatings } from "@/core/imdb";

export const runtime = "nodejs";
// Run on every invocation; never serve a cached response to the cron.
export const dynamic = "force-dynamic";
// Seconds. The Vercel Hobby maximum (with fluid compute). The database work
// of a full load measured about 14 s at worst on potato_dev. The end-to-end
// time on Vercel is not measured yet: the first production run's durationMs
// is the check (PR 19, judgment call 9).
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  let loadResponse: { body: Record<string, unknown>; status: number };
  try {
    const result = await loadImdbRatings({ target: createPostgresRatingsLoadTarget() });
    console.log("imdb ratings load", result);
    loadResponse = { body: { ...result }, status: 200 };
  } catch (err) {
    // A failed run keeps yesterday's ratings (the load rolls back). The 500
    // marks the run as failed in Vercel's cron log, and the message says why.
    const guard = err instanceof ImdbLoadGuardError;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`IMDB RATINGS LOAD FAILED${guard ? " (guard stopped the swap)" : ""}: ${message}`, err);
    loadResponse = { body: { ok: false, guard, error: message }, status: 500 };
  }
  // After the load, whatever its outcome, so the load gets the time budget
  // first. It never throws, and its result never changes the status code:
  // the status still says only whether the ratings load worked.
  const tmdbCachePurge = await runNightlyCachePurge(new PostgresCacheStore());
  return Response.json({ ...loadResponse.body, tmdbCachePurge }, { status: loadResponse.status });
}
