"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentHint, HINTS, type Hint } from "@/core/onboarding/rules";
import { titleKey, useDeck, viewOf } from "../_deck/store";
import { ServicesSheet } from "./services-sheet";
import {
  hideHints,
  nextHint,
  noteSorted,
  openServicesSheet,
  startOnboarding,
  stopOnboarding,
  useOnboarding,
} from "./store";

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

  // Every sort on the deck shows a new Undo toast (Seen it, once its rating is saved). The toast up when this
  // mounts is an older sort's, so it only sets the baseline.
  const toastId = deck.userId === userId ? (deck.toast?.id ?? null) : null;
  const lastToast = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (lastToast.current === undefined) {
      lastToast.current = toastId;
      return;
    }
    if (toastId !== null && toastId !== lastToast.current) noteSorted();
    lastToast.current = toastId;
  }, [toastId]);

  // The services sheet waits for a quiet moment on the deck: no Undo toast (the Undo stays reachable), no undo on
  // its way, and no other sheet up (the rating or filter sheet).
  const sheetDue = state.progress?.stage === "sheet" && !state.sheetOpen;
  const quiet = onDeck && deck.toast === null && !deck.undoing;
  useEffect(() => {
    if (!sheetDue || !quiet) return;
    const check = () => {
      if (document.visibilityState === "visible" && !document.querySelector('[role="dialog"]')) void openServicesSheet();
    };
    check();
    const timer = setInterval(check, 400);
    return () => clearInterval(timer);
  }, [sheetDue, quiet]);

  if (!state.progress && !state.sheetVisible) return null;
  const hint = state.progress ? currentHint(state.progress) : null;
  const view = viewOf(deck);
  const showHint = hint !== null && onDeck && deck.userId === userId && view.kind === "card";
  return (
    <>
      {showHint && view.kind === "card" && <HintLayer hint={hint} index={state.progress!.hint} cardKey={titleKey(view.card)} />}
      {state.sheetVisible && <ServicesSheet data={state.sheetData} onRefresh={() => router.refresh()} />}
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
 * cover the card's title or its IMDb rating (VISION invariant 5), it moves up over the poster instead.
 */
function HintLayer({ hint, index, cardKey }: { hint: Hint; index: number; cardKey: string }) {
  const bubble = useRef<HTMLDivElement>(null);
  const placement = useKeepClearPlacement(bubble, `${cardKey}:${index}`);

  return (
    <>
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
        className="pointer-events-none fixed inset-x-0 z-20 px-4"
        style={
          placement === "above_row"
            ? { bottom: `calc(${ABOVE_TAB_BAR} + var(--deck-actions-height) - 2px)` }
            : { top: "calc(env(safe-area-inset-top) + 4.25rem)" }
        }
      >
        <div
          ref={bubble}
          data-slot="onboarding-hint"
          data-placement={placement}
          onKeyDown={(e) => {
            if (e.key === "Escape") hideHints();
          }}
          className="pointer-events-auto relative rounded-2xl bg-surface-raised px-4 pt-2.5 pb-3 shadow-[0_8px_30px_rgba(0,0,0,0.6)] ring-1 ring-accent/50"
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

type Placement = "above_row" | "over_poster";

/**
 * Where the hint's label goes: just above the button row, unless it would cover the card's title or IMDb rating
 * there. Measured against the card on screen, again on every scroll, resize, and new card, so a long title or a
 * short screen moves it up over the poster.
 */
function useKeepClearPlacement(bubble: React.RefObject<HTMLDivElement | null>, measureKey: string): Placement {
  const [placement, setPlacement] = useState<Placement>("above_row");
  useLayoutEffect(() => {
    const measure = () => {
      const row = document.querySelector('[data-slot="deck-actions"]');
      const card = document.querySelector("main article[data-title-key]");
      const box = bubble.current;
      if (!row || !card || !box) return;
      const keep = [card.querySelector("header h2"), card.querySelector("[data-imdb]")].filter((el) => el !== null);
      const rowTop = row.getBoundingClientRect().top;
      // Where the label's top would be above the row (its pointer reaches into the row's top padding).
      const top = rowTop - box.offsetHeight + 2;
      const covers = keep.some((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > top - 6 && r.top < rowTop;
      });
      setPlacement(covers ? "over_poster" : "above_row");
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
    const observer = new ResizeObserver(later);
    const card = document.querySelector("main article[data-title-key]");
    if (card) observer.observe(card);
    if (bubble.current) observer.observe(bubble.current);
    return () => {
      cancelAnimationFrame(frame);
      main?.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
      observer.disconnect();
    };
  }, [bubble, measureKey]);
  return placement;
}
