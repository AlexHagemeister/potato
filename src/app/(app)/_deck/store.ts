"use client";

// The Discover screen's client state: the card queue, the page fetches, the
// optimistic sorts, and the last sort's Undo. It lives at module scope, not in
// a component, so switching tabs and coming back shows the same card at once,
// with no refetch. It is scoped to one user: a different user id resets it.
// A change to the user's country or services (the settings key) refreshes the
// queued cards, since their streaming data is stale. So does a change to the
// mode or filters (the choice), since they are the wrong cards. Core's
// deckInputChange is the one rule for both. The choice is saved on this
// device (localStorage), so it survives a reload and a relaunch.
//
// The paging rules (dedupe, when to ask for more, stale cursors, refresh) are
// core's (src/core/deck-queue). This file only sequences fetches and server
// actions and holds what the screen shows.

import { useSyncExternalStore } from "react";
import {
  addPage,
  afterRefusal,
  deckInputChange,
  emptyQueue,
  forgetTitle,
  needsMore,
  refreshQueue,
  removeCard,
  restartCursor,
  resumeQueue,
  returnToFront,
  stalled,
  startAgain,
  titleKey,
  type DeckQueue,
} from "@/core/deck-queue";
import type { DeckPage, DeckPageCard } from "@/core/deck-service/types";
import {
  DEFAULT_DECK_CHOICE,
  deckChoiceKey,
  deckChoiceToParams,
  normalizeDeckChoice,
  type DeckChoice,
} from "@/core/filters";
import type { TitleId } from "@/core/types";
import type { DeckResponse } from "@/app/api/deck/route";
import { markSeenAction, sortCardAction, undoSortAction, type DeckActionResult, type SortKind } from "./actions";

/** How long the Undo toast stays up. An error notice stays until dismissed or the next sort. */
const TOAST_MS = 4500;
/** Posters to load ahead of the card on screen. */
const PRELOAD_AHEAD = 2;

const DONE_LABEL: Record<SortKind, string> = {
  pass: "Passed",
  skip: "Skipped for now",
  watchlist: "Added to Watchlist",
  seen: "Marked as seen",
};

/** The last sort's confirmation, with its Undo. */
export interface Toast {
  id: number;
  message: string;
}

/** An error message. It shows beside the Undo toast, never in place of it. */
export interface Notice {
  id: number;
  message: string;
}

interface LastSort {
  id: number;
  card: DeckPageCard;
  pending: Promise<DeckActionResult>;
}

export type DeckView =
  | { kind: "card"; card: DeckPageCard }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "stalled" }
  | { kind: "done" }
  | { kind: "locked"; remaining: number }
  | { kind: "no_seeds" };

export interface DeckState {
  userId: string | null;
  /** The user's country and services the queued cards were fetched for. */
  settingsKey: string | null;
  /** The mode and filters the queued cards were fetched for. */
  choice: DeckChoice;
  queue: DeckQueue;
  fetching: boolean;
  /** The last page fetch failed. */
  failed: boolean;
  /** A non-card page ("for you" needs ratings first). */
  gate: Extract<DeckPage, { kind: "locked" | "no_seeds" }> | null;
  toast: Toast | null;
  notice: Notice | null;
  /** An undo is on its way to the server. The buttons wait, so a new sort can't race it. */
  undoing: boolean;
}

function initialState(userId: string | null, settingsKey: string | null, choice: DeckChoice = DEFAULT_DECK_CHOICE): DeckState {
  return {
    userId,
    settingsKey,
    choice,
    queue: emptyQueue(),
    fetching: false,
    failed: false,
    gate: null,
    toast: null,
    notice: null,
    undoing: false,
  };
}

let state: DeckState = initialState(null, null);
/** Bumped when the user changes, so a save that finishes later can't touch the next user's deck. */
let generation = 0;
/** Bumped whenever the queue restarts, so a page fetched for the old queue is thrown away. */
let fetchEpoch = 0;
/** A fetch loop is running. */
let filling = false;
let lastSort: LastSort | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;
/** Titles whose sort is still saving, by key. Check again keeps them out of the new deck. */
const saving = new Set<string>();
const preloaded = new Set<string>();
const listeners = new Set<() => void>();

