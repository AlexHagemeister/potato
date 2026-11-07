"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Card, CardUserState } from "@/core/deck-service/types";
import { cardUserState } from "@/core/deck-service/user-state";
import type { ActionOutcome } from "@/core/library/types";
import type { TitleId, TitleStatus } from "@/core/types";
import { RatingSheet } from "../../../_components/rating-sheet";
import { Stars } from "../../../_components/stars";
import { markSeenAction, sortCardAction, undoSortAction, type DeckActionResult, type SortKind } from "../../../_deck/actions";
import { CardView } from "../../../_deck/card-view";
import { DeckButtons } from "../../../_deck/deck-buttons";
import { NoticePill, UndoPill } from "../../../_components/toast-pills";
import { Screen } from "../../../_shell/screen";
import { editRatingAction } from "../../../lists/actions";

// The full card for one title, opened from Search or Lists. The same card and
// the same four buttons as the deck. The difference: the card stays on screen
// after a tap, showing where the title now is, since there is no next card.
// Each button calls the same server action the deck does, and core decides
// what it does to the title's row. Pass, Skip, and Watchlist show at once and
// roll back with an error if the save fails. Seen it waits for the save, like
// the deck. Undo restores the row exactly as it was (VISION invariant 2).
// Core decides what the card shows for a row (cardUserState): getCard applies
// it on the server, and this screen applies it to each action's outcome.

const TOAST_MS = 4500;

const STATUS_OF: Record<SortKind, TitleStatus> = { pass: "passed", skip: "skipped", watchlist: "watchlist", seen: "seen" };
const KIND_OF: Record<TitleStatus, SortKind> = { passed: "pass", skipped: "skip", watchlist: "watchlist", seen: "seen" };

const DONE_LABEL: Record<SortKind, string> = {
  pass: "Passed",
  skip: "Skipped for now",
  watchlist: "Added to Watchlist",
  seen: "Marked as seen",
};

const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

interface Toast {
  id: number;
  message: string;
  /** The action the Undo reverses. */
  outcome: ActionOutcome;
}

interface Notice {
  id: number;
  message: string;
}

const noSubscribe = () => () => {};

/**
 * False on the server and while hydrating, true after. The skip date is
 * formatted only in the browser, in the phone's own time zone: the server runs
 * in UTC, so its "Nov 22" can be the phone's "Nov 21".
 */
