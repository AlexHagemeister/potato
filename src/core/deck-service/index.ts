// The deck service: cards for the Discover screen, Search, and a future MCP.
// getDeck and getCard here use the app's real dependencies: the TMDB module,
// the IMDb ratings table, and the library core. createDeckService takes
// injected ones (tests).

import { PostgresRatingsStore } from "../imdb/postgres";
import { getTitleState, getTitleStatesFor, getTopRatedSeen, getUserSettings, getUserTitleStates } from "../library";
import { ok, type Result } from "../result";
import { getTmdb } from "../tmdb/app-client";
import type { TitleId } from "../types";
import { createDeckService, type DeckLibrary, type DeckService } from "./service";
import type { Card, DeckPage, DeckRequest } from "./types";

export * from "./constants";
export * from "./types";
export { cardUserState, type UserStateRow } from "./user-state";
export { createDeckService, type DeckLibrary, type DeckService, type DeckServiceDeps, type DeckTmdb } from "./service";

/** The library core, in the shape the deck service reads. */
export const libraryForDeck: DeckLibrary = {
  getUserTitleStates,
  getUserSettings,
  getTopRatedSeen,
  getTitleStatesFor,
  async getTitleState(userId, ref) {
    const row = await getTitleState(userId, ref);
    if (!row.ok) return row;
    if (!row.value) return ok(null);
    const { status, rating, review, skipUntil } = row.value;
    return ok({ status, rating, review, skipUntil });
  },
};

let service: DeckService | undefined;

function appService(): DeckService {
  service ??= createDeckService({ tmdb: getTmdb(), ratings: new PostgresRatingsStore(), library: libraryForDeck });
  return service;
}

/**
 * One page of the user's deck. Pass `nextCursor` back, with the same mode and
 * filters, for the next page. See DeckPage for the paging rules.
 */
export function getDeck(userId: string, request: DeckRequest = {}): Promise<Result<DeckPage>> {
  return appService().getDeck(userId, request);
}

/** The full card for one title, with the user's current status for it. */
export function getCard(userId: string, ref: TitleId): Promise<Result<Card>> {
  return appService().getCard(userId, ref);
}

/**
 * Which of these titles the deck must no longer show (sorted since they were
 * dealt). The Discover screen checks its queued cards with it on return.
 */
export function hiddenTitles(userId: string, refs: unknown): Promise<Result<TitleId[]>> {
  return appService().hiddenTitles(userId, refs);
}
