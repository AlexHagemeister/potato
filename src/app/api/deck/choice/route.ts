import { saveDeckChoiceAction } from "@/app/(app)/_deck/actions";
import { handleJsonPost } from "@/lib/json-post";

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
// 400, 403, 415                            refused before saving (src/lib/json-post): not JSON, cross-site, not sent as JSON
export const dynamic = "force-dynamic";

export type ChoiceSaveResult = Awaited<ReturnType<typeof saveDeckChoiceAction>>;

const NOT_SAVED: ChoiceSaveResult = { ok: false, error: "Couldn't save your mode and filters. Try again." };

export function POST(request: Request): Promise<Response> {
  return handleJsonPost(request, NOT_SAVED, ({ choice }) => saveDeckChoiceAction(choice));
}