function useInBrowser(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Whether the history entry before this card is a Potato screen, so Back can
 * return to it. The Navigation API answers exactly (canGoBack counts only
 * same-origin entries, and survives a reload). Without it, the card counts as
 * in-app only when it was reached by a client navigation, that is, the
 * document opened on another URL. That fallback never leaves the app: at worst
 * Back goes to Search instead of the previous screen.
 */
function canGoBackInApp(): boolean {
  const navigation = (window as { navigation?: { canGoBack?: unknown } }).navigation;
  if (typeof navigation?.canGoBack === "boolean") return navigation.canGoBack;
  const first = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return first !== undefined && first.type !== "reload" && first.name !== window.location.href;
}

/** Where the title is now, above the card. */
function StatusLine({ state }: { state: CardUserState | null }) {
  const inBrowser = useInBrowser();
  if (!state) return null;
  let text: ReactNode;
  switch (state.status) {
    case "watchlist":
      text = "On your Watchlist";
      break;
    case "passed":
      text = "In your Passed list";
      break;
    case "skipped":
      text = state.skipUntil && inBrowser ? `Skipped until ${dateFormat.format(new Date(state.skipUntil))}` : "Skipped for now";
      break;
    case "seen":
      text = (
        <>
          <span>Seen</span>
          {state.rating !== null && <Stars rating={state.rating} />}
        </>
      );
      break;
  }
  return (
    <p data-status={state.status} className="mb-3 flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-sm font-medium">
      {text}
    </p>
  );
}

export function TitleScreen({ card }: { card: Card }) {
  const router = useRouter();
  const ref: TitleId = { mediaType: card.mediaType, tmdbId: card.tmdbId };
  // getCard has already applied core's rules (an expired skip is null).
  const [state, setState] = useState<CardUserState | null>(card.userState);
  const [busy, setBusy] = useState(false);
  const [seenOpen, setSeenOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const seq = useRef(0);
  /** A save or undo landed on this screen. */
  const changed = useRef(false);

  // Back restores the previous screen from the router's cache. If this card changed the title, that copy is
  // stale (a Lists row still on its old list), so once the next screen is up, refresh it from the server.
  useEffect(() => {
    const flag = changed;
    return () => {
      if (flag.current) setTimeout(() => router.refresh(), 0);
    };
  }, [router]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  function done(kind: SortKind, outcome: ActionOutcome) {
    changed.current = true;
    setState(cardUserState(ref, outcome.current, new Date()));
    setNotice(null);
    setToast({ id: ++seq.current, message: state?.status === "seen" && kind === "seen" ? "Rating saved" : DONE_LABEL[kind], outcome });
  }

  function fail(message: string) {
    setNotice({ id: ++seq.current, message });
  }

  async function onTap(kind: SortKind) {
    if (busy) return;
    if (kind === "seen") {
      setSeenOpen(true);
      return;
    }
    const before = state;
    // Shows at once. The save runs behind it and rolls back if it fails.
    setState({ status: STATUS_OF[kind], rating: null, review: null, skipUntil: null });
    setToast(null);
    setBusy(true);
    let result: DeckActionResult;
    try {
      result = await sortCardAction(kind, ref);
    } catch {
      result = { ok: false, error: "Couldn't save. Check your connection." };
    }
    setBusy(false);
    if (result.ok) done(kind, result.outcome);
    else {
      setState(before);
      fail(result.error);
    }
  }

  async function saveSeen(rating: number, review: string): Promise<string | null> {
    // A Seen title's rating is edited the way the Lists tab edits it: core changes it only while the title is
    // still Seen, so a change made elsewhere (another device) is never silently overwritten.
    if (state?.status === "seen") return editSeen(rating, review);
    let result: DeckActionResult;
    try {
      result = await markSeenAction(ref, rating, review === "" ? null : review);
    } catch {
      result = { ok: false, error: "Couldn't save. Check your connection." };
    }
    if (!result.ok) return result.error;
    setSeenOpen(false);
    done("seen", result.outcome);
    return null;
  }

  async function editSeen(rating: number, review: string): Promise<string | null> {
    let result: Awaited<ReturnType<typeof editRatingAction>>;
    try {
      result = await editRatingAction(ref, rating, review);
    } catch {
      return "Couldn't save. Check your connection.";
    }
    if (result.ok) {
      setSeenOpen(false);
      done("seen", result.value);
      return null;
    }
    if (!result.stale) return result.error;
    // The title moved since this card loaded. Reload it from the server: page.tsx keys this screen on the
    // title's state, so the screen starts over with where the title is now.
    setSeenOpen(false);
    router.refresh();
    return null;
  }

  async function undo() {
    if (!toast || busy) return;
    const { outcome } = toast;
    const after = state;
    setToast(null);
    setState(cardUserState(ref, outcome.previous, new Date()));
    setBusy(true);
    let result: DeckActionResult;
    try {
      result = await undoSortAction(ref, outcome);
    } catch {
      result = { ok: false, error: "Couldn't undo. Check your connection." };
    }
    setBusy(false);
    if (result.ok) {
      setState(cardUserState(ref, result.outcome.current, new Date()));
      setNotice(null);
    } else {
      setState(after);
      fail(result.error);
    }
  }

  function back() {
    if (canGoBackInApp()) router.back();
    else router.push("/search");
  }

  return (
    <Screen
      actions={<DeckButtons disabled={busy || seenOpen} current={state ? KIND_OF[state.status] : null} onTap={(k) => void onTap(k)} />}
    >
      {/*
        The top bar: Back, and the Undo toast beside it, clear of the card and the four buttons (issue 50).
        Sticky like Search's search bar, so Undo stays in view when the tap came from far down the card.
      */}
      <div data-slot="title-bar" className="sticky top-0 z-10 -mx-4 bg-background px-4 pb-3">
        <div className="flex h-8 items-center justify-between gap-2">
          <button type="button" onClick={back} className="-ml-2 flex h-11 shrink-0 items-center gap-1 px-2 text-accent">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Back
          </button>
          {!seenOpen && toast && <UndoPill message={toast.message} onUndo={() => void undo()} />}
        </div>
        {!seenOpen && notice && (
          <div className="mt-3 flex justify-end">
            <NoticePill message={notice.message} onDismiss={() => setNotice(null)} />
          </div>
        )}
      </div>

      <StatusLine state={state} />
      <CardView card={card} />

      {seenOpen && (
        <RatingSheet
          heading={state?.status === "seen" ? "Edit rating" : "Mark as seen"}
          title={card.title}
          subtitle={[card.year, card.mediaType === "movie" ? "Movie" : "Series"].filter(Boolean).join(" · ")}
          posterUrl={card.posterUrl}
          initialRating={state?.status === "seen" ? state.rating : null}
          initialReview={state?.status === "seen" ? state.review : null}
          onCancel={() => setSeenOpen(false)}
          onSave={saveSeen}
        />
      )}
    </Screen>
  );
}
