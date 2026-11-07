import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/core/auth/auth";

// Better Auth's endpoints, including the Google callback at
// /api/auth/callback/google. Built on the first request, not at import, so
// nothing touches the database or the secret at build time.
let handler: ReturnType<typeof toNextJsHandler> | undefined;
const getHandler = () => (handler ??= toNextJsHandler(getAuth()));

export function GET(request: Request) {
  return getHandler().GET(request);
}

export function POST(request: Request) {
  return getHandler().POST(request);
}
