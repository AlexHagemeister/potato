"use client";

// First-run onboarding's client state (issue 139). Module scope, like the deck's and the install prompt's stores.
// The rules (who sees it, what comes next) are core's: src/core/onboarding/rules.ts.

import { useSyncExternalStore } from "react";
import {
  advance,
  readDeviceRecord,
  startingProgress,
  writeDone,
  writeProgress,
  type OnboardingEvent,
  type Progress,
} from "@/core/onboarding/rules";
import { holdInstallAutoOpen, releaseInstallAutoOpen } from "../_install/store";
import { loadServicesSheetAction, settledAction, type SheetData } from "./actions";

/** The pause between the services sheet closing and the home-screen prompt opening, so the deck shows between them. */
const INSTALL_AFTER_MS = 700;

export interface OnboardingState {
  userId: string | null;
  /** Null when onboarding isn't running on this load (not new, finished, or storage that can't keep a mark). */
  progress: Progress | null;
  sheetOpen: boolean;
  /**
   * The sheet is on screen. It appears once its first read is in, so someone whose services were saved elsewhere
   * meanwhile never sees it flash open and shut.
   */
  sheetVisible: boolean;
  /** What the services sheet shows. Null while it loads, read fresh each time the sheet opens. */
  sheetData: SheetData | null;
}

const OFF: OnboardingState = { userId: null, progress: null, sheetOpen: false, sheetVisible: false, sheetData: null };

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
    if (state.progress) holdInstallAutoOpen();
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

/** A card was sorted on the deck. */
export const noteSorted = () => apply({ kind: "sorted" });
/** The hint's "Got it". */
export const nextHint = () => apply({ kind: "next" });
/** "Hide tips". */
export const hideHints = () => apply({ kind: "hide_hints" });

/**
 * Reads what the sheet shows, fresh each time it opens, never from earlier in the session: services saved on
 * Profile meanwhile must show as saved, or the sheet's first tap would save over them. The settings form takes its
 * starting values once, so it mounts only from this read.
 */
async function loadSheet() {
  const token = ++loadToken;
  const userId = state.userId;
  set({ sheetData: null });
  const data = await loadServicesSheetAction().catch((): SheetData => ({ ok: false }));
  if (token !== loadToken || state.userId !== userId || !state.sheetOpen) return;
  // Services saved elsewhere meanwhile (Profile, another device): the sheet has nothing to ask.
  if (data.ok && data.value.settings.providerIds.length > 0 && !state.sheetVisible) {
    void finishOnboarding(() => {});
    return;
  }
  set({ sheetData: data, sheetVisible: true });
}

/** The sheet's moment has come (the hints are over, the first few sorts are made, and nothing else is on screen). */
export function openServicesSheet() {
  if (state.progress?.stage !== "sheet" || state.sheetOpen) return;
  set({ sheetOpen: true });
  void loadSheet();
}

/** Loads the sheet again after a failure. */
export function retrySheet() {
  void loadSheet();
}

/**
 * The sheet closed (Done or Not now): onboarding is finished on this device. Waits out any services save still on
 * its way, then calls `refresh` (the router's), so the deck reads the saved settings, then lets the home-screen
 * prompt take its turn.
 */
export async function finishOnboarding(refresh: () => void) {
  const { userId } = state;
  if (!userId || !state.progress) return;
  const store = storage();
  if (store) writeDone(store, userId);
  set({ progress: null, sheetOpen: false, sheetVisible: false });
  try {
    await settledAction();
  } catch {
    // The refresh below still reads whatever was saved.
  }
  if (state.userId === userId) refresh();
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      if (state.userId === userId) releaseInstallAutoOpen({ open: true });
      resolve();
    }, INSTALL_AFTER_MS);
  });
}

export function useOnboarding(): OnboardingState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => OFF,
  );
}
