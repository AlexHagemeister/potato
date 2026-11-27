"use client";

import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { chooseLabelSpot, POINTER_OVERLAP, type Box, type LabelSpot } from "@/core/onboarding/placement";
import {
  currentHint,
  HINTS,
  isQuiet,
  nextQuietSince,
  QUIET_MS_BEFORE_INSTALL,
  QUIET_MS_BEFORE_SHEET,
  quietFor,
  remountAfterSheetSave,
  startSortTracker,
  trackSorts,
  type Hint,
  type SortSignals,
  type SortTracker,
} from "@/core/onboarding/rules";
import { titleKey, useDeck, viewOf, type DeckState } from "../_deck/store";
import { ServicesSheet } from "./services-sheet";
import {
  cancelServicesSheet,
  hideHints,
  nextHint,
  noteSortEvents,
  openServicesSheet,
  pageRestarted,
  releaseInstallPrompt,
  startOnboarding,
  stopOnboarding,
  useOnboarding,
} from "./store";

/** How often the shell looks again for a quiet moment while one is awaited. */
const QUIET_POLL_MS = 250;

/**
 * Something on screen that a full-screen sheet would cover: another sheet or menu, anything fullscreen, or the
 * card's trailer, which plays inline once tapped.
 */
function overlayUp(): boolean {
  return (
    document.querySelector('[role="dialog"], [role="menu"], main article iframe') !== null ||
    document.fullscreenElement !== null
  );
}

/** The screen right now, by core's rule (isQuiet). */
function quietNow(deck: DeckState, userId: string, onDeck: boolean): boolean {
  const mine = deck.userId === userId;
  return isQuiet({
    onDeck,
    visible: document.visibilityState === "visible",
    toast: mine && deck.toast !== null,
    undoing: mine && deck.undoing,
    notice: mine && deck.notice !== null,
    overlay: overlayUp(),
  });
}

/**
 * First-run onboarding (issue 139), a layer in the app shell. Nothing stands between sign-in and the first card
 * (VISION invariant 8): the deck loads as usual, and hints point at its four buttons one at a time. After the first
 * few sorts, one sheet asks for the country and streaming services. The home-screen prompt waits until then.
 * Only a new account sees any of it (core's rules), and only once per device.
 */
