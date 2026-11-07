"use client";

// The Discover screen's client state: the card queue, the page fetches, the
// optimistic sorts, and the last sort's Undo. It lives at module scope, not in
// a component, so switching tabs and coming back shows the same card at once,
// with no refetch. It is scoped to one user: a different user id resets it.
//
// The paging rules (dedupe, when to ask for more, stale cursors) are core's
// (src/core/deck-queue). This file only sequences fetches and server actions
// and holds what the screen shows.

import { useSyncExternalStore } from "react";
import {
  addPage,
  emptyQueue,
  needsMore,
  removeCard,
  restartCursor,
  resumeQueue,
  returnToFront,
  stalled,
  titleKey,
  type DeckQueue,
} from "@/core/deck-queue";
import type { DeckPage, DeckPageCard } from "@/core/deck-service/types";
import type { TitleId } from "@/core/types";
import type { DeckResponse } from "@/app/api/deck/route";
import { markSeenAction, sortCardAction, undoSortAction, type DeckActionResult, type SortKind } from "./actions";

/** How long the Undo toast stays up. */
const TOAST_MS = 4500;
/** Posters to load ahead of the card on screen. */
const PRELOAD_AHEAD = 2;

const DONE_LABEL: Record<SortKind, string> = {
  pass: "Passed",
  skip: "Skipped for now",
  watchlist: "Added to Watchlist",
  seen: "Marked as seen",
};

export interface Toast {
  id: number;
  message: string;
  /** Set when the toast offers Undo for this sort. */
  undoable: boolean;
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
  queue: DeckQueue;
  fetching: boolean;
  /** The last page fetch failed. */
  failed: boolean;
  /** A non-card page ("for you" needs ratings first). */
  gate: Extract<DeckPage, { kind: "locked" | "no_seeds" }> | null;
  toast: Toast | null;
  /** An undo is on its way to the server. The buttons wait, so a new sort can't race it. */
  undoing: boolean;
}

function initialState(userId: string | null): DeckState {
  return { userId, queue: emptyQueue(), fetching: false, failed: false, gate: null, toast: null, undoing: false };
}

let state: DeckState = initialState(null);
/** Bumped on every reset, so a fetch started before it is ignored. */
let generation = 0;
let lastSort: LastSort | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;
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

/** Called on mount: binds the store to the signed-in user and starts filling it. */
export function startDeck(userId: string) {
  if (state.userId !== userId) reset(userId);
  void fill();
}

function reset(userId: string | null) {
  generation++;
  lastSort = null;
  clearTimeout(toastTimer);
  preloaded.clear();
  state = initialState(userId);
  for (const l of listeners) l();
}

/** The deck ran out: start over from the first page. */
export function startOver() {
  reset(state.userId);
  void fill();
}

/** Retry after a failed fetch, or after too many empty pages. */
export function retry() {
  set({ failed: false, queue: resumeQueue(state.queue) });
  void fill();
}

async function fetchPage(cursor: string | null): Promise<DeckResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  try {
    const res = await fetch(`/api/deck${params.size ? `?${params}` : ""}`, { cache: "no-store" });
    return (await res.json()) as DeckResponse;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/** Fetches pages until the queue has enough cards, the deck ends, or a fetch fails. */
async function fill() {
  if (state.fetching || !state.userId) return;
  const gen = generation;
  let restarted = false;
  set({ fetching: true });
  try {
    while (gen === generation && !state.gate && needsMore(state.queue)) {
      const body = await fetchPage(state.queue.cursor);
      if (gen !== generation) return;
      if (!body.ok) {
        // The session ended while the app stayed open: reload, so the shell shows the sign-in screen.
        if (body.error === "signed_out") {
          window.location.reload();
          return;
        }
        // A stale cursor (the user changed settings): start again once, without it.
        if (body.error === "invalid_deck_query" && state.queue.cursor !== null && !restarted) {
          restarted = true;
          set({ queue: restartCursor(state.queue) });
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
  } finally {
    if (gen === generation) set({ fetching: false });
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

function showToast(message: string, undoable: boolean): number {
  clearTimeout(toastTimer);
  const id = ++nextId;
  set({ toast: { id, message, undoable } });
  toastTimer = setTimeout(() => dismissToast(id), TOAST_MS);
  return id;
}

export function dismissToast(id: number) {
  if (state.toast?.id !== id) return;
  if (lastSort?.id === id) lastSort = null;
  set({ toast: null });
}

/**
 * Sorts the card on screen. The next card shows at once and the write runs
 * behind it. If the write fails, the card comes back on top with a message.
 */
export function sortCard(kind: SortKind, card: DeckPageCard, seen?: { rating: number; review: string | null }) {
  const gen = generation;
  set({ queue: removeCard(state.queue, card) });
  preload();

  const ref = refOf(card);
  const write = kind === "seen" ? markSeenAction(ref, seen!.rating, seen!.review) : sortCardAction(kind, ref);
  const pending = write
    .catch((): DeckActionResult => ({ ok: false, error: "Couldn't save. Check your connection." }))
    .then((result) => {
      if (!result.ok && gen === generation) {
        if (lastSort?.card === card) lastSort = null;
        set({ queue: returnToFront(state.queue, card) });
        showToast(result.error, false);
      }
      return result;
    });

  const id = showToast(DONE_LABEL[kind], true);
  lastSort = { id, card, pending };
  void fill();
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
  showToast(undone.error, false);
}

/** Only the title's identity goes to the server, not the whole card. */
function refOf(card: DeckPageCard): TitleId {
  return { mediaType: card.mediaType, tmdbId: card.tmdbId };
}

/** For keys and comparisons in components. */
export { titleKey };
