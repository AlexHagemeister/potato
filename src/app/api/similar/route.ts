import { similarTitles, type SimilarTitle } from "@/core/similar";
import { parseTitleKey } from "@/core/title-id";
import { getCurrentUserForRequest } from "@/lib/current-user";

// The "You might also like" row for one title's card. Thin glue (CLAUDE.md
// rule 3): it resolves the user from the session cookie, passes the title to
// core, and turns the result into a status code.
//
// A GET route rather than a server action, like /api/search: the row loads
// after the card is up, and a server action would queue behind card taps.
//
//   GET /api/similar?title=<mediaType>:<tmdbId>
//
// 200 { ok: true, titles }    SimilarTitle[], best first (empty when there is nothing to suggest)
// 400 { ok: false, error }    invalid_title: the title key does not parse
// 401 { ok: false, error }    signed_out: no session, or the user row is gone
// 503 { ok: false, error }    unavailable: TMDB (or the database) failed. Retry later.
export const dynamic = "force-dynamic";

export type SimilarResponse =
  | { ok: true; titles: SimilarTitle[] }
  | { ok: false; error: "invalid_title" | "signed_out" | "unavailable" };

function reply(body: SimilarResponse, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUserForRequest();
  if (!user) return reply({ ok: false, error: "signed_out" }, 401);

  const ref = parseTitleKey(new URL(request.url).searchParams.get("title") ?? "");
  if (!ref) return reply({ ok: false, error: "invalid_title" }, 400);

  try {
    const result = await similarTitles(user.id, ref);
    if (result.ok) return reply({ ok: true, titles: result.value }, 200);
    if (result.error.code === "invalid_title") return reply({ ok: false, error: "invalid_title" }, 400);
    if (result.error.code === "unknown_user" || result.error.code === "invalid_user") {
      return reply({ ok: false, error: "signed_out" }, 401);
    }
    console.error("similar: similarTitles refused:", result.error);
    return reply({ ok: false, error: "unavailable" }, 503);
  } catch (err) {
    // similarTitles throws when TMDB is down.
    console.error("similar: similarTitles failed:", err);
    return reply({ ok: false, error: "unavailable" }, 503);
  }
}
