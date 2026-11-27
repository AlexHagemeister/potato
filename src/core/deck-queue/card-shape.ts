// The shape check for a /api/deck answer, as the Discover client reads it (issue 129). Every merge deploys while
// phones still run an older client, so the client checks what it got instead of trusting a cast. A shape change then
// fails here, in one known place:
// - A malformed card is dropped, with the reason, and the rest of the page goes on. One bad card must never stall
//   the deck (issue 41): before this check, a card with a bad identity threw in the queue, the fetch failed, and
//   every retry asked for the same page again. A page whose every card was dropped reads as a failed page, below.
// - A malformed envelope (not an object, no ok, an unknown page kind, a page without its cards) reads as a failed
//   page, which the screen retries as it does any other.
//
// It checks what the client reads, and the types each field promises, and it ignores fields it does not know: a
// newer server may add one, and an older client must keep working. Pure, so it runs in the browser (see index.ts).

import type { DeckPage, DeckPageCard } from "../deck-service/types";
import { titleIdError } from "../title-id";

/** A card the check dropped: where it was on the page, and why. */
export interface DroppedCard {
  index: number;
  reason: string;
}

export type DeckRead =
  /** A page the deck can use. On a cards page, `dropped` lists the cards left out. */
  | { kind: "page"; page: DeckPage; dropped: DroppedCard[] }
  /** The service refused the page, with its error code. */
  | { kind: "refused"; error: string }
  /** The answer is not a deck answer at all. */
  | { kind: "malformed"; reason: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);
const isStrOrNull = orNull(isStr);
const isNumOrNull = orNull(isNum);

/** Each field a card must have, and the check its value must pass. Fields not listed are not read here. */
const CARD_FIELDS: [string, (v: unknown) => boolean][] = [
  ["posterUrl", isStrOrNull],
  ["title", isStr],
  ["year", isNumOrNull],
  ["genres", (v) => Array.isArray(v) && v.every((g) => isObj(g) && isNum(g.id) && isStr(g.name))],
  ["runtimeMinutes", isNumOrNull],
  ["numberOfSeasons", isNumOrNull],
  ["synopsis", isStr],
  ["trailerYouTubeKey", isStrOrNull],
  // Not checked: userState and source. The Discover client never reads them, so a server that changed or dropped
  // them must not cost an older client its cards.
];

/** Why the IMDb part of a card is malformed, or null when it is fine (CardImdb). */
function imdbProblem(imdb: unknown): string | null {
  if (!isObj(imdb)) return "imdb is not an object";
  if (imdb.kind === "rated") {
    if (!isStr(imdb.imdbId)) return "imdb.imdbId is not a string";
    if (!isNum(imdb.rating) || !isNum(imdb.votes)) return "imdb rating or votes is not a number";
    return null;
  }
  if (!isStr(imdb.kind)) return "imdb.kind is not a string";
  if (imdb.kind === "none" || imdb.kind === "unavailable") {
    return isStrOrNull(imdb.imdbId) ? null : "imdb.imdbId is not a string or null";
  }
  // A kind this client does not know (a newer server may add one): the card shows the IMDb badge alone, with a link
  // built from imdbId when there is one, so imdbId may be a string, null, or missing.
  return imdb.imdbId === undefined || isStrOrNull(imdb.imdbId) ? null : "imdb.imdbId is not a string or null";
}

/** Why one streaming provider is malformed, or null (CardProvider). Offer names are not checked against a list. */
function providerProblem(p: unknown): string | null {
  if (!isObj(p)) return "a provider is not an object";
  if (!isNum(p.id) || !isStr(p.name) || !isStrOrNull(p.logoUrl)) return "a provider's id, name, or logoUrl is malformed";
  if (!Array.isArray(p.offers) || !p.offers.every(isStr)) return "a provider's offers is not a list of strings";
  if (!isBool(p.streams) || !isBool(p.isMine)) return "a provider's streams or isMine is not a boolean";
  return null;
}

