// The Lists rows kept on the phone for Back (issue 76), in their own module so a title card can write to them too
// (issues 93 and 110). Not a server module: it lives in the browser, for as long as the page does.

import type { FilterChoice } from "@/core/filters";
import type { TitleRecord } from "@/core/library/types";
import { applyTitleRecord, type ListRow } from "@/core/lists";
import { formatTitleKey } from "@/core/title-id";
import { LIST_STATUSES, type ListStatus, type TitleId } from "@/core/types";

export type ListState = { rows: ListRow[]; nextCursor: string | null };
export type Lists = Record<ListStatus, ListState>;

/** The rows on screen, the filters they were loaded under, and whose they are. */
export type Shown = { userId: string; filters: FilterChoice; lists: Lists };

/*
 * The rows the Lists screen shows live here, at module scope, not in the component (issue 76). Back from a card mounts
 * the screen again from the router's copy of the page, which holds the rows of its server render and none of this
 * screen's changes since: an edited rating, Seen it, + Watchlist, an Undo, a filter change. So the screen takes its
 * rows from the server only for a render it hasn't shown yet. For a render it has shown (a copy Back restored), it
 * takes the rows it showed last, here. A save that settles after the screen is gone still lands here, and so does
 * the reload a stale save asks for, so Back shows them. So does a title card's save (applyTitleChange). A reload of
 * the page starts the module over, from a fresh server render. The rows belong to one user: another user's render
 * starts them over, as in the deck's store.
 */
let shownNow: Shown | null = null;
/** The server renders of the page already shown, oldest first. Each fresh one replaces the rows above. */
const shownRenders = new Set<string>();
/**
 * How many render ids to keep. Back can restore only renders still in the browser's history, and a home-screen app
 * can stay open for days. A render forgotten here would show its server copy on Back, as before issue 76.
 */
const MAX_SHOWN_RENDERS = 50;

/**
 * Rows a card's change took off the kept lists (a Skip, or Remove rating), by title key, newest last. A card's Undo
 * brings the title back, and only the dropped row still holds its title and poster. A few are plenty: an Undo
 * follows its own change within seconds.
 */
const dropped = new Map<string, ListRow>();
const MAX_DROPPED = 20;

/** Whether this server render was shown already, so Back restoring it shows the rows kept here. */
export const wasShown = (renderId: string) => shownRenders.has(renderId);

/** Notes a fresh render as shown, and starts the rows over from it. */
export function seedShown(renderId: string, from: Shown) {
  if (shownNow && shownNow.userId !== from.userId) {
    shownRenders.clear();
    dropped.clear();
  }
  shownRenders.add(renderId);
  while (shownRenders.size > MAX_SHOWN_RENDERS) shownRenders.delete(shownRenders.values().next().value as string);
  setShown(from);
}
const shownListeners = new Set<() => void>();

export function subscribeShown(listener: () => void) {
  shownListeners.add(listener);
  return () => {
    shownListeners.delete(listener);
  };
}
export const getShown = () => shownNow;
// The server never holds a user's rows between requests: it renders from the page's props.
export const getServerShown = () => null;

export function setShown(next: Shown) {
  shownNow = next;
  for (const listener of shownListeners) listener();
}

/** Changes the rows on screen. The rows' filters stay. */
export function updateLists(change: (lists: Lists) => Lists) {
  if (shownNow) setShown({ ...shownNow, lists: change(shownNow.lists) });
}

/**
 * A title card saved a change (issues 93 and 110): `record` is the title's row as the server now holds it. Back to
 * Lists then shows the title where it is now at once, not the row from before the card, so an Edit tapped right after
 * Back opens on the rating and review the card saved. Core decides where the row goes (applyTitleRecord). False when
 * the kept rows neither show the title nor hold a row they dropped for it, so they couldn't take the change: the card
 * then refreshes Lists instead.
 */
export function applyTitleChange(ref: TitleId, record: TitleRecord | null): boolean {
  if (!shownNow) return false;
  const key = formatTitleKey(ref);
  const before = shownNow.lists;
  const lists = applyTitleRecord(before, ref, record, dropped.get(key));
  if (lists === before) return false;
  // A Skip or Remove rating drops the row. Keep it, so the card's Undo can put it back with its title and poster.
  const now = rowOf(lists, key);
  const was = rowOf(before, key);
  if (now) dropped.delete(key);
  else if (was) {
    dropped.delete(key);
    dropped.set(key, was);
    if (dropped.size > MAX_DROPPED) dropped.delete(dropped.keys().next().value as string);
  }
  setShown({ ...shownNow, lists });
  return true;
}

function rowOf(lists: Lists, key: string): ListRow | undefined {
  for (const status of LIST_STATUSES) {
    const row = lists[status].rows.find((r) => formatTitleKey(r) === key);
    if (row) return row;
  }
  return undefined;
}
