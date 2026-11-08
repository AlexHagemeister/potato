import {
  createDevSession,
  isDevLoginEnabled,
  isDirectRequest,
  parseDevUserSlug,
} from "@/core/auth/dev-login";

// Development-only test sign-in for Playwright and agents. In `next dev`
// against potato_dev, open /api/dev/login (page.goto, or type it in the
// address bar) to be signed in as the shared test user and sent to /.
// Add ?as=<slug> (for example ?as=pr90) to sign in as your own test user,
// dev-test-<slug>@example.com, created on first use.
// Everywhere else it answers 404, whatever the query.
export const dynamic = "force-dynamic";

function devLoginEnv() {
  return {
    // Literal member access on purpose: Next.js replaces process.env.NODE_ENV
    // with "production" in `next build` output, so `NODE_ENV=development
    // next start` can't open this route. Don't refactor to process.env[key].
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    databaseUrl: process.env.DATABASE_URL,
  };
}

async function handle(request: Request) {
  // Checked on every request, never at import time.
  const env = devLoginEnv();
  if (!isDevLoginEnabled(env)) {
    return new Response("Not Found", { status: 404 });
  }
  if (!isDirectRequest(request.headers.get("sec-fetch-site"))) {
    return new Response("Forbidden: open this URL directly", { status: 403 });
  }
  // After the gate, so a closed route never reveals that ?as= exists.
  const slug = parseDevUserSlug(new URL(request.url).searchParams.getAll("as"));
  if (!slug.ok) {
    return new Response(`Bad Request: ${slug.reason}`, { status: 400 });
  }
  const { setCookie } = await createDevSession(env, slug.slug);
  return new Response(null, {
    status: 303,
    headers: { Location: new URL("/", request.url).toString(), "Set-Cookie": setCookie },
  });
}

export const GET = handle;
export const POST = handle;
