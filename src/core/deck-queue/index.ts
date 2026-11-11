// The client's queue of deck cards: which card is on top, which come next,
// and when to ask the deck service for another page. Pure functions over an
// immutable value, so the Discover screen, a future native app, and tests
// share one set of paging rules (CLAUDE.md architecture rule 3). It runs in
// the browser, so it may import only pure modules: today that is types,
// formatTitleKey from ../title-id, and the deck engine's hiding rule for one
// row (rowVisible, pure, which the card screen also runs in the browser).
// Never import server-only code here.
//
// The paging rules come from DeckPage (src/core/deck-service/types.ts):
// keep calling while nextCursor is not null, even when a page has no cards,
// and drop any card already dealt, by (media type, TMDB ID).

import { rowVisible } from "../deck/build-deck";
import type { DeckPageCard } from "../deck-service/types";
import { formatTitleKey, toTitleId } from "../title-id";
import type { TitleId, TitleStatus } from "../types";

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
  /**
   * After a refresh: the title that was on screen. If the next page deals it
   * again, it goes back on top, so the user keeps their card with fresh data.
   */
  keepOnTop: string | null;
  /**
   * The deal this queue asks for: the shuffle seed it sends with a first page
   * (a call without a cursor). The queue holds it so the same deal comes back
   * when a first page is asked for again (a retry, a stale cursor, a refresh
   * after a settings change). Null until the screen gives it one
   * (withShuffleSeed), and again when a new deal is due.
   */
  shuffleSeed: string | null;
}

export function titleKey(ref: TitleId): string {
  return formatTitleKey(ref);
}

export function emptyQueue(): DeckQueue {
  return { cards: [], dealt: new Set(), cursor: null, exhausted: false, emptyPages: 0, keepOnTop: null, shuffleSeed: null };
}

/**
 * The queue with a shuffle seed for its deal: its own if it has one, or else
 * a new one from `make`. The queue stays pure: the screen brings the
 * randomness, and makes a seed only when a new deal is due.
 */
