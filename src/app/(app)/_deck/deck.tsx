"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Screen } from "../_shell/screen";
import type { SortKind } from "./actions";
import { CardView } from "./card-view";
import { DeckButtons } from "./deck-buttons";
import { SeenSheet } from "./seen-sheet";
import {
  dismissToast,
  retry,
  sortCard,
  startDeck,
  startOver,
  titleKey,
  undoLastSort,
  useDeck,
  viewOf,
  type DeckView,
  type Toast,
} from "./store";

/** The loading card: quiet grey blocks in the card's shape, no spinner. */
function CardSkeleton() {
  return (
    <div aria-label="Loading" aria-busy="true" className="animate-pulse">
      <div className="mx-auto aspect-[2/3] h-[min(52svh,calc((100vw-2rem)*1.5))] rounded-2xl bg-surface" />
      <div className="mt-5 h-7 w-3/4 rounded-lg bg-surface" />
      <div className="mt-2 h-5 w-1/3 rounded-lg bg-surface" />
      <div className="mt-4 h-8 w-1/2 rounded-lg bg-surface" />
    </div>
  );
}

function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-[60svh] flex-col items-center justify-center px-6 text-center">
      <p className="text-xl font-semibold">{title}</p>
      <div className="mt-2 text-muted">{children}</div>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

function PillButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full bg-surface-raised px-6 py-3 font-medium">
      {children}
    </button>
  );
}

function Body({ view }: { view: Exclude<DeckView, { kind: "card" }> }) {
  switch (view.kind) {
    case "loading":
      return <CardSkeleton />;
    case "error":
      return (
        <EmptyState title="Couldn't load titles" action={<PillButton onClick={retry}>Try again</PillButton>}>
          The movie database didn&apos;t answer. Your sorting is saved.
        </EmptyState>
      );
    case "stalled":
      return (
        <EmptyState title="Still looking" action={<PillButton onClick={retry}>Keep looking</PillButton>}>
          No new titles turned up in the last few batches.
        </EmptyState>
      );
    case "done":
      return (
        <EmptyState title="You've reached the end" action={<PillButton onClick={startOver}>Check again</PillButton>}>
          That&apos;s every title in this deck for now. Skipped titles come back after a while.
        </EmptyState>
      );
    case "locked":
      return (
        <EmptyState
          title="For you is almost ready"
          action={
            <Link href="/search" className="inline-block rounded-full bg-surface-raised px-6 py-3 font-medium">
              Find titles to rate
            </Link>
          }
        >
          Rate {view.remaining} more {view.remaining === 1 ? "title" : "titles"} you&apos;ve seen to unlock picks based on your taste.
        </EmptyState>
      );
    case "no_seeds":
      return (
        <EmptyState title="Nothing to go on yet">
          Rate a few titles of this kind with Seen it, and picks for you will show up here.
        </EmptyState>
      );
  }
}

function ToastBar({ toast }: { toast: Toast }) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-4 z-40 flex justify-center"
      // Just above the four buttons, so fast taps on them never land on the toast.
      style={{ bottom: "calc(var(--tab-bar-height) + env(safe-area-inset-bottom) + var(--deck-actions-height) + 0.5rem)" }}
    >
      <div className="pointer-events-auto flex min-h-11 items-center gap-2 rounded-full bg-surface-raised py-1 pr-1 pl-4 shadow-xl ring-1 ring-hairline">
        <span className="text-sm">{toast.message}</span>
        {toast.undoable ? (
          <button type="button" onClick={() => void undoLastSort()} className="h-9 rounded-full px-4 text-sm font-semibold text-accent">
            Undo
          </button>
        ) : (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(toast.id)}
            className="h-9 rounded-full px-3 text-sm text-muted"
          >
            OK
          </button>
        )}
      </div>
    </div>
  );
}

/** Discover: the deck, one card at a time, with the four buttons above the tab bar. */
export function Deck({ userId }: { userId: string }) {
  const state = useDeck();
  const view = viewOf(state);
  const card = view.kind === "card" ? view.card : null;
  const [seenFor, setSeenFor] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => startDeck(userId), [userId]);

  // Each new card starts at its top, even if the last one was scrolled to the trailer.
  const key = card ? titleKey(card) : view.kind;
  useLayoutEffect(() => {
    top.current?.closest("main")?.scrollTo({ top: 0 });
  }, [key]);

  function onTap(kind: SortKind) {
    if (!card) return;
    if (kind === "seen") setSeenFor(titleKey(card));
    else sortCard(kind, card);
  }

  const closeSheet = () => setSeenFor(null);
  const sheetOpen = card !== null && seenFor === titleKey(card);

  return (
    <Screen actions={<DeckButtons disabled={!card || sheetOpen} onTap={onTap} />}>
      <div ref={top} />
      {/* The filter and mode controls go in this row (the next slice). The deck is the blend until then. */}
      <div data-slot="deck-controls" className="mb-3 flex h-8 items-center justify-between">
        <h1 className="text-lg font-semibold">Discover</h1>
      </div>

      {card ? <CardView key={titleKey(card)} card={card} /> : <Body view={view as Exclude<DeckView, { kind: "card" }>} />}

      {sheetOpen && card && (
        <SeenSheet
          title={card.title}
          onCancel={closeSheet}
          onSave={(rating, review) => {
            setSeenFor(null);
            sortCard("seen", card, { rating, review });
          }}
        />
      )}
      {state.toast && !sheetOpen && <ToastBar toast={state.toast} />}
    </Screen>
  );
}
