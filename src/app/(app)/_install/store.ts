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
import { INSTALL_SEEN_KEY, INSTALL_SEEN_VALUE, shouldAutoShow } from "@/core/install/guide";

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
  /** The browser has offered its install prompt, so the sheet can show a real Install button. */
  promptReady: boolean;
  /** The browser's own install dialog is up. */
  prompting: boolean;
}

const CLOSED: InstallState = { open: false, promptReady: false, prompting: false };

let state: InstallState = CLOSED;
let deferred: BeforeInstallPromptEvent | null = null;
let autoChecked = false;
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

/** Whether this device has the mark. null when storage can't be read (blocked, or a locked-down browser). */
function readSeen(): boolean | null {
  try {
    return window.localStorage.getItem(INSTALL_SEEN_KEY) === INSTALL_SEEN_VALUE;
  } catch {
    return null;
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(INSTALL_SEEN_KEY, INSTALL_SEEN_VALUE);
  } catch {
    // Nothing to do: without storage the prompt never opens by itself (shouldAutoShow).
  }
}

const DISPLAY_MODES = ["standalone", "fullscreen", "minimal-ui"].map((mode) => `(display-mode: ${mode})`);

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

// Listening starts when this module loads, ahead of any component, because the browser fires
// beforeinstallprompt once, at a moment of its own choosing (Chrome waits for some use of the page).
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Keeps the browser's own banner away, so the offer shows only inside our sheet.
    event.preventDefault();
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
  if (autoChecked) return;
  autoChecked = true;
  if (shouldAutoShow({ standalone: isStandalone(), seen: readSeen() })) set({ open: true });
}

/** Opens the sheet on request (the Profile tab's row). */
export function openInstallSheet() {
  set({ open: true });
}

/** Closes the sheet and remembers it on this device, so it never opens by itself again. */
export function closeInstallSheet() {
  markSeen();
  set({ open: false });
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
