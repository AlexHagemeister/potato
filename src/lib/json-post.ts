// HTTP glue for the app's own JSON POST routes (the deck's sort and choice
// saves, issue 106): the checks a request must pass before its body reaches
// the route's handler, and the reply. No app logic: the handler calls core.
//
// The checks stand in for what Next.js server actions did for free (they
// refuse a cross-origin POST):
// - Sec-Fetch-Site "cross-site" or "same-site" is refused (403). The app only
//   ever calls these routes from its own pages ("same-origin"). A browser too
//   old to send the header is let through, and the next two checks still hold.
// - The body must be sent as JSON (415). A page on another site can't send
//   JSON without a CORS preflight, and the app answers none.
// - The body must parse as JSON (400).
// The session cookie is also SameSite=Lax, so a cross-site request carries no
// session anyway.

/** Why a request was refused before its handler ran, or null when it may go on. */
export function jsonPostRefusal(headers: Headers): 403 | 415 | null {
  const site = headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return 403;
  if (!headers.get("content-type")?.startsWith("application/json")) return 415;
  return null;
}

function reply(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Runs a JSON POST route: refuses a request that fails the checks above with
 * `refused` (the route's own failure reply), and otherwise hands the body's
 * fields to `handle` and replies 200 with its result. A body that is not a
 * JSON object reaches `handle` as an empty object, so the handler's own
 * validation (core's) refuses it.
 */
export async function handleJsonPost<T>(
  request: Request,
  refused: T,
  handle: (fields: Record<string, unknown>) => Promise<T>,
): Promise<Response> {
  const refusal = jsonPostRefusal(request.headers);
  if (refusal) return reply(refused, refusal);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply(refused, 400);
  }
  const fields = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return reply(await handle(fields), 200);
}
