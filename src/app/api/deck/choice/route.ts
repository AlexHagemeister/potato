import { saveDeckChoiceAction } from "@/app/(app)/_deck/actions";

// Saves the Discover mode and filters to the profile. Thin glue (CLAUDE.md
// rule 3): it reads the body and calls the same function the deck's server
// action was, which resolves the user from the session cookie and calls
// core. Core validates the choice.
//
// A route rather than a server action because of issue 106: server actions
// run one at a time, so a change queued in the browser behind other saves was
// lost on a reload or a closed home-screen app. The deck sends with fetch's
// keepalive, so the request outlives the page.
//
//   POST /api/deck/choice   { choice: DeckChoice }
//
// 200 { ok: true } | { ok: false, error }   saved, or refused with the message the screen shows
// 400 { ok: false, error }                  the body is not JSON
// 415 { ok: false, error }                  not sent as JSON. A cross-site page can't send JSON without a preflight, which fails.
export const dynamic = "force-dynamic";

export type ChoiceSaveResult = Awaited<ReturnType<typeof saveDeckChoiceAction>>;

const NOT_SAVED = "Couldn't save your mode and filters. Try again.";

function reply(body: ChoiceSaveResult, status: number): Response {
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
  const choice = typeof body === "object" && body !== null ? (body as { choice?: unknown }).choice : undefined;
  return reply(await saveDeckChoiceAction(choice), 200);
}
