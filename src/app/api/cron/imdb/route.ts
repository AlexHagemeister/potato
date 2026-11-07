// Daily IMDb ratings load, invoked by Vercel Cron (vercel.json). Thin: the
// auth check and the load both live in src/core.

import { isAuthorizedCronRequest } from "@/core/cron-auth";
import { createPostgresRatingsLoadTarget, loadImdbRatings } from "@/core/imdb";

export const runtime = "nodejs";
// Run on every invocation; never serve a cached response to the cron.
export const dynamic = "force-dynamic";
// Seconds. The Vercel Hobby maximum (with fluid compute). A load takes well under a minute.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await loadImdbRatings({ target: createPostgresRatingsLoadTarget() });
  console.log("imdb ratings load", result);
  return Response.json(result);
}
