// The Lists rows kept on the phone for Back (issue 76), in their own module so a title card can write to them too
// (issues 93 and 110). Not a server module: it lives in the browser, for as long as the page does.

import { sameFilterChoice, type FilterChoice } from "@/core/filters";
import type { ActionOutcome, TitleRecord } from "@/core/library/types";
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
 *
 * Each row keeps the filters it showed under, and comes back only while the kept rows have those filters (issue 121).
 * A row holds no genres, rating, or services, so nothing on the phone can tell whether it fits other filters. Under
 * other filters the change counts as one the kept rows couldn't take, and Lists reads the server instead.
 */
const dropped = new Map<string, { row: ListRow; filters: FilterChoice }>();
const MAX_DROPPED = 20;

/**
 * A title card's change the kept rows couldn't take settled while another screen showed, one that wasn't Lists
 * (a title screen opened from the first one's "You might also like" row, PR 135). Lists reloads from the server when
 * it next mounts, and a reload that lands clears it. Cleared only then, so a load that is dropped (the screen started
 * over meanwhile) leaves it for the next mount.
 */
let staleSinceShown = false;
export function markListsStale() {
  // With no rows kept, Lists has nothing stale to show: its next visit renders fresh from the server.
  if (shownNow) staleSinceShown = true;
}
export const listsStale = () => staleSinceShown;
export function clearListsStale() {
  staleSinceShown = false;
}

/** Whether this server render was shown already, so Back restoring it shows the rows kept here. */
export const wasShown = (renderId: string) => shownRenders.has(renderId);

/**
 * Notes a fresh render as shown, and starts the rows over from it, with the Lists saves it may be older than
 * (withSaves).
 */
export function seedShown(renderId: string, from: Shown) {
  if (shownNow && shownNow.userId !== from.userId) {
    shownRenders.clear();
    dropped.clear();
  }
  shownRenders.add(renderId);
  while (shownRenders.size > MAX_SHOWN_RENDERS) shownRenders.delete(shownRenders.values().next().value as string);
  forgetSaves(from);
  setShown({ ...from, lists: withSaves(from.userId, from.lists) });
}

/*
 * The Lists screen's own saves (issues 137 and 98). A fresh server render of Lists (the Lists tab, a refresh, Back
 * after a card's refresh) can have read the lists before one of them reached the server, or before it answered. Its
 * rows would then show the title where it was before the save, until a reload, while the server holds the save. So
 * the rows of a fresh render take the saves it may be older than:
 *
 * - A save still under way: the change the screen shows before it answers (only + Watchlist moves at once).
 * - A save that answered: its outcome, but only while the render shows the title exactly as the save found it
 *   (`previous`). That is proof the render read before the save. A render that shows the title any other way read
 *   after it, or the title has changed since, and keeps its own row. An answered save is kept only for
 *   SAVE_REPLAY_MS: a render read before it arrives well within that.
 *
 * Saves replay in the order they answered, which is the order the server took them, so a move and its Undo come back
 * as the Undo left them.
 */
type Save = {
  userId: string;
  ref: TitleId;
  /** While under way: how the screen shows it before the save answers. */
  show?: (lists: Lists) => Lists;
  /** Once answered: what the save did, and when it answered (Date.now()). */
  done?: { outcome: ActionOutcome; at: number };
};
/** Under way, in the order they started. */
const savesUnderWay: Save[] = [];
/** Answered, in the order they answered. */
const savesAnswered: Save[] = [];
/** How long an answered save can still be replayed over a fresh render. */
export const SAVE_REPLAY_MS = 60_000;
const MAX_SAVES_ANSWERED = 50;
/** Every Lists save started, from any mount, so a reload can tell one started during its read (lists-screen). */
let savesStarted = 0;
export const savesStartedCount = () => savesStarted;

