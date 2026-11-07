// The client's queue of deck cards: which card is on top, which come next,
// and when to ask the deck service for another page. Pure functions over an
// immutable value, so the Discover screen, a future native app, and tests
// share one set of paging rules (CLAUDE.md architecture rule 3). It imports
// types only, so it is safe to bundle into the browser.
//
// The paging rules come from DeckPage (src/core/deck-service/types.ts):
// keep calling while nextCursor is not null, even when a page has no cards,
// and drop any card already dealt, by (media type, TMDB ID).

import type { DeckPageCard } from "../deck-service/types";
import { formatTitleKey } from "../title-id";
import type { TitleId } from "../types";

/** Ask for another page when fewer cards than this are queued. */
export const QUEUE_LOW_WATER = 5;

/**
 * Pages in a row that may add no new card before the queue stops asking.
 * The service moves its cursor on every call, but a narrow filter can burn
 * many pages. Past this, the screen offers a retry instead of looping.
 */
export const MAX_EMPTY_PAGES = 6;

export interface DeckQueue {
  /** Cards waiting to be shown. cards[0] is on screen. */
  cards: DeckPageCard[];
  /**
   * Every title this queue has dealt, by key, including cards already sorted.
   * A page fetched while a sort is still saving can deal that title again, so
   * dedupe against everything, not only what is still queued.
   */
  dealt: ReadonlySet<string>;
  /** The cursor for the next page. Null before the first page and after the last. */
  cursor: string | null;
  /** True once a page came back with nextCursor null: the service has nothing more. */
  exhausted: boolean;
  /** Pages in a row that added no card. */
  emptyPages: number;
}

export function titleKey(ref: TitleId): string {
  return formatTitleKey(ref);
}

export function emptyQueue(): DeckQueue {
  return { cards: [], dealt: new Set(), cursor: null, exhausted: false, emptyPages: 0 };
}

/** Appends a page's new cards and takes its cursor. */
export function addPage(queue: DeckQueue, page: { cards: DeckPageCard[]; nextCursor: string | null }): DeckQueue {
  const dealt = new Set(queue.dealt);
  const fresh: DeckPageCard[] = [];
  for (const card of page.cards) {
    const key = titleKey(card);
    if (dealt.has(key)) continue;
    dealt.add(key);
    fresh.push(card);
  }
  return {
    cards: [...queue.cards, ...fresh],
    dealt,
    cursor: page.nextCursor,
    exhausted: page.nextCursor === null,
    emptyPages: fresh.length > 0 ? 0 : queue.emptyPages + 1,
  };
}

/** True when the queue is running low and the service may have more. */
export function needsMore(queue: DeckQueue): boolean {
  return !queue.exhausted && queue.cards.length < QUEUE_LOW_WATER && queue.emptyPages < MAX_EMPTY_PAGES;
}

/** True when too many pages in a row came back empty and the queue stopped asking. */
export function stalled(queue: DeckQueue): boolean {
  return !queue.exhausted && queue.emptyPages >= MAX_EMPTY_PAGES;
}

/** Lets a stalled queue ask again (the screen's retry). */
export function resumeQueue(queue: DeckQueue): DeckQueue {
  return { ...queue, emptyPages: 0 };
}

/**
 * Forgets the cursor but keeps the cards and what was dealt: the service
 * rejected the cursor (stale after a settings change), so the next page
 * starts the deck again and dedupe drops what this queue already showed.
 */
export function restartCursor(queue: DeckQueue): DeckQueue {
  return { ...queue, cursor: null, exhausted: false, emptyPages: 0 };
}

/** Takes a title out of the queue (it was sorted). Unknown titles leave it unchanged. */
export function removeCard(queue: DeckQueue, ref: TitleId): DeckQueue {
  const key = titleKey(ref);
  const cards = queue.cards.filter((c) => titleKey(c) !== key);
  return cards.length === queue.cards.length ? queue : { ...queue, cards };
}

/** Puts a card back on top (undo, or a sort that failed to save). Never duplicates it. */
export function returnToFront(queue: DeckQueue, card: DeckPageCard): DeckQueue {
  const key = titleKey(card);
  const dealt = queue.dealt.has(key) ? queue.dealt : new Set([...queue.dealt, key]);
  return { ...queue, dealt, cards: [card, ...queue.cards.filter((c) => titleKey(c) !== key)] };
}
