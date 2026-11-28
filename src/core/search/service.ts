// The search service: title search for the Search tab and a future MCP
// (VISION: Search). It asks the TMDB module for movies and series matching a
// query and marks each result with the user's current status for it, so a
// result can show the title is already on a list. Opening a result shows the
// same card the deck shows (the deck service's getCard).
//
// Dependencies are injected, so tests run with fakes. index.ts wires the real
// ones.

import { createVisibilityCheck } from "../deck/build-deck";
import { fail, ok, validateUserId, type Result } from "../result";
import type { TmdbClient } from "../tmdb/client";
import { TMDB_MAX_PAGE } from "../tmdb/constants";
import { posterUrl, ROW_POSTER_SIZE } from "../tmdb/images";
import { tryFormatTitleKey } from "../title-id";
import type { UserTitleState } from "../types";
import { SEARCH_PAGES_PER_REQUEST, SEARCH_QUERY_MAX_LENGTH } from "./constants";
import type { SearchPage, SearchResult } from "./types";

/** The TMDB call the service makes. The app passes getTmdb(). */
export type SearchTmdb = Pick<TmdbClient, "searchTitles">;

/** The library read the service makes. index.ts wires it to the library core. */
export interface SearchLibrary {
  /** Every row the user has (the deck reads the same rows on every page). */
  getUserTitleStates(userId: string): Promise<Result<UserTitleState[]>>;
}

export interface SearchServiceDeps {
  tmdb: SearchTmdb;
  library: SearchLibrary;
  now?: () => Date;
}

export type SearchService = ReturnType<typeof createSearchService>;

export function createSearchService(deps: SearchServiceDeps) {
  const { tmdb, library } = deps;
  const clock = deps.now ?? (() => new Date());

  /**
   * One page of movies and series matching `query`, in TMDB's relevance
   * order, each with the user's status for it. A blank query gives an empty
   * page without asking TMDB. Bad input (user, query, page) returns a typed
   * error. A TMDB outage throws, so a caller can tell "nothing matched" from
   * "search is down".
   *
   * TMDB's search also finds people, which are dropped, so a TMDB page can
   * hold no titles though later pages do (#46). An empty page reads on, up to
   * SEARCH_PAGES_PER_REQUEST pages in all. The returned `page` is the last
   * page read, so the next request starts after it, and `totalPages` stays
   * TMDB's: empty results with `page < totalPages` mean "none yet, there are
   * more pages", not "no matches".
   */
  async function searchTitles(userId: string, query: unknown, page: unknown = 1): Promise<Result<SearchPage>> {
    const u = validateUserId(userId);
    if (!u.ok) return u;
    const q = parseQuery(query);
    if (!q.ok) return q;
    const p = parsePage(page);
    if (!p.ok) return p;
    if (q.value === "") return ok({ query: "", results: [], page: p.value, totalPages: 0 });

    // Independent reads, in parallel.
    const [first, states] = await Promise.all([tmdb.searchTitles(q.value, p.value), library.getUserTitleStates(u.value)]);
    if (!states.ok) return states;
    // Read on past pages with no titles, one page at a time, within TMDB's page count and the per-request cap.
    let found = first;
    let read = p.value;
    const lastPage = Math.min(first.totalPages, TMDB_MAX_PAGE, p.value + SEARCH_PAGES_PER_REQUEST - 1);
    while (found.results.length === 0 && read < lastPage) {
      read += 1;
      found = await tmdb.searchTitles(q.value, read);
    }

    const statusByKey = new Map(states.value.map((s) => [tryFormatTitleKey(s), s.status]));
    const visible = createVisibilityCheck(states.value, clock());
    const results = found.results.map((t): SearchResult => {
      const status = statusByKey.get(tryFormatTitleKey(t)) ?? null;
      return {
        mediaType: t.mediaType,
        tmdbId: t.tmdbId,
        title: t.title,
        year: t.year,
        posterUrl: posterUrl(t.posterPath, ROW_POSTER_SIZE),
        overview: t.overview,
        // A skip that has run out puts the title back in the deck: it shows as untouched, the way the deck sees it.
        status: status === "skipped" && visible(t) ? null : status,
      };
    });
    return ok({ query: q.value, results, page: read, totalPages: first.totalPages });
  }

  return { searchTitles };
}

function invalid<T>(message: string): Result<T> {
  return fail({ code: "invalid_search_query", message });
}

/** The query trimmed, inner whitespace collapsed. Checked as unknown: it may come from JSON (the API, an MCP call). */
function parseQuery(query: unknown): Result<string> {
  if (typeof query !== "string") return invalid("query must be a string");
  const q = query.trim().replace(/\s+/g, " ");
  if (q.length > SEARCH_QUERY_MAX_LENGTH) return invalid(`query is longer than ${SEARCH_QUERY_MAX_LENGTH} characters`);
  return ok(q);
}

function parsePage(page: unknown): Result<number> {
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > TMDB_MAX_PAGE) {
    return invalid(`page must be a whole number from 1 to ${TMDB_MAX_PAGE}`);
  }
  return ok(page);
}
