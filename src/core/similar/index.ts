// The similar-titles row (You might also like). similarTitles here uses the
// app's real dependencies: the TMDB module, the IMDb ratings table, and the
// library core. createSimilarService takes injected ones (tests).

import { PostgresRatingsStore } from "../imdb/postgres";
import { getTopRatedSeen, getUserTitleStates } from "../library";
import type { Result } from "../result";
import { getTmdb } from "../tmdb/app-client";
import type { TitleId } from "../types";
import { createSimilarService, type SimilarService } from "./service";
import type { SimilarTitle } from "./types";

export * from "./constants";
export * from "./types";
export { createSimilarService, type SimilarLibrary, type SimilarService, type SimilarServiceDeps, type SimilarTmdb } from "./service";

let service: SimilarService | undefined;

function appService(): SimilarService {
  service ??= createSimilarService({ tmdb: getTmdb(), ratings: new PostgresRatingsStore(), library: { getUserTitleStates, getTopRatedSeen } });
  return service;
}

/** Titles to suggest under this title's card, best first. See createSimilarService for the error rules. */
export function similarTitles(userId: string, ref: TitleId): Promise<Result<SimilarTitle[]>> {
  return appService().similarTitles(userId, ref);
}