/** Why the streaming part of a card is malformed, or null (CardStreaming). The JustWatch credit must be there. */
function streamingProblem(s: unknown): string | null {
  if (!isObj(s)) return "streaming is not an object";
  if (!isStr(s.country)) return "streaming.country is not a string";
  if (!isObj(s.attribution) || !isStr(s.attribution.text) || !isStr(s.attribution.url)) return "streaming.attribution is malformed";
  if (!isStr(s.kind)) return "streaming.kind is not a string";
  // Only a known answer is read past this point. "unknown", or a kind this client does not know (a newer server may
  // add one), shows the heading and the JustWatch credit alone.
  if (s.kind !== "known") return null;
  if (!isBool(s.onMyServices) || !isStrOrNull(s.link)) return "streaming.onMyServices or link is malformed";
  if (!Array.isArray(s.providers)) return "streaming.providers is not a list";
  for (const p of s.providers) {
    const problem = providerProblem(p);
    if (problem) return problem;
  }
  return null;
}

/** Why a value is not a deck card the client can show, or null when it is one. */
export function cardProblem(card: unknown): string | null {
  if (!isObj(card)) return "card is not an object";
  const id = titleIdError(card);
  if (id) return id;
  for (const [field, check] of CARD_FIELDS) {
    if (!check(card[field])) return `${field} is malformed`;
  }
  return imdbProblem(card.imdb) ?? streamingProblem(card.streaming);
}

/** Reads a cards page: keeps each card that passes, and says which were dropped and why. */
function readCards(page: Obj): DeckRead {
  if (!Array.isArray(page.cards)) return { kind: "malformed", reason: "page.cards is not a list" };
  const nextCursor = page.nextCursor;
  if (nextCursor !== null && !isStr(nextCursor)) return { kind: "malformed", reason: "page.nextCursor is not a string or null" };
  const cards: DeckPageCard[] = [];
  const dropped: DroppedCard[] = [];
  page.cards.forEach((card: unknown, index) => {
    const reason = cardProblem(card);
    if (reason) dropped.push({ index, reason });
    else cards.push(card as DeckPageCard);
  });
  // A page that came with cards and lost all of them is a failure, not an empty page: an empty page counts toward
  // "Still looking", and the deck would ask for the next page with nothing to show for this one. A truly empty page
  // (no cards sent) stays an empty page.
  if (page.cards.length > 0 && cards.length === 0) {
    return { kind: "malformed", reason: `all ${dropped.length} cards malformed (first: ${dropped[0].reason})` };
  }
  return { kind: "page", page: { kind: "cards", cards, nextCursor }, dropped };
}

/**
 * Reads a parsed /api/deck body. The cards that pass are the same objects that came in, not copies; the page around
 * them is new only when it is a cards page.
 */
export function readDeckResponse(body: unknown): DeckRead {
  if (!isObj(body)) return { kind: "malformed", reason: "body is not an object" };
  if (body.ok === false) {
    return isStr(body.error) ? { kind: "refused", error: body.error } : { kind: "malformed", reason: "error is not a string" };
  }
  if (body.ok !== true) return { kind: "malformed", reason: "ok is not a boolean" };
  const page = body.page;
  if (!isObj(page)) return { kind: "malformed", reason: "page is not an object" };
  switch (page.kind) {
    case "cards":
      return readCards(page);
    case "locked":
      // The screen shows how many ratings are still needed.
      if (!isNum(page.remaining)) return { kind: "malformed", reason: "locked page.remaining is not a number" };
      return { kind: "page", page: page as unknown as DeckPage, dropped: [] };
    case "no_seeds":
      return { kind: "page", page: page as unknown as DeckPage, dropped: [] };
    default:
      return { kind: "malformed", reason: `unknown page.kind ${JSON.stringify(page.kind)}` };
  }
}
