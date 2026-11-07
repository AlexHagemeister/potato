import { getDeck, type DeckPage } from "@/core/deck-service";
import type { DiscoveryMode } from "@/core/types";
import { getCurrentUserForRequest } from "@/lib/current-user";

// One page of the signed-in user's deck, for the Discover screen. Thin glue
// (CLAUDE.md rule 3): it resolves the user from the session cookie, passes the
// query to core, and turns the result into a status code. Core validates the
// mode and the cursor.
//
// A GET route rather than a server action on purpose: Next.js runs a page's
// server actions one at a time, so a page fetch sent as an action would wait
// behind every card tap, and every tap behind the fetch.
//
//   GET /api/deck?cursor=<nextCursor>&mode=<mode>
//
// 200 { ok: true, page }      a DeckPage (cards, locked, or no_seeds)
// 400 { ok: false, error }    invalid_deck_query: a bad mode or a stale cursor. Start again without a cursor.
// 401 { ok: false, error }    signed_out: no session, or the user row is gone
// 503 { ok: false, error }    unavailable: TMDB (or the database) failed. Retry later.
export const dynamic = "force-dynamic";

export type DeckResponse =
  | { ok: true; page: DeckPage }
  | { ok: false; error: "invalid_deck_query" | "signed_out" | "unavailable" };

function reply(body: DeckResponse, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUserForRequest();
  if (!user) return reply({ ok: false, error: "signed_out" }, 401);

  const params = new URL(request.url).searchParams;
  const cursor = params.get("cursor");
  const mode = params.get("mode");

  try {
    const result = await getDeck(user.id, {
      cursor: cursor || null,
      // Core rejects an unknown mode with invalid_deck_query.
      ...(mode ? { mode: mode as DiscoveryMode } : {}),
    });
    if (result.ok) return reply({ ok: true, page: result.value }, 200);
    if (result.error.code === "invalid_deck_query") return reply({ ok: false, error: "invalid_deck_query" }, 400);
    // The session outlived its user row: the client reloads to the sign-in screen.
    if (result.error.code === "unknown_user" || result.error.code === "invalid_user") {
      return reply({ ok: false, error: "signed_out" }, 401);
    }
    // Any other refusal (an error code added later) reads as a failure to retry.
    console.error("deck: getDeck refused:", result.error);
    return reply({ ok: false, error: "unavailable" }, 503);
  } catch (err) {
    // getDeck throws when TMDB is down (every list or details lookup failed).
    console.error("deck: getDeck failed:", err);
    return reply({ ok: false, error: "unavailable" }, 503);
  }
}
