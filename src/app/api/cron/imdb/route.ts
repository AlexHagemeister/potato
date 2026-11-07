// Daily IMDb ratings load, invoked by Vercel Cron (vercel.json). Thin: the
// auth check and the load both live in src/core.

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
  try {
    const result = await loadImdbRatings({ target: createPostgresRatingsLoadTarget() });
    console.log("imdb ratings load", result);
    return Response.json(result);
  } catch (err) {
    // A failed run keeps yesterday's ratings (the load rolls back). The 500
    // marks the run as failed in Vercel's cron log, and the message says why.
    const guard = err instanceof ImdbLoadGuardError;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`IMDB RATINGS LOAD FAILED${guard ? " (guard stopped the swap)" : ""}: ${message}`, err);
    return Response.json({ ok: false, guard, error: message }, { status: 500 });
  }
}
