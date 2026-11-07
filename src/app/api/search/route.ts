import { searchTitles, type SearchPage } from "@/core/search";
import { getCurrentUserForRequest } from "@/lib/current-user";

// One page of title search results for the signed-in user, for the Search
// tab. Thin glue (CLAUDE.md rule 3): it resolves the user from the session
// cookie, passes the query to core, and turns the result into a status code.
// Core validates the query and the page.
//
// A GET route rather than a server action, like /api/deck: Next.js runs a
// page's server actions one at a time, so a search would wait behind every
// card tap.
//
//   GET /api/search?q=<query>&page=<n>
//
// 200 { ok: true, page }      a SearchPage (empty for a blank query)
// 400 { ok: false, error }    invalid_search_query: the query is too long, or the page is out of range
// 401 { ok: false, error }    signed_out: no session, or the user row is gone
// 503 { ok: false, error }    unavailable: TMDB (or the database) failed. Retry later.
export const dynamic = "force-dynamic";

export type SearchResponse =
  | { ok: true; page: SearchPage }
  | { ok: false; error: "invalid_search_query" | "signed_out" | "unavailable" };

function reply(body: SearchResponse, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUserForRequest();
  if (!user) return reply({ ok: false, error: "signed_out" }, 401);

  const params = new URL(request.url).searchParams;
  const page = params.get("page");

  try {
    // A missing page is page 1. Anything else goes to core as a number, which rejects what is not a whole page number.
    const result = await searchTitles(user.id, params.get("q") ?? "", page === null ? 1 : Number(page));
    if (result.ok) return reply({ ok: true, page: result.value }, 200);
    if (result.error.code === "invalid_search_query") return reply({ ok: false, error: "invalid_search_query" }, 400);
    if (result.error.code === "unknown_user" || result.error.code === "invalid_user") {
      return reply({ ok: false, error: "signed_out" }, 401);
    }
    console.error("search: searchTitles refused:", result.error);
    return reply({ ok: false, error: "unavailable" }, 503);
  } catch (err) {
    // searchTitles throws when TMDB is down.
    console.error("search: searchTitles failed:", err);
    return reply({ ok: false, error: "unavailable" }, 503);
  }
}
