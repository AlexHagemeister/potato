// First-run onboarding (issue 139): the rules, with no browser or framework code. The deck opens as usual
// (VISION invariant 8). On the first cards, a hint points at each of the four buttons in turn. After the first few
// sorts, one sheet asks for the country and streaming services. Then the home-screen prompt (issue 138) gets its
// turn. Only a new account sees any of it.
//
// "New" is decided from what the server already knows (isNewAccount), with no schema change. Progress lives on
// the device, keyed by user, so a reload carries on where the person was and an existing user on a shared device
// never inherits someone else's. Once finished, a mark on the device keeps it from coming back.

import { INSTALL_SEEN_KEY, readSeenMark, writeSeenMark, type SeenStorage } from "../install/guide";

/** The four card buttons, in their order on screen (VISION: The deck). */
export type HintButton = "pass" | "skip" | "watchlist" | "seen";

export interface Hint {
  button: HintButton;
  /** The button's name, as the button shows it. */
  label: string;
  text: string;
}

/**
 * One hint per button, left to right, matching the buttons on screen. Skip is the least obvious, so its hint says
 * the card goes on no list and comes back later. How much later is an open tension in VISION, so no length is named.
 */
export const HINTS: readonly Hint[] = [
  { button: "pass", label: "Pass", text: "Not for you. It goes to Passed and won't come back." },
  { button: "skip", label: "Skip", text: "Not ready to decide? It goes on no list and comes back to the deck later." },
  { button: "watchlist", label: "Watchlist", text: "You want to watch it. It goes on your Watchlist." },
  { button: "seen", label: "Seen it", text: "You've watched it. Rate it, and it goes on your Seen list." },
];

/** Sorts made during onboarding before the services sheet may open. */
export const SORTS_BEFORE_SHEET = 3;

/** The country a settings row starts with (the user_settings default). */
export const DEFAULT_COUNTRY = "US";

export interface AccountFacts {
  /** How many title rows the user has, in any status (skipped included). */
  titleRows: number;
  country: string;
  providerIds: readonly number[];
}

/**
 * A new account: no title rows at all, and settings never changed from the defaults (no streaming services, the
 * default country). Anyone who has sorted a single card, or saved their services, is not new.
 */
export function isNewAccount({ titleRows, country, providerIds }: AccountFacts): boolean {
  return titleRows === 0 && providerIds.length === 0 && country === DEFAULT_COUNTRY;
}

/**
 * Where the person is. `hint` is the index into HINTS of the hint on screen, and HINTS.length once the hints are
 * over. `sorts` counts the sorts that stood since onboarding began: not undone, and not failed.
 */
export interface Progress {
  stage: "hints" | "sheet";
  hint: number;
  sorts: number;
}

export const FIRST_PROGRESS: Progress = { stage: "hints", hint: 0, sorts: 0 };

/** The hint to show, or null when the hints are over. */
export function currentHint(progress: Progress): Hint | null {
  if (progress.stage !== "hints") return null;
  return HINTS[progress.hint] ?? null;
}

export type OnboardingEvent =
  /**
   * A card was sorted, with any button. The hint on screen has been used: the person has tried a button, even if
   * they then undo the sort.
   */
  | { kind: "tapped" }
  /** A sort stood: its Undo window ended with no Undo, and its save didn't fail. Only these count toward the sheet. */
  | { kind: "settled" }
  /** The hint's "Got it". */
  | { kind: "next" }
  /** "Hide tips": the rest of the hints go too. */
  | { kind: "hide_hints" };

/**
 * The next progress. A sort or a "Got it" moves on to the next hint. Once the hints are over and enough sorts have
 * stood, the stage moves to the sheet. Pure, so the same events always give the same progress, and an event that
 * changes nothing returns the same object.
 */