export function Onboarding({ userId, isNew }: { userId: string; isNew: boolean }) {
  // The server's answer when the shell first rendered. A refresh re-renders the shell once the person has sorted
  // (and so is no longer "new"), and must not stop onboarding midway.
  const [isNewAtStart] = useState(isNew);
  const state = useOnboarding();
  const deck = useDeck();
  const pathname = usePathname();
  const router = useRouter();
  const onDeck = pathname === "/";

  // A layout effect, so the install prompt is held before the shell's mount effect would open it.
  useLayoutEffect(() => {
    startOnboarding(userId, isNewAtStart);
    return stopOnboarding;
  }, [userId, isNewAtStart]);

  // Every sort on the deck shows a new Undo toast (Seen it, once its rating is saved), and how the toast ends says
  // whether the sort stood (core's trackSorts). A toast already up when this mounts is an older sort's.
  const mine = deck.userId === userId;
  const signals: SortSignals = {
    toastId: mine ? (deck.toast?.id ?? null) : null,
    noticeId: mine ? (deck.notice?.id ?? null) : null,
    undoing: mine && deck.undoing,
  };
  const tracker = useRef<SortTracker | null>(null);
  useEffect(() => {
    const now = { toastId: signals.toastId, noticeId: signals.noticeId, undoing: signals.undoing };
    if (!tracker.current) {
      tracker.current = startSortTracker(now);
      return;
    }
    const out = trackSorts(tracker.current, now);
    tracker.current = out.tracker;
    if (out.events.length > 0) noteSortEvents(out.events);
  }, [signals.toastId, signals.noticeId, signals.undoing]);

  // The services sheet, and after it the home-screen prompt, each wait until the screen has been quiet a moment
  // (core's isQuiet): on the deck, no Undo toast or undo on its way, no error notice, and no other sheet, menu,
  // fullscreen, or playing trailer.
  const latest = useRef({ deck, onDeck });
  useLayoutEffect(() => {
    latest.current = { deck, onDeck };
  }, [deck, onDeck]);
  // The quiet is watched the whole time the sheet's read is on its way too, so the sheet shows only if nothing
  // came up at any point during the read, not merely at the moment it lands.
  const sheetDue = state.progress?.stage === "sheet" && !state.sheetOpen;
  const loading = state.sheetOpen && !state.sheetVisible;
  const installDue = state.installWaiting && !state.sheetOpen;
  const awaiting = sheetDue || loading || installDue;
  const quietSince = useRef<number | null>(null);
  useEffect(() => {
    if (!awaiting) {
      quietSince.current = null;
      return;
    }
    const look = () => {
      const now = Date.now();
      quietSince.current = nextQuietSince(quietSince.current, quietNow(latest.current.deck, userId, latest.current.onDeck), now);
      return now;
    };
    const check = () => {
      const now = look();
      if (sheetDue && quietFor(quietSince.current, now, QUIET_MS_BEFORE_SHEET)) {
        const openedAt = now;
        openServicesSheet(() => {
          look();
          return quietSince.current !== null && quietSince.current <= openedAt;
        });
      } else if (installDue && quietFor(quietSince.current, now, QUIET_MS_BEFORE_INSTALL)) {
        releaseInstallPrompt();
      }
    };
    check();
    const timer = setInterval(check, QUIET_POLL_MS);
    return () => clearInterval(timer);
  }, [awaiting, sheetDue, installDue, userId]);

  // The sheet belongs to the deck. Leaving it (another tab, or Back) puts the sheet away unfinished, so it never
  // shows over Profile's own settings form, and it opens again, read fresh, on the deck.
  useEffect(() => {
    if (!onDeck && state.sheetOpen) cancelServicesSheet();
  }, [onDeck, state.sheetOpen]);

  // When the sheet shows, the router's cache of other pages goes. A Profile page cached earlier holds the services
  // as they were then, and history Back restores a cached page as it was: its form would then save that old
  // selection over whatever the sheet saves. Each change in the sheet refreshes again once saved (noteSheetChange).
  const sheetShown = state.sheetVisible && onDeck;
  useEffect(() => {
    if (sheetShown) router.refresh();
  }, [sheetShown, router]);

  // A sheet save that landed only after the person left the deck: the page they reached may have read the
  // settings before it, and its form keeps what it first read. The page is refreshed, and once the fresh data is
  // in, started over (PageRestart), so its form reads what the sheet saved.
  const [restarting, startRestart] = useTransition();
  const restartStarted = useRef(false);
  useEffect(() => {
    if (!state.pageRestartDue || restartStarted.current) return;
    if (!remountAfterSheetSave({ leftDeckWhileSaving: true, onDeck })) {
      pageRestarted(false);
      router.refresh();
      return;
    }
    restartStarted.current = true;
    startRestart(() => router.refresh());
  }, [state.pageRestartDue, onDeck, router]);
  useEffect(() => {
    if (!restartStarted.current || restarting) return;
    restartStarted.current = false;
    pageRestarted(true);
  }, [restarting]);

  if (!state.progress && !state.sheetVisible) return null;
  const hint = state.progress ? currentHint(state.progress) : null;
  const view = viewOf(deck);
  const showHint = hint !== null && onDeck && mine && view.kind === "card";
  return (
    <>
      {showHint && view.kind === "card" && <HintLayer hint={hint} index={state.progress!.hint} cardKey={titleKey(view.card)} />}
      {state.sheetVisible && onDeck && <ServicesSheet data={state.sheetData} onRefresh={() => router.refresh()} />}
    </>
  );
}

