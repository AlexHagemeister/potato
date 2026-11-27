// Reports which commit this deployment runs, so a deploy can be proven live.
// Dynamic so the values come from the running deployment, not a build-time snapshot.
export const dynamic = "force-dynamic";

// An empty value (a blank line in a local .env file) reads as null, like a missing one.
export function GET() {
  return Response.json({
    sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    env: process.env.VERCEL_ENV || null,
  });
}
