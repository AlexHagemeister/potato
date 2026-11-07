import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/core/auth/auth";

// Better Auth's endpoints, including the Google callback at
// /api/auth/callback/google. The handler is built per request so nothing
// touches the database or the secret at build time.
export function GET(request: Request) {
  return toNextJsHandler(getAuth()).GET(request);
}

export function POST(request: Request) {
  return toNextJsHandler(getAuth()).POST(request);
}
