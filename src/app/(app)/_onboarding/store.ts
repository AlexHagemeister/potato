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
  /** What the services sheet shows. Null until loaded; fetched ahead, after the first sort. */
  sheetData: SheetData | null;
}

const OFF: OnboardingState = { userId: null, progress: null, sheetOpen: false, sheetData: null };

let state: OnboardingState = OFF;
let loading: Promise<SheetData> | null = null;
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
  loading = null;
  set({ ...OFF, userId, progress });
  if (!progress) return;
  holdInstallAutoOpen();
  writeProgress(store!, userId, progress);
  if (progress.sorts > 0) void prefetchSheet();
}

/** The shell unmounted (signed out). The hold lifts without opening anything. */
export function stopOnboarding() {
  releaseInstallAutoOpen({ open: false });
  loading = null;
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
  if (event.kind === "sorted") void prefetchSheet();
}

/** A card was sorted on the deck. */
export const noteSorted = () => apply({ kind: "sorted" });
/** The hint's "Got it". */
export const nextHint = () => apply({ kind: "next" });
/** "Hide tips". */
export const hideHints = () => apply({ kind: "hide_hints" });

function prefetchSheet(): Promise<SheetData> {
  if (state.sheetData?.ok) return Promise.resolve(state.sheetData);
  if (loading) return loading;
  const userId = state.userId;
  const load = loadServicesSheetAction()
    .catch((): SheetData => ({ ok: false }))
    .then((data) => {
      if (state.userId === userId) set({ sheetData: data });
      // A failure is tried again when the sheet opens.
      if (loading === load && !data.ok) loading = null;
      return data;
    });
  loading = load;
  return load;
}

/**
 * The sheet's moment has come (the hints are over, the first few sorts are made, and nothing else is on screen).
 * Someone who has already saved services elsewhere meanwhile doesn't need it, so it finishes instead.
 */
export async function openServicesSheet() {
  if (state.progress?.stage !== "sheet" || state.sheetOpen) return;
  set({ sheetOpen: true });
  const data = await prefetchSheet();
  if (data.ok && data.value.settings.providerIds.length > 0 && state.sheetOpen) void finishOnboarding(() => {});
}

/** Loads the sheet again after a failure. */
export function retrySheet() {
  set({ sheetData: null });
  void prefetchSheet();
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
  set({ progress: null, sheetOpen: false });
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
