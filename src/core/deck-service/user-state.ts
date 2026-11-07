// The user's state for one title, as the full card shows it. Pure (no database,
// no clock of its own), so the card screen can apply it to an action's outcome
// in the browser, and getCard applies it on the server.

import { createVisibilityCheck } from "../deck/build-deck";
import type { TitleId, TitleStatus } from "../types";
import type { CardUserState } from "./types";

/** A title_status row, or the part of one the card needs. skipUntil may be a string once it has crossed JSON. */
export interface UserStateRow {
  status: TitleStatus;
  rating: number | null;
  review: string | null;
  skipUntil: Date | string | null;
}

/**
 * The card's user state for a title's row at `now`. A skip that has run out
 * puts the title back in the deck, so the card shows it as untouched (null),
 * as Search does. The rule is the deck's own (createVisibilityCheck), so the
 * deck, Search, and the card always agree. A skip whose return time does not
 * parse stays hidden in the deck, so it stays "skipped" here.
 */
export function cardUserState(ref: TitleId, row: UserStateRow | null, now: Date): CardUserState | null {
  if (!row) return null;
  if (row.status === "skipped") {
    const visible = createVisibilityCheck([{ mediaType: ref.mediaType, tmdbId: ref.tmdbId, status: row.status, skipUntil: row.skipUntil }], now);
    if (visible(ref)) return null;
  }
  return {
    status: row.status,
    rating: row.rating,
    review: row.review,
    skipUntil: row.skipUntil === null ? null : new Date(row.skipUntil),
  };
}