/** Column `i` of the four-button row: the row's own grid (px-4, four columns, gap-2), so it lines up with no measuring. */
const column = (i: number) => ({
  left: `calc(1rem + (100% - 2rem - 1.5rem) / 4 * ${i} + 0.5rem * ${i})`,
  width: "calc((100% - 2rem - 1.5rem) / 4)",
});

/** The shell's bottom edge: the tab bar (its hairline border included) on top of the bottom safe area. */
const ABOVE_TAB_BAR = "calc(var(--tab-bar-height) + env(safe-area-inset-bottom) + 1px)";

/**
 * The hint for one button: a ring around the button and a label above the row pointing at it. Never modal, and
 * never in the way of a tap: the ring takes no taps, and the label sits clear of the buttons. When the label would
 * cover the card's title, its IMDb rating (VISION invariant 5), or the deck's top row, filter line, or error
 * notice, it moves up over the poster to a clear spot instead, and hides when there is none.
 */
function HintLayer({ hint, index, cardKey }: { hint: Hint; index: number; cardKey: string }) {
  const bubble = useRef<HTMLDivElement>(null);
  const safeTop = useRef<HTMLDivElement>(null);
  const { spot, top } = useKeepClearPlacement(bubble, safeTop, `${cardKey}:${index}`);
  const placement = spot.kind === "above_row" ? "above_row" : spot.kind === "at" ? "over_poster" : "hidden";

  return (
    <>
      {/* Where the top safe area ends, for measuring. */}
      <div ref={safeTop} aria-hidden className="pointer-events-none fixed top-[env(safe-area-inset-top)] h-0 w-0" />
      {/* The ring around the button, over the deck's own row. */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 z-20" style={{ bottom: ABOVE_TAB_BAR, height: "var(--deck-actions-height)" }}>
        <div
          className="absolute top-1/2 h-14 -translate-y-1/2 transition-[left] duration-300 ease-out motion-reduce:transition-none"
          style={column(index)}
        >
          <div className="absolute -inset-[3px] rounded-[1.2rem] border-2 border-accent motion-safe:animate-pulse" />
        </div>
      </div>

      <div
        className={`pointer-events-none fixed inset-x-0 z-20 px-4 ${placement === "hidden" ? "invisible" : ""}`}
        style={
          placement === "above_row"
            ? { bottom: `calc(${ABOVE_TAB_BAR} + var(--deck-actions-height) - ${POINTER_OVERLAP}px)` }
            : { top: `${top}px` }
        }
      >
        <div
          ref={bubble}
          data-slot="onboarding-hint"
          data-placement={placement}
          onKeyDown={(e) => {
            if (e.key === "Escape") hideHints();
          }}
          className={`${placement === "hidden" ? "" : "pointer-events-auto"} relative rounded-2xl bg-surface-raised px-4 pt-2.5 pb-3 shadow-[0_8px_30px_rgba(0,0,0,0.6)] ring-1 ring-accent/50`}
        >
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[0.9375rem] font-semibold text-accent">
              {hint.label}
              <span className="ml-2 text-xs font-medium text-muted tabular-nums">
                {index + 1} of {HINTS.length}
              </span>
            </p>
            <button
              type="button"
              onClick={nextHint}
              className="-my-1 h-9 rounded-full bg-accent/15 px-3.5 text-sm font-semibold text-accent"
            >
              Got it
            </button>
            <button
              type="button"
              onClick={hideHints}
              aria-label="Hide tips"
              className="-my-1 -mr-2 flex h-9 w-9 items-center justify-center rounded-full text-muted"
            >
              <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          {/* Announced as each hint arrives, without moving focus off the card. */}
          <p role="status" aria-live="polite" className="mt-0.5 text-sm leading-snug">
            <span className="sr-only">
              Tip {index + 1} of {HINTS.length}, {hint.label} button:{" "}
            </span>
            <span key={index} className="block transition-opacity duration-300 starting:opacity-0 motion-reduce:transition-none">
              {hint.text}
            </span>
          </p>

          {placement === "above_row" && (
            // The pointer, under the button's column.
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-2">
              <div
                className="absolute top-0 h-2 transition-[left] duration-300 ease-out motion-reduce:transition-none"
                style={{
                  // The bubble spans the row's inner width, so its columns have no outer 1rem.
                  left: `calc((100% - 1.5rem) / 4 * ${index} + 0.5rem * ${index})`,
                  width: "calc((100% - 1.5rem) / 4)",
                }}
              >
                <svg width="18" height="8" viewBox="0 0 18 8" className="absolute left-1/2 -translate-x-1/2 text-surface-raised" aria-hidden>
                  <path d="M0 0h18L9 8z" fill="currentColor" />
                </svg>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** What the hint's label must never cover, besides the buttons (core's chooseLabelSpot keeps it above those). */
const KEEP_CLEAR = [
  // The card's title and its IMDb rating (VISION invariant 5).
  "main article[data-title-key] header h2",
  "main article[data-title-key] [data-imdb]",
  // The deck's top row (the Undo toast shows there), its filter line, and its error notice.
  '[data-slot="deck-controls"]',
  '[data-slot="deck-filter-summary"]',
  '[data-toast="notice"]',
].join(", ");

function toBox(r: DOMRect): Box {
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

/**
 * Where the hint's label goes (core's chooseLabelSpot): just above the button row when that is clear, otherwise
 * the highest clear spot over the poster, otherwise nowhere until the next scroll. Measured against the screen
 * again on every scroll, resize, new card, and change on the deck (an error notice arriving, say).
 */
function useKeepClearPlacement(
  bubble: React.RefObject<HTMLDivElement | null>,
  safeTop: React.RefObject<HTMLDivElement | null>,
  measureKey: string,
): { spot: LabelSpot; top: number } {
  // `top` is the last over-the-poster spot's, so a hidden label stays where it was (and measures the same).
  const [placed, setPlaced] = useState<{ spot: LabelSpot; top: number }>({ spot: { kind: "above_row" }, top: 0 });
  const current = useRef<LabelSpot>(placed.spot);
  useLayoutEffect(() => {
    const measure = () => {
      const row = document.querySelector('[data-slot="deck-actions"]');
      const box = bubble.current;
      if (!row || !box) return;
      const width = box.getBoundingClientRect();
      const next = chooseLabelSpot({
        rowTop: row.getBoundingClientRect().top,
        minTop: (safeTop.current?.getBoundingClientRect().top ?? 0) + 8,
        height: box.offsetHeight,
        left: width.left,
        right: width.right,
        keepClear: Array.from(document.querySelectorAll(KEEP_CLEAR), (el) => toBox(el.getBoundingClientRect())),
        current: current.current,
      });
      const same =
        next.kind === current.current.kind && (next.kind !== "at" || current.current.kind !== "at" || next.top === current.current.top);
      if (same) return;
      current.current = next;
      setPlaced((was) => ({ spot: next, top: next.kind === "at" ? next.top : was.top }));
    };
    measure();
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const main = document.querySelector("main");
    main?.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    // The card's poster and title settle after the first paint.
    const resized = new ResizeObserver(later);
    const card = document.querySelector("main article[data-title-key]");
    if (card) resized.observe(card);
    if (bubble.current) resized.observe(bubble.current);
    // A notice, a filter line, or the Undo toast coming or going moves what must stay clear.
    const changed = new MutationObserver(later);
    if (main) changed.observe(main, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      main?.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
      resized.disconnect();
      changed.disconnect();
    };
  }, [bubble, safeTop, measureKey]);
  return placed;
}

/**
 * The shell's page, keyed so onboarding can start it over: only after a services save from the sheet landed once
 * the person had already left the deck (see Onboarding). Otherwise the key never changes, and pages mount and
 * stay mounted exactly as without it.
 */
export function PageRestart({ children }: { children: ReactNode }) {
  const { pageEpoch } = useOnboarding();
  return <Fragment key={pageEpoch}>{children}</Fragment>;
}