export function advance(progress: Progress, event: OnboardingEvent): Progress {
  if (progress.stage !== "hints") return progress;
  let next: Progress;
  switch (event.kind) {
    case "tapped":
    case "next":
      if (progress.hint >= HINTS.length) return progress;
      next = { ...progress, hint: progress.hint + 1 };
      break;
    case "settled":
      next = { ...progress, sorts: progress.sorts + 1 };
      break;
    case "hide_hints":
      if (progress.hint >= HINTS.length) return progress;
      next = { ...progress, hint: HINTS.length };
      break;
  }
  if (next.hint >= HINTS.length && next.sorts >= SORTS_BEFORE_SHEET) next = { ...next, stage: "sheet" };
  return next;
}

// ---- Telling a sort that stood from one undone or failed ----
// The deck shows a new Undo toast for every sort, and only for sorts. The toast ends one of four ways: an Undo
// (the deck clears it and starts the undo in one step), a failed save (cleared, with an error notice), a newer
// sort (replaced), or its timer. Only the last two leave the sort standing.

/** What the deck shows, for telling sorts apart. Ids are the deck's own, null when nothing shows. */
export interface SortSignals {
  toastId: number | null;
  noticeId: number | null;
  undoing: boolean;
}

export interface SortTracker {
  last: SortSignals;
  /** The toast of the sort whose fate isn't known yet. */
  pending: number | null;
}

/** Starts from what the deck shows on mount. A toast already up then is an older sort's, so it isn't counted. */
export function startSortTracker(now: SortSignals): SortTracker {
  return { last: now, pending: null };
}

/** The tracker's next state, and the events the change means, in order. */
export function trackSorts(tracker: SortTracker, now: SortSignals): { tracker: SortTracker; events: OnboardingEvent[] } {
  const { last, pending } = tracker;
  const events: OnboardingEvent[] = [];
  let nextPending = pending;
  if (now.toastId !== null && now.toastId !== last.toastId) {
    // A new sort. One still pending was replaced by it, with no Undo, so it stood.
    if (pending !== null) events.push({ kind: "settled" });
    events.push({ kind: "tapped" });
    nextPending = now.toastId;
  } else if (now.toastId === null && last.toastId !== null && pending === last.toastId) {
    const failed = now.noticeId !== null && now.noticeId !== last.noticeId;
    if (!now.undoing && !failed) events.push({ kind: "settled" });
    nextPending = null;
  }
  return { tracker: { last: now, pending: nextPending }, events };
}

/**
 * Whether the services sheet still has anything to ask, from settings read fresh as it opens. Someone who saved
 * their services elsewhere meanwhile (Profile, another device) has nothing left to answer, so onboarding finishes
 * without showing the sheet.
 */
export function sheetStillNeeded(settings: { providerIds: readonly number[] }): boolean {
  return settings.providerIds.length === 0;
}

/**
 * Whether the page on screen starts over once a save made in the sheet is in. It does when the person left the
 * deck while that save was still on its way and is still off the deck: the page they reached may have read the
 * settings before the save landed, and a settings form takes its starting values once, so it would save its old
 * selection over the sheet's. On the deck nothing reads the settings that way.
 */
export function remountAfterSheetSave(facts: { leftDeckWhileSaving: boolean; onDeck: boolean }): boolean {
  return facts.leftDeckWhileSaving && !facts.onDeck;
}

// ---- Quiet moments ----
// The services sheet and, after it, the home-screen prompt each cover the whole screen. Each waits for a moment
// when it would cover nothing the person is using, by the same rule.

/** What is on screen, as the shell reads it. */
export interface ScreenFacts {
  /** The Discover tab is showing. */
  onDeck: boolean;
  /** The page is in the foreground. */
  visible: boolean;
  /** The Undo toast is up, so Undo must stay reachable. */
  toast: boolean;
  /** An Undo is on its way to the server. */
  undoing: boolean;
  /** The deck's error notice is up. It stays until dismissed, so nothing may hide it. */
  notice: boolean;
  /** Another sheet or a menu is open, something is fullscreen, or the card's trailer is playing. */
  overlay: boolean;
}

/** True when a full-screen sheet would cover nothing the person is using. */
export function isQuiet(f: ScreenFacts): boolean {
  return f.onDeck && f.visible && !f.toast && !f.undoing && !f.notice && !f.overlay;
}