/** A Lists save is starting. `show`, if given, is how the screen shows it before it answers. */
export function startSave(userId: string, ref: TitleId, show?: (lists: Lists) => Lists): Save {
  savesStarted++;
  const save: Save = { userId, ref, show };
  savesUnderWay.push(save);
  return save;
}

/** The save answered: with what it did, or null when it failed (nothing changed on the server). */
export function finishSave(save: Save, outcome: ActionOutcome | null) {
  const i = savesUnderWay.indexOf(save);
  if (i !== -1) savesUnderWay.splice(i, 1);
  if (!outcome) return;
  save.done = { outcome, at: Date.now() };
  savesAnswered.push(save);
  if (savesAnswered.length > MAX_SAVES_ANSWERED) savesAnswered.shift();
}

/**
 * Drops answered saves too old to replay, and another user's. A save a render read after stays: replaying the saves
 * in order over such a render ends where the server is, and dropping one alone could break that chain (a move kept
 * and its Undo dropped would replay the move).
 */
function forgetSaves(from: Shown) {
  const now = Date.now();
  for (let i = savesAnswered.length - 1; i >= 0; i--) {
    const { userId, done } = savesAnswered[i];
    if (userId !== from.userId || now - done!.at > SAVE_REPLAY_MS) savesAnswered.splice(i, 1);
  }
  for (let i = savesUnderWay.length - 1; i >= 0; i--) if (savesUnderWay[i].userId !== from.userId) savesUnderWay.splice(i, 1);
}

/**
 * A fresh render's rows, with the Lists saves it may be older than. The screen shows this for a render before it
 * seeds the rows, so the first paint is already right.
 */
export function withSaves(userId: string, lists: Lists): Lists {
  const now = Date.now();
  let out = lists;
  for (const { userId: owner, ref, done } of savesAnswered) {
    if (owner !== userId || now - done!.at > SAVE_REPLAY_MS) continue;
    const row = rowOf(out, formatTitleKey(ref));
    if (row && sameRow(row, done!.outcome.previous)) out = applyTitleRecord(out, ref, done!.outcome.current, row);
  }
  for (const { userId: owner, show } of savesUnderWay) if (owner === userId && show) out = show(out);
  return out;
}

/** Whether the row shows the title exactly as `record` has it. */
function sameRow(row: ListRow, record: TitleRecord | null): boolean {
  return (
    record !== null &&
    row.status === record.status &&
    row.rating === record.rating &&
    (row.review ?? null) === (record.review ?? null) &&
    new Date(row.updatedAt).getTime() === new Date(record.updatedAt).getTime()
  );
}

/*
 * The Lists screen on screen now, if any, by its reload (issue 98). A reload asked for by a screen already left (a
 * save that came back stale after Back) goes to the screen up now instead: that screen knows its Show more pages and
 * its own saves, which the left one's read would overwrite.
 */
let liveReload: (() => void) | null = null;
/** Registers the reload of the Lists screen now on screen. Returns its unregister. */
export function setLiveReload(reload: () => void) {
  liveReload = reload;
  return () => {
    if (liveReload === reload) liveReload = null;
  };
}
export const getLiveReload = () => liveReload;
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
 * the kept rows neither show the title nor hold a row they dropped for it under the filters they have now, so they
 * couldn't take the change: the card then refreshes Lists instead.
 */
export function applyTitleChange(ref: TitleId, record: TitleRecord | null): boolean {
  if (!shownNow) return false;
  const key = formatTitleKey(ref);
  const before = shownNow.lists;
  const known = dropped.get(key);
  const fits = known !== undefined && sameFilterChoice(known.filters, shownNow.filters);
  const lists = applyTitleRecord(before, ref, record, fits ? known.row : null);
  if (lists === before) return false;
  // A Skip or Remove rating drops the row. Keep it, so the card's Undo can put it back with its title and poster.
  const now = rowOf(lists, key);
  const was = rowOf(before, key);
  if (now) dropped.delete(key);
  else if (was) {
    dropped.delete(key);
    dropped.set(key, { row: was, filters: shownNow.filters });
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
