import { createDevSession, isDevLoginEnabled } from "@/core/auth/dev-login";

// Development-only test sign-in for Playwright and agents. Visit
// /api/dev/login in `next dev` to be signed in as the test user and sent to /.
// Everywhere else (Vercel, production builds) it answers 404.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Checked on every request, never at build or import time.
  if (!isDevLoginEnabled(process.env)) {
    return new Response("Not Found", { status: 404 });
  }
  const { setCookie } = await createDevSession(process.env);
  return new Response(null, {
    status: 303,
    headers: { Location: new URL("/", request.url).toString(), "Set-Cookie": setCookie },
  });
}
