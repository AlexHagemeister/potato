"use client";

// The home-screen prompt's client state (issue 138): whether the sheet is
// open, whether this device has already been shown it, and the browser's own
// install prompt when it offers one. Module scope, like the deck's store, so
// the shell's sheet and the Profile tab's row share it.
//
// "Already shown" lives on the device (localStorage), not in the database: it
// is a fact about this browser, and a phone and a laptop each get the steps
// once. The rules for when to show are core's (src/core/install/guide.ts).

import { useSyncExternalStore } from "react";
import { readSeenMark, shouldAutoShow, writeSeenMark } from "@/core/install/guide";

/**
 * Chromium's install prompt event. Not in TypeScript's DOM types.
 * https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallState {
  open: boolean;
  /** The sheet opened by itself, not from the Profile tab's row. */
  auto: boolean;
  /** The browser has offered its install prompt, so the sheet can show a real Install button. */
  promptReady: boolean;
  /** The browser's own install dialog is up. */
  prompting: boolean;
}

const CLOSED: InstallState = { open: false, auto: false, promptReady: false, prompting: false };

let state: InstallState = CLOSED;
let deferred: BeforeInstallPromptEvent | null = null;
let autoChecked = false;
/** First-run onboarding (issue 139) holds the sheet's one chance to open by itself until it has finished. */
let held = false;
const listeners = new Set<() => void>();

function set(patch: Partial<InstallState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether this device has the mark. null when storage is blocked, or reads but won't take a write (core proves a
 * write first), so a dismissal that can't be kept never brings the sheet back on the next load.
 */
function readSeen(): boolean | null {
  try {
    // Reading the localStorage property itself throws in some locked-down browsers.
    return readSeenMark(window.localStorage);
  } catch {
    return null;
  }
}

function markSeen() {
  try {
    writeSeenMark(window.localStorage);
  } catch {
    // Nothing to do: without storage the prompt never opens by itself (shouldAutoShow).
  }
}

// The manifest asks for standalone, and a browser without it falls back to minimal-ui. Not fullscreen: an ordinary
// tab matches that while the browser itself is in fullscreen.
const DISPLAY_MODES = ["standalone", "minimal-ui"].map((mode) => `(display-mode: ${mode})`);

/** Running from the home screen. iOS sets navigator.standalone; everything else answers the media query. */
export function isStandalone(): boolean {
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  return DISPLAY_MODES.some((query) => window.matchMedia(query).matches);
}

function subscribeStandalone(listener: () => void) {
  const queries = DISPLAY_MODES.map((query) => window.matchMedia(query));
  for (const query of queries) query.addEventListener("change", listener);
  return () => {
    for (const query of queries) query.removeEventListener("change", listener);
  };
}

/** The sheet has not had its one chance to open by itself yet, and will take it. */
function autoOpenPending(): boolean {
  return !autoChecked && shouldAutoShow({ standalone: isStandalone(), seen: readSeen() });
}

// Listening starts when this module loads, ahead of any component, because the browser fires
// beforeinstallprompt once, at a moment of its own choosing (Chrome waits for some use of the page).
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Chrome fires this late (after a tap and about 30 seconds), often once the sheet is closed. The browser's own
    // install banner is cancelled only while our sheet is up, or about to open, to carry the offer instead.
    // Otherwise the browser is left to show its banner, so the offer is not lost. Either way the event is kept, and
    // the sheet shows its Install button the next time it opens (the Profile tab's row).
    if (state.open || autoOpenPending()) event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    set({ promptReady: true });
  });
  // Installed, by our button or the browser's menu: the steps are done with.
  window.addEventListener("appinstalled", () => {
    deferred = null;
    markSeen();
    set(CLOSED);
  });
}

/**
 * Opens the sheet by itself, at most once per page load, when core's rule says so. The shell calls it once it has
 * mounted, so the check never runs on the server.
 */
export function autoOpenInstallSheet() {
  if (autoChecked || held) return;
  const show = autoOpenPending();
  autoChecked = true;
  if (show) set({ open: true, auto: true });
}

/**
 * For a new person the prompt waits its turn behind onboarding's hints and services sheet (issue 139), instead of
 * opening over the first card. Onboarding holds it from a layout effect, which runs before the shell's mount effect
 * calls autoOpenInstallSheet. While held, the sheet still counts as about to open, so the browser's own install
 * banner is cancelled and the offer rides on the sheet once it opens. Nobody else holds it, so for everyone else
 * the prompt behaves as before.
 */
export function holdInstallAutoOpen() {
  held = true;
}

/** Ends the hold. `open` takes the chance the hold kept (onboarding finished); without it the hold just lifts. */
export function releaseInstallAutoOpen({ open }: { open: boolean }) {
  if (!held) return;
  held = false;
  if (open) autoOpenInstallSheet();
}

/** Opens the sheet on request (the Profile tab's row). */
export function openInstallSheet() {
  set({ open: true, auto: false });
}

/** Closes the sheet and remembers it on this device, so it never opens by itself again. */
export function closeInstallSheet() {
  markSeen();
  set({ open: false, auto: false });
}

/** Shows the browser's own install dialog. An event's prompt works once, so the event is spent either way. */
export async function runInstallPrompt() {
  const event = deferred;
  if (!event || state.prompting) return;
  deferred = null;
  set({ promptReady: false, prompting: true });
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") {
      closeInstallSheet();
      return;
    }
  } catch {
    // The browser refused to show it. The written steps are still on the sheet.
  } finally {
    set({ prompting: false });
  }
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => CLOSED,
  );
}

/** Whether the app is running from the home screen. True on the server, so nothing install-related renders there. */
export function useStandalone(): boolean {
  return useSyncExternalStore(subscribeStandalone, isStandalone, () => true);
}