/**
 * How long the screen must stay quiet before the services sheet opens. Long enough that a card just brought back
 * by an Undo, or just shown after a sort, gets a look before the sheet covers it.
 */
export const QUIET_MS_BEFORE_SHEET = 1500;

/** How long the screen must stay quiet, after the services sheet closes, before the home-screen prompt opens. */
export const QUIET_MS_BEFORE_INSTALL = 700;

/** When the current quiet stretch began: kept while quiet, started now when quiet begins, null when not quiet. */
export function nextQuietSince(since: number | null, quiet: boolean, now: number): number | null {
  if (!quiet) return null;
  return since ?? now;
}

/** The screen has been quiet for at least `ms`. */
export function quietFor(since: number | null, now: number, ms: number): boolean {
  return since !== null && now - since >= ms;
}

/** What the device holds for this user. `done` is null when storage can't be read, or won't keep a write. */
export interface DeviceRecord {
  done: boolean | null;
  progress: Progress | null;
}

/**
 * Whether onboarding runs on this load, and from where. Null means it doesn't. Never when the device can't keep
 * a mark (it would start over on every load), never once finished, and otherwise only for a new account. Progress
 * already on the device carries on even though the account is no longer new: the sorts made during the hints gave
 * it rows.
 */
export function startingProgress({ isNew, device }: { isNew: boolean; device: DeviceRecord }): Progress | null {
  if (device.done !== false) return null;
  if (device.progress) return device.progress;
  return isNew ? FIRST_PROGRESS : null;
}

// ---- The device's record ----
// The same storage helpers as the home-screen prompt (PR 141), with the same handling of storage that reads but
// won't save: readSeenMark proves an unmarked storage with a test write. They are written for the install key, so
// a thin adapter moves them onto this user's onboarding key.

const KEY_PREFIX = "potato.onboarding.v1";

export function doneKey(userId: string): string {
  return `${KEY_PREFIX}.${userId}.done`;
}

export function progressKey(userId: string): string {
  return `${KEY_PREFIX}.${userId}.progress`;
}

/** A SeenStorage whose install key, and every key under it, sits under `key` instead. */
function rekeyed(storage: SeenStorage, key: string): SeenStorage {
  const map = (k: string) => (k.startsWith(INSTALL_SEEN_KEY) ? key + k.slice(INSTALL_SEEN_KEY.length) : k);
  return {
    getItem: (k) => storage.getItem(map(k)),
    setItem: (k, v) => storage.setItem(map(k), v),
    removeItem: (k) => storage.removeItem(map(k)),
  };
}

/** Reads a progress value back, or null when it is missing or not one this build wrote. */
export function parseProgress(raw: string | null): Progress | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const whole = (n: unknown, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
  if (v.stage !== "hints" && v.stage !== "sheet") return null;
  if (!whole(v.hint, HINTS.length) || !whole(v.sorts, 1_000_000)) return null;
  return { stage: v.stage, hint: v.hint, sorts: v.sorts };
}

export function readDeviceRecord(storage: SeenStorage, userId: string): DeviceRecord {
  const done = readSeenMark(rekeyed(storage, doneKey(userId)));
  if (done !== false) return { done, progress: null };
  try {
    return { done, progress: parseProgress(storage.getItem(progressKey(userId))) };
  } catch {
    return { done: null, progress: null };
  }
}

/** Keeps the progress, so a reload carries on. Best effort: a refused write only means a reload starts over. */
export function writeProgress(storage: SeenStorage, userId: string, progress: Progress): void {
  try {
    storage.setItem(progressKey(userId), JSON.stringify(progress));
  } catch {
    // Nothing to do.
  }
}

/** Marks onboarding finished on this device, and drops the progress. False when the storage refused the mark. */
export function writeDone(storage: SeenStorage, userId: string): boolean {
  const marked = writeSeenMark(rekeyed(storage, doneKey(userId)));
  try {
    storage.removeItem(progressKey(userId));
  } catch {
    // The done mark wins over any progress left behind (readDeviceRecord).
  }
  return marked;
}
