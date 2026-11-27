"use client";

// First-run onboarding's client state (issue 139). Module scope, like the deck's and the install prompt's stores.
// The rules (who sees it, what comes next, when the screen is quiet) are core's: src/core/onboarding/rules.ts.

import { useSyncExternalStore } from "react";
import {
  advance,
  readDeviceRecord,
  sheetStillNeeded,
  startingProgress,
  writeDone,
  writeProgress,
  type OnboardingEvent,
  type Progress,
} from "@/core/onboarding/rules";
import { holdInstallAutoOpen, releaseInstallAutoOpen } from "../_install/store";
import { loadServicesSheetAction, settledAction, type SheetData } from "./actions";

export interface OnboardingState {
  userId: string | null;
  /** Null when onboarding isn't running on this load (not new, finished, or storage that can't keep a mark). */
  progress: Progress | null;
  /** The sheet's read is on its way, or the sheet is up. */
  sheetOpen: boolean;
  /**
   * The sheet is on screen. It appears once its read is in, and only if the screen is still quiet then, so it
   * never lands on a toast or sheet that came up during the read, and someone whose services were saved
   * elsewhere meanwhile never sees it flash open and shut.
   */
  sheetVisible: boolean;
  /** What the services sheet shows. Null while it loads, read fresh each time the sheet opens. */
  sheetData: SheetData | null;
  /** Onboarding has finished, and the home-screen prompt waits for the next quiet moment. */
  installWaiting: boolean;
}

const OFF: OnboardingState = {
  userId: null,
  progress: null,
  sheetOpen: false,
  sheetVisible: false,
  sheetData: null,
  installWaiting: false,
};

let state: OnboardingState = OFF;
/** Bumped per sheet read, so only the latest read fills the sheet. */
let loadToken = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<OnboardingState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storage(): Storage | null {
  try {
    // Reading the localStorage property itself throws in some locked-down browsers.
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Decides, once per user per page load, whether onboarding runs, and if so holds the home-screen prompt until it
 * has finished. Called from a layout effect in the shell, so the hold is in place before the install prompt's mount
 * effect runs. `isNew` is the server's answer (core's getIsNewAccount) when the shell rendered.
 */
export function startOnboarding(userId: string, isNew: boolean) {
  if (state.userId === userId) {
    if (state.progress || state.installWaiting) holdInstallAutoOpen();
    return;
  }
  const store = storage();
  const device = store ? readDeviceRecord(store, userId) : { done: null, progress: null };
  const progress = startingProgress({ isNew, device });
  loadToken++;
  set({ ...OFF, userId, progress });
  if (!progress) return;
  holdInstallAutoOpen();
  writeProgress(store!, userId, progress);
}

/** The shell unmounted (signed out). The hold lifts without opening anything. */
export function stopOnboarding() {
  releaseInstallAutoOpen({ open: false });
  loadToken++;
  set(OFF);
}

function apply(event: OnboardingEvent) {
  const { userId, progress } = state;
  if (!userId || !progress) return;
  const next = advance(progress, event);
  if (next === progress) return;
  const store = storage();
  if (store) writeProgress(store, userId, next);
  set({ progress: next });
}

/** What the deck's sorts meant (core's trackSorts): a tap moves the hint on, a sort that stood counts. */
export function noteSortEvents(events: readonly OnboardingEvent[]) {
  for (const event of events) apply(event);
}
/** The hint's "Got it". */
export const nextHint = () => apply({ kind: "next" });
/** "Hide tips". */
export const hideHints = () => apply({ kind: "hide_hints" });

/**
 * Reads what the sheet shows, fresh each time it opens, never from earlier in the session: services saved on
 * Profile meanwhile must show as saved, or the sheet's first tap would save over them. The settings form takes its
 * starting values once, so it mounts only from this read. `isQuiet` is asked when the read lands, and answers
 * whether the screen stayed quiet the whole time: if a toast, a sheet, or another tab came up meanwhile, the sheet
 * stays shut and opens at the next quiet moment, read again.
 */
async function loadSheet(isQuiet: () => boolean) {
  const token = ++loadToken;
  const userId = state.userId;
  set({ sheetData: null });
  const data = await loadServicesSheetAction().catch((): SheetData => ({ ok: false }));
  if (token !== loadToken || state.userId !== userId || !state.sheetOpen) return;
  if (data.ok && !sheetStillNeeded(data.value.settings) && !state.sheetVisible) {
    void finishOnboarding(() => {});
    return;
  }
  if (!state.sheetVisible && !isQuiet()) {
    set({ sheetOpen: false, sheetData: null });
    return;
  }
  set({ sheetData: data, sheetVisible: true });
}

/** The sheet's moment has come (the hints are over, the first few sorts stood, and the screen is quiet). */
export function openServicesSheet(isQuiet: () => boolean) {
  if (state.progress?.stage !== "sheet" || state.sheetOpen) return;
  set({ sheetOpen: true });
  void loadSheet(isQuiet);
}

/** Loads the sheet again after a failure. The sheet is already up, so the screen's quiet doesn't matter. */
export function retrySheet() {
  void loadSheet(() => true);
}

/**
 * The person left the deck while the sheet was loading or up (the sheet only ever shows on the deck). Onboarding
 * isn't finished: the sheet opens again, read fresh, at the next quiet moment there.
 */
export function cancelServicesSheet() {
  if (!state.sheetOpen) return;
  loadToken++;
  set({ sheetOpen: false, sheetVisible: false, sheetData: null });
}

/**
 * The sheet closed (Done or Not now): onboarding is finished on this device. Waits out any services save still on
 * its way, then calls `refresh` (the router's), so the deck reads the saved settings. The home-screen prompt then
 * waits for a quiet moment (releaseInstallPrompt).
 */
export async function finishOnboarding(refresh: () => void) {
  const { userId } = state;
  if (!userId || !state.progress) return;
  const store = storage();
  if (store) writeDone(store, userId);
  loadToken++;
  set({ progress: null, sheetOpen: false, sheetVisible: false, sheetData: null, installWaiting: true });
  try {
    await settledAction();
  } catch {
    // The refresh below still reads whatever was saved.
  }
  if (state.userId === userId) refresh();
}

/** The screen has been quiet a moment since onboarding finished: the home-screen prompt takes its turn. */
export function releaseInstallPrompt() {
  if (!state.installWaiting) return;
  set({ installWaiting: false });
  releaseInstallAutoOpen({ open: true });
}

export function useOnboarding(): OnboardingState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => OFF,
  );
}