function set(patch: Partial<DeckState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What the screen shows now. */
export function viewOf(s: DeckState): DeckView {
  const card = s.queue.cards[0];
  if (card) return { kind: "card", card };
  if (s.gate?.kind === "locked") return { kind: "locked", remaining: s.gate.remaining };
  if (s.gate?.kind === "no_seeds") return { kind: "no_seeds" };
  if (s.fetching) return { kind: "loading" };
  if (s.failed) return { kind: "error" };
  if (stalled(s.queue)) return { kind: "stalled" };
  if (s.queue.exhausted) return { kind: "done" };
  return { kind: "loading" };
}

export function useDeck(): DeckState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/**
 * Called each time Discover mounts (the app opens, or the user taps back to
 * the tab). Binds the store to the signed-in user, refreshes the queued cards
 * if the country or services changed, re-checks a locked or no_seeds deck
 * (ratings made elsewhere may unlock it), and fills the queue.
 */
export function startDeck(userId: string, settingsKey: string) {
  if (state.userId !== userId) {
    reset(userId, settingsKey);
  } else if (!rebase(settingsKey, state.choice) && state.gate) {
    fetchEpoch++;
    set({ gate: null, queue: restartCursor(state.queue) });
  }
  // Coming back to the tab is also a retry after a failed fetch.
  void fill();
}

/**
 * A new mode or new filters from the Discover controls. The queue refreshes
 * (a locked "for you" is left for the new mode), and the choice is saved on
 * this device.
 */
export function chooseDeck(next: DeckChoice) {
  if (!state.userId || state.settingsKey === null) return;
  const choice = normalizeDeckChoice(next);
  saveChoice(state.userId, choice);
  if (rebase(state.settingsKey, choice)) void fill();
}

/**
 * Applies new settings or a new choice through core's one staleness rule
 * (deckInputChange). Returns true when the queue refreshed.
 */
function rebase(settingsKey: string, choice: DeckChoice): boolean {
  const change = deckInputChange(
    { settingsKey: state.settingsKey ?? "", choiceKey: deckChoiceKey(state.choice) },
    { settingsKey, choiceKey: deckChoiceKey(choice) },
  );
  if (!change.refresh) return false;
  if (change.dropUndo) dropUndo();
  fetchEpoch++;
  set({ settingsKey, choice, queue: refreshQueue(state.queue), gate: null, failed: false });
  return true;
}

function reset(userId: string, settingsKey: string) {
  generation++;
  fetchEpoch++;
  lastSort = null;
  clearTimeout(toastTimer);
  saving.clear();
  preloaded.clear();
  state = { ...initialState(userId, settingsKey, loadChoice(userId)), fetching: filling };
  for (const l of listeners) l();
}

/** Where this device keeps a user's Discover choice. */
const choiceStorageKey = (userId: string) => `potato:deck-choice:${userId}`;

function loadChoice(userId: string): DeckChoice {
  try {
    const saved = window.localStorage.getItem(choiceStorageKey(userId));
    return saved ? normalizeDeckChoice(JSON.parse(saved)) : DEFAULT_DECK_CHOICE;
  } catch {
    // Storage blocked (private mode) or a corrupt value: start from the default.
    return DEFAULT_DECK_CHOICE;
  }
}

function saveChoice(userId: string, choice: DeckChoice) {
  try {
    window.localStorage.setItem(choiceStorageKey(userId), JSON.stringify(choice));
  } catch {
    // Storage blocked: the choice still holds until the app reloads.
  }
}

/**
 * The deck ran out: ask again from the first page. Saves still in flight keep
 * their handlers and stay out of the new deck, so a sort that hasn't landed
 * can't be dealt again. Other titles dealt earlier may come back (a skip that
 * expired, a title moved in Lists); the service already leaves out the rest.
 */
export function startOver() {
  fetchEpoch++;
  set({ failed: false, queue: startAgain(state.queue, saving) });
  void fill();
}

/** Retry after a failed fetch, or after too many empty pages. */
export function retry() {
  set({ failed: false, queue: resumeQueue(state.queue) });
  void fill();
}

async function fetchPage(cursor: string | null, choice: DeckChoice): Promise<DeckResponse> {
  const params = new URLSearchParams(deckChoiceToParams(choice));
  if (cursor) params.set("cursor", cursor);
  try {
    const res = await fetch(`/api/deck${params.size ? `?${params}` : ""}`, { cache: "no-store" });
    return (await res.json()) as DeckResponse;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/**
 * Fetches pages until the queue has enough cards, the deck ends, or a fetch
 * fails. One loop at a time: if the queue restarts while a page is on its way
 * (a refresh, a new user), that page is thrown away and the loop asks again.
 */
async function fill() {
  if (filling || !state.userId) return;
  filling = true;
  let restarted = false;
  set({ fetching: true });
  try {
    // A failed fetch doesn't stop later fills: the next sort or tab visit tries again.
    while (state.userId && !state.gate && needsMore(state.queue)) {
      const epoch = fetchEpoch;
      const body = await fetchPage(state.queue.cursor, state.choice);
      if (epoch !== fetchEpoch) {
        restarted = false;
        continue;
      }
      if (!body.ok) {
        // The session ended while the app stayed open: reload, so the shell shows the sign-in screen.
        if (body.error === "signed_out") {
          window.location.reload();
          return;
        }
        // A stale cursor (an old cursor version, or settings changed): start again once, without it.
        const next = afterRefusal(state.queue, body.error, restarted);
        if (next) {
          restarted = true;
          set({ queue: next });
          continue;
        }
        set({ failed: true });
        return;
      }
      if (body.page.kind !== "cards") {
        set({ gate: body.page, failed: false });
        return;
      }
      set({ queue: addPage(state.queue, body.page), failed: false });
      preload();
    }
  } catch (err) {
    // An unexpected throw (a malformed card, say) shows the error with Try again, not an endless skeleton.
    console.error("deck: fill failed:", err);
    set({ failed: true });
  } finally {
    filling = false;
    set({ fetching: false });
  }
}

/** Starts loading the next posters, so the next card shows with its image. */
function preload() {
  for (const card of state.queue.cards.slice(0, PRELOAD_AHEAD + 1)) {
    if (!card.posterUrl || preloaded.has(card.posterUrl)) continue;
    preloaded.add(card.posterUrl);
    const img = new Image();
    img.decoding = "async";
    img.src = card.posterUrl;
  }
}

function showToast(message: string): number {
  clearTimeout(toastTimer);
  const id = ++nextId;
  set({ toast: { id, message } });
  toastTimer = setTimeout(() => dismissToast(id), TOAST_MS);
  return id;
}

export function dismissToast(id: number) {
  if (state.toast?.id !== id) return;
  if (lastSort?.id === id) lastSort = null;
  set({ toast: null });
}

/** Ends the last sort's Undo window. */
function dropUndo() {
  lastSort = null;
  clearTimeout(toastTimer);
  if (state.toast) set({ toast: null });
}

/** An error stays up until dismissed or the next sort, so a sheet on top can't hide it until it expires. */
function showNotice(message: string) {
  set({ notice: { id: ++nextId, message } });
}

export function dismissNotice(id: number) {
  if (state.notice?.id === id) set({ notice: null });
}

/** A sort was made: the previous error is old news. Its toast offers Undo. */
function sorted(kind: SortKind, card: DeckPageCard, pending: Promise<DeckActionResult>) {
  if (state.notice) set({ notice: null });
  const id = showToast(DONE_LABEL[kind]);
  lastSort = { id, card, pending };
  void fill();
}

/**
 * Pass, Skip, or Watchlist. The next card shows at once and the write runs
 * behind it. If the write fails, the card comes back on top with an error
 * notice. If the settings changed meanwhile, the card's streaming data is
 * stale, so the deck deals it again later with fresh data instead.
 */
export function sortCard(kind: Exclude<SortKind, "seen">, card: DeckPageCard) {
  const gen = generation;
  const settingsKey = state.settingsKey;
  const key = titleKey(card);
  saving.add(key);
  set({ queue: removeCard(state.queue, card) });
  preload();

  const pending = sortCardAction(kind, refOf(card))
    .catch((): DeckActionResult => ({ ok: false, error: "Couldn't save. Check your connection." }))
    .then((result) => {
      if (gen !== generation) return result;
      saving.delete(key);
      if (!result.ok) {
        // Only this sort's own Undo goes away. A newer sort keeps its toast.
        if (lastSort?.card === card) dropUndo();
        if (state.settingsKey === settingsKey) {
          set({ queue: returnToFront(state.queue, card) });
          showNotice(result.error);
        } else {
          set({ queue: forgetTitle(state.queue, card) });
          showNotice(`${result.error.replace(/\.$/, "")}: ${card.title}.`);
          void fill();
        }
      }
      return result;
    });

  sorted(kind, card, pending);
}

/**
 * Seen it, from its sheet. Unlike the other buttons this waits for the save,
 * so the sheet can keep what the user entered and show the error if it
 * fails. Resolves to that error, or null once saved (the card has left).
 */
export async function markCardSeen(card: DeckPageCard, rating: number, review: string | null): Promise<string | null> {
  const gen = generation;
  let result: DeckActionResult;
  try {
    result = await markSeenAction(refOf(card), rating, review);
  } catch {
    result = { ok: false, error: "Couldn't save. Check your connection." };
  }
  if (!result.ok) return result.error;
  if (gen !== generation) return null;
  set({ queue: removeCard(state.queue, card) });
  preload();
  sorted("seen", card, Promise.resolve(result));
  return null;
}

/** Undoes the last sort: the card comes back on top at once, and core restores its previous state. */
export async function undoLastSort() {
  const sort = lastSort;
  if (!sort) return;
  const gen = generation;
  lastSort = null;
  clearTimeout(toastTimer);
  set({ toast: null, undoing: true, queue: returnToFront(state.queue, sort.card) });

  let undone: DeckActionResult;
  try {
    const done = await sort.pending;
    // A failed sort already put the card back and said so.
    if (!done.ok) return;
    undone = await undoSortAction(refOf(sort.card), done.outcome);
  } catch {
    undone = { ok: false, error: "Couldn't undo. Check your connection." };
  } finally {
    if (gen === generation) set({ undoing: false });
  }
  if (gen !== generation || undone.ok) return;
  // The sort stands, so the card leaves the deck again.
  set({ queue: removeCard(state.queue, sort.card) });
  showNotice(undone.error);
}

/** Only the title's identity goes to the server, not the whole card. */
function refOf(card: DeckPageCard): TitleId {
  return { mediaType: card.mediaType, tmdbId: card.tmdbId };
}

/** For keys and comparisons in components. */
export { titleKey };
