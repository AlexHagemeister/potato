// Daily IMDb ratings load, invoked by Vercel Cron (vercel.json). It also
// purges long-expired tmdb_cache rows (issue 14), riding on this job because
// it already runs nightly. Thin: the auth check and the job (load, then
// purge) live in src/core.

import { PostgresCacheStore } from "@/core/cache";
import { isAuthorizedCronRequest } from "@/core/cron-auth";
import { createPostgresRatingsLoadTarget, loadImdbRatings } from "@/core/imdb";
import { runDailyJob } from "@/core/imdb/daily-job";

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
  const { status, body } = await runDailyJob({
    loadRatings: () => loadImdbRatings({ target: createPostgresRatingsLoadTarget() }),
    cacheStore: new PostgresCacheStore(),
    budgetMs: maxDuration * 1000,
  });
  return Response.json(body, { status });
}
