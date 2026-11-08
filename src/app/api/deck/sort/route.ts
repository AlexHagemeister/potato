import { sortDeckCardAction, type DeckActionResult } from "@/app/(app)/_deck/actions";

// Pass, Skip, or Watchlist on a Discover card. Thin glue (CLAUDE.md rule 3):
// it reads the body and calls the same function the deck's server action
// was, which resolves the user from the session cookie, calls core, and words
// core's refusals. Core checks the title and the sort, and keeps its
// compare-and-set rules (issues 74 and 83).
//
// A route rather than a server action because of issue 106: Next.js runs a
// page's server actions one at a time, so taps faster than the saves queued
// in the browser, and a reload or a closed home-screen app dropped the queue.
// The deck sends each sort the moment it is tapped, with fetch's keepalive,
// so the request outlives the page.
//
//   POST /api/deck/sort   { kind: "pass" | "skip" | "watchlist", title: { mediaType, tmdbId } }
//
// 200 DeckActionResult      saved, or refused with the message the screen shows
// 400 { ok: false, error }  the body is not JSON
// 415 { ok: false, error }  not sent as JSON. A cross-site page can't send JSON without a preflight, which fails.
export const dynamic = "force-dynamic";

const NOT_SAVED = "Couldn't save. Try again.";

function reply(body: DeckActionResult, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return reply({ ok: false, error: NOT_SAVED }, 415);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ ok: false, error: NOT_SAVED }, 400);
  }
  const { kind, title } = (typeof body === "object" && body !== null ? body : {}) as { kind?: unknown; title?: unknown };
  // Core refuses an unknown kind or a malformed title, and the action words it.
  const result = await sortDeckCardAction(kind as Parameters<typeof sortDeckCardAction>[0], title as Parameters<typeof sortDeckCardAction>[1]);
  return reply(result, 200);
}
