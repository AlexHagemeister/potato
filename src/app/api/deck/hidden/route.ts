import { hiddenTitles } from "@/core/deck-service";
import type { TitleId } from "@/core/types";
import { getCurrentUserForRequest } from "@/lib/current-user";

// Which of the Discover screen's queued titles were sorted since they were
// dealt (in Search, Lists, or on another device), so the deck can drop them
// when the user comes back to the tab (VISION invariant 3). Thin glue
// (CLAUDE.md rule 3): it resolves the user from the session cookie and passes
// the titles to core, which checks them and applies the deck's hiding rule.
//
// A route rather than a server action for the same reason as GET /api/deck:
// server actions run one at a time, so the check would hold up the first card
// tap after returning to the tab. POST because the titles ride in the body.
//
//   POST /api/deck/hidden   { titles: [{ mediaType, tmdbId }, ...] }
//
// 200 { ok: true, hidden }   the titles to drop, a subset of those sent
// 400 { ok: false, error }   invalid: not a list of at most MAX_HIDDEN_CHECK titles
// 401 { ok: false, error }   signed_out
// 503 { ok: false, error }   unavailable: the database failed. The deck keeps its cards.
export const dynamic = "force-dynamic";

export type HiddenResponse =
  | { ok: true; hidden: TitleId[] }
  | { ok: false; error: "invalid" | "signed_out" | "unavailable" };

function reply(body: HiddenResponse, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUserForRequest();
  if (!user) return reply({ ok: false, error: "signed_out" }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ ok: false, error: "invalid" }, 400);
  }
  const titles = typeof body === "object" && body !== null ? (body as { titles?: unknown }).titles : undefined;

  try {
    const result = await hiddenTitles(user.id, titles);
    if (result.ok) return reply({ ok: true, hidden: result.value }, 200);
    if (result.error.code === "unknown_user" || result.error.code === "invalid_user") {
      return reply({ ok: false, error: "signed_out" }, 401);
    }
    return reply({ ok: false, error: "invalid" }, 400);
  } catch (err) {
    console.error("deck: hiddenTitles failed:", err);
    return reply({ ok: false, error: "unavailable" }, 503);
  }
}