export function withShuffleSeed(queue: DeckQueue, make: () => string): DeckQueue {
  return queue.shuffleSeed === null ? { ...queue, shuffleSeed: make() } : queue;
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
  const top = queue.keepOnTop === null ? -1 : fresh.findIndex((c) => titleKey(c) === queue.keepOnTop);
  if (top > 0) fresh.unshift(...fresh.splice(top, 1));
  return {
    ...queue,
    cards: [...queue.cards, ...fresh],
    dealt,
    cursor: page.nextCursor,
    exhausted: page.nextCursor === null,
    emptyPages: fresh.length > 0 ? 0 : queue.emptyPages + 1,
    // Only the first page after a refresh may put the old card back on top.
    keepOnTop: null,
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

/**
 * Why a queue stopped asking, or null when it has not. "reach_spent" is a
 * stall under a minimum IMDb rating. Each such page already reached several
 * take rounds deep (MIN_RATING_TAKE_ROUNDS in the deck service), so
 * MAX_EMPTY_PAGES empty pages in a row mean a long, bounded search found
 * nothing more rated that high. The screen says so plainly, as the end of
 * the deck for these filters, instead of "Still looking".
 */
export function queueStop(queue: DeckQueue, minimumRating: boolean): "stalled" | "reach_spent" | null {
  if (!stalled(queue)) return null;
  return minimumRating ? "reach_spent" : "stalled";
}

/** Lets a stalled queue ask again (the screen's retry). */
export function resumeQueue(queue: DeckQueue): DeckQueue {
  return { ...queue, emptyPages: 0 };
}

/**
 * Forgets the cursor but keeps the cards and what was dealt: the service
 * rejected the cursor (stale after a settings change), so the next page
 * starts the same deal again and dedupe drops what this queue already showed.
 */
export function restartCursor(queue: DeckQueue): DeckQueue {
  return { ...queue, cursor: null, exhausted: false, emptyPages: 0 };
}

/**
 * What to do when the service refuses a page. A stale cursor (an old cursor
 * version after a deploy, or a cursor from before a settings change) gets one
 * restart without the cursor: returns the queue to retry with. Anything else,
 * or a second refusal in the same run, returns null: show the error.
 */
export function afterRefusal(queue: DeckQueue, error: string, alreadyRestarted: boolean): DeckQueue | null {
  if (error !== "invalid_deck_query" || queue.cursor === null || alreadyRestarted) return null;
  return restartCursor(queue);
}

/**
 * The user's country or services changed, so every queued card shows stale
 * streaming data, or the mode or filters changed, so they are the wrong cards
 * (see deckInputChange). Drops the queued cards and asks for a first page
 * again. The dropped titles are forgotten, so they can be dealt again. Sorted
 * titles stay in dealt, so a sort still saving can't come back.
 *
 * `newDeal` says which deck comes next. False (a settings change) keeps the
 * queue's shuffle seed, so the same deal comes back with fresh data and the
 * card on screen returns on top if the first page has it. True (a new mode or
 * filters) drops the seed, so the next deck is a fresh deal.
 */
export function refreshQueue(queue: DeckQueue, newDeal: boolean): DeckQueue {
  const dealt = new Set(queue.dealt);
  for (const card of queue.cards) dealt.delete(titleKey(card));
  const top = queue.cards[0];
  return { cards: [], dealt, cursor: null, exhausted: false, emptyPages: 0, keepOnTop: top ? titleKey(top) : null, shuffleSeed: newDeal ? null : queue.shuffleSeed };
}

/**
 * The settings a deck's cards depend on (country and streaming services), as
 * one comparable string. When it changes, the queued cards are stale.
 */
export function deckSettingsKey(settings: { country: string; providerIds: readonly number[] }): string {
  const ids = [...new Set(settings.providerIds)].sort((a, b) => a - b);
  return `${settings.country.toUpperCase()}:${ids.join(",")}`;
}

/**
 * What a queue was dealt for: the settings key (deckSettingsKey) and the
 * Discover choice key (deckChoiceKey in core/filters: the mode and filters).
 */
export interface DeckInputs {
  settingsKey: string;
  choiceKey: string;
}

/** What a change to the deck's inputs means for the queue. */
export type DeckInputChange =
  | { refresh: false }
  /**
   * Refresh the queue (refreshQueue). dropUndo: the last sort's Undo would bring back a card with stale streaming data.
   * newDeal: the mode or filters changed, so the next deck is a fresh deal. A settings change alone keeps the deal.
   */
  | { refresh: true; dropUndo: boolean; newDeal: boolean };

/**
 * The staleness rule for the deck's inputs (dropTitles is the one for titles
 * sorted elsewhere). A new mode or new filters make the
 * queued cards the wrong ones, and new settings make their streaming data
 * stale: either way the queue refreshes (refreshQueue). A settings change
 * keeps the deal, so the card on screen stays on top when the first new page
 * deals it. A new mode or new filters start a fresh deal. Only a settings change
 * ends the last sort's Undo window. After a mode or filter change, Undo still
 * brings the card back, even if it no longer matches: the user asked for it.
 */
export function deckInputChange(prev: DeckInputs, next: DeckInputs): DeckInputChange {
  const settings = prev.settingsKey !== next.settingsKey;
  const choice = prev.choiceKey !== next.choiceKey;
  if (!settings && !choice) return { refresh: false };
  return { refresh: true, dropUndo: settings, newDeal: choice };
}

/**
 * The queued titles to check when Discover becomes active again, at most
 * `max` (the service's MAX_HIDDEN_CHECK), the card on screen first. Only the
 * identities: the check needs nothing else.
 */
export function queuedTitles(queue: DeckQueue, max: number): TitleId[] {
  return queue.cards.slice(0, max).map(toTitleId);
}

/**
 * The second staleness rule, beside deckInputChange: a queued title was
 * sorted somewhere else (Search, Lists, another device) while Discover was in
 * the background, so it must not be dealt (VISION invariant 3). The check
 * (the deck service's hiddenTitles) returns those titles, and this takes them
 * out of the queue, the card on screen included. They stay in dealt, so a
 * later page can't deal them again. `keep` names titles this screen is still
 * sorting or undoing: the check may have read a row that is about to change,
 * so they stay where they are. Returns the same queue when nothing changes,
 * so a check that finds nothing costs no re-render.
 */
export function dropTitles(queue: DeckQueue, keys: Iterable<string>, keep: Iterable<string> = []): DeckQueue {
  const drop = new Set(keys);
  for (const key of keep) drop.delete(key);
  if (drop.size === 0) return queue;
  const cards = queue.cards.filter((c) => !drop.has(titleKey(c)));
  const keepOnTop = queue.keepOnTop !== null && drop.has(queue.keepOnTop) ? null : queue.keepOnTop;
  if (cards.length === queue.cards.length && keepOnTop === queue.keepOnTop) return queue;
  const dealt = new Set(queue.dealt);
  for (const key of drop) dealt.add(key);
  return { ...queue, cards, dealt, keepOnTop };
}

/**
 * Starts a new deal (Check again) and forgets the
 * titles it dealt, except the queued cards and `keep` (sorts still saving),
 * so a skip that expired or a title moved in Lists can be dealt again.
 */
export function startAgain(queue: DeckQueue, keep: Iterable<string>): DeckQueue {
  const dealt = new Set(keep);
  for (const card of queue.cards) dealt.add(titleKey(card));
  return { ...restartCursor(queue), dealt, shuffleSeed: null };
}

/**
 * Forgets one dealt title that is not queued, so a later page may deal it
 * again with fresh data (its sort failed after the queue was refreshed).
 */
export function forgetTitle(queue: DeckQueue, ref: TitleId): DeckQueue {
  const key = titleKey(ref);
  if (!queue.dealt.has(key) || queue.cards.some((c) => titleKey(c) === key)) return queue;
  const dealt = new Set(queue.dealt);
  dealt.delete(key);
  return { ...queue, dealt };
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

/** A title's row as the deck's hiding rule reads it. skipUntil may be a string once it has crossed JSON. */
export interface UndoneRow {
  status: TitleStatus;
  skipUntil?: Date | string | null;
}

/**
 * Where an undone card goes, at the Undo tap, once the sort's outcome is
 * known (issue 54). An Undo puts the title back to its row before the sort:
 * `restored` (null when it had none). The card goes back on top only if the
 * deck may show that row now, by the deck's own hiding rule (rowVisible).
 * Otherwise it stays out (keepOutAfterUndo). That happens when the card was
 * stale: the title was put on a list elsewhere while it was on screen, then
 * sorted here and undone.
 */
export function afterUndo(queue: DeckQueue, card: DeckPageCard, restored: UndoneRow | null, now: Date): DeckQueue {
  return rowVisible(card, restored, now) ? returnToFront(queue, card) : keepOutAfterUndo(queue, card, restored, now);
}

/**
 * Takes an undone card out of the queue if the row the Undo restores keeps it
 * out of the deck: a title on a list never returns to the deck (VISION
 * invariant 3), and neither does one skipped until later. It stays in dealt,
 * so a later page can't deal it again. When the row is one the deck shows,
 * nothing changes, and the same queue comes back.
 *
 * It never puts a card back. When the Undo was tapped before the sort's save
 * settled, the card went back on top at the tap. Once the save settles, this
 * takes it out again if it must. Something may have taken the card out
 * meanwhile (a settings change refreshed the queue, so its streaming data is
 * stale), and that must stand.
 */
export function keepOutAfterUndo(queue: DeckQueue, card: DeckPageCard, restored: UndoneRow | null, now: Date): DeckQueue {
  if (rowVisible(card, restored, now)) return queue;
  const key = titleKey(card);
  const out = dropTitles(queue, [key]);
  return out.dealt.has(key) ? out : { ...out, dealt: new Set([...out.dealt, key]) };
}
