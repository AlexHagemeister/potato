// Title search (VISION: Search). searchTitles here uses the app's real
// dependencies: the TMDB module and the library core. createSearchService
// takes injected ones (tests).

import { getUserTitleStates } from "../library";
import type { Result } from "../result";
import { getTmdb } from "../tmdb/app-client";
import { createSearchService, type SearchService } from "./service";
import type { SearchPage } from "./types";

export * from "./constants";
export * from "./types";
export { mergeSearchPages } from "./merge";
export { createSearchService, type SearchLibrary, type SearchService, type SearchServiceDeps, type SearchTmdb } from "./service";

let service: SearchService | undefined;

function appService(): SearchService {
  service ??= createSearchService({ tmdb: getTmdb(), library: { getUserTitleStates } });
  return service;
}

/**
 * One page of movies and series matching `query`, each with the user's status
 * for it. Open a result with the deck service's getCard. See
 * createSearchService for the error rules.
 */
export function searchTitles(userId: string, query: unknown, page: unknown = 1): Promise<Result<SearchPage>> {
  return appService().searchTitles(userId, query, page);
}
