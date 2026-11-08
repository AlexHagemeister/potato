import { sortDeckCardAction, type DeckActionResult } from "@/app/(app)/_deck/actions";
import { handleJsonPost } from "@/lib/json-post";

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
// 400, 403, 415             refused before saving (src/lib/json-post): not JSON, cross-site, not sent as JSON
export const dynamic = "force-dynamic";

const NOT_SAVED: DeckActionResult = { ok: false, error: "Couldn't save. Try again." };

type SortArgs = Parameters<typeof sortDeckCardAction>;

export function POST(request: Request): Promise<Response> {
  // Core refuses an unknown kind or a malformed title, and the action words it.
  return handleJsonPost(request, NOT_SAVED, ({ kind, title }) => sortDeckCardAction(kind as SortArgs[0], title as SortArgs[1]));
}
