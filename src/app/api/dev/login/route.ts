import { createDevSession, isDevLoginEnabled, isDirectRequest } from "@/core/auth/dev-login";

// Development-only test sign-in for Playwright and agents. In `next dev`
// against potato_dev, open /api/dev/login (page.goto, or type it in the
// address bar) to be signed in as the test user and sent to /.
// Everywhere else it answers 404.
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
  const { setCookie } = await createDevSession(env);
  return new Response(null, {
    status: 303,
    headers: { Location: new URL("/", request.url).toString(), "Set-Cookie": setCookie },
  });
}

export const GET = handle;
export const POST = handle;
