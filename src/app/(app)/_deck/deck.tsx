"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Screen } from "../_shell/screen";
import type { SortKind } from "./actions";
import { CardView } from "./card-view";
import { DeckButtons } from "./deck-buttons";
import { RatingSheet } from "../_components/rating-sheet";
import type { DeckPageCard } from "@/core/deck-service/types";
import {
  dismissNotice,
  markCardSeen,
  retry,
  sortCard,
  startDeck,
  startOver,
  titleKey,
  undoLastSort,
  useDeck,
  viewOf,
  type DeckView,
  type Notice,
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

const PILL = "pointer-events-auto flex min-h-11 items-center gap-2 rounded-full bg-surface-raised py-1 pr-1 pl-4 shadow-xl ring-1 ring-hairline";

/** The Undo toast, with an error notice stacked above it. A notice never replaces the Undo. */
function Toasts({ toast, notice }: { toast: Toast | null; notice: Notice | null }) {
  if (!toast && !notice) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-4 z-40 flex flex-col items-center gap-2"
      // Just above the four buttons, so fast taps on them never land on the toast.
      style={{ bottom: "calc(var(--tab-bar-height) + env(safe-area-inset-bottom) + var(--deck-actions-height) + 0.5rem)" }}
    >
      {notice && (
        <div data-toast="notice" className={PILL}>
          <span className="text-sm">{notice.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissNotice(notice.id)} className="h-9 rounded-full px-3 text-sm text-muted">
            OK
          </button>
        </div>
      )}
      {toast && (
        <div data-toast="undo" className={PILL}>
          <span className="text-sm">{toast.message}</span>
          <button type="button" onClick={() => void undoLastSort()} className="h-9 rounded-full px-4 text-sm font-semibold text-accent">
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Discover: the deck, one card at a time, with the four buttons above the tab
 * bar. `settingsKey` names the user's country and services: when it changes,
 * the queued cards are refetched with the new streaming data.
 */
export function Deck({ userId, settingsKey }: { userId: string; settingsKey: string }) {
  const state = useDeck();
  const view = viewOf(state);
  const card = view.kind === "card" ? view.card : null;
  // The card the Seen it sheet is open for. The sheet keeps it even if a
  // failed Pass puts another card on top meanwhile. The sheet covers the
  // screen, so nothing else can be sorted while it is open.
  const [seenCard, setSeenCard] = useState<DeckPageCard | null>(null);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => startDeck(userId, settingsKey), [userId, settingsKey]);

  // Each new card starts at its top, even if the last one was scrolled to the trailer.
  const key = card ? titleKey(card) : view.kind;
  useLayoutEffect(() => {
    top.current?.closest("main")?.scrollTo({ top: 0 });
  }, [key]);

  function onTap(kind: SortKind) {
    if (!card) return;
    if (kind === "seen") setSeenCard(card);
    else sortCard(kind, card);
  }

  return (
    <Screen actions={<DeckButtons disabled={!card || seenCard !== null || state.undoing} onTap={onTap} />}>
      <div ref={top} />
      {/* The filter and mode controls go in this row (the next slice). The deck is the blend until then. */}
      <div data-slot="deck-controls" className="mb-3 flex h-8 items-center justify-between">
        <h1 className="text-lg font-semibold">Discover</h1>
      </div>

      {card ? <CardView key={titleKey(card)} card={card} /> : <Body view={view as Exclude<DeckView, { kind: "card" }>} />}

      {seenCard && (
        <RatingSheet
          // Prefixed: the card beside it is keyed by the bare title key.
          key={`seen-${titleKey(seenCard)}`}
          heading="Mark as seen"
          title={seenCard.title}
          subtitle={[seenCard.year, seenCard.mediaType === "movie" ? "Movie" : "Series"].filter(Boolean).join(" · ")}
          posterUrl={seenCard.posterUrl}
          initialRating={null}
          initialReview={null}
          onCancel={() => setSeenCard(null)}
          // Waits for the save: on failure the sheet keeps the rating and review and shows the error.
          onSave={async (rating, review) => {
            const error = await markCardSeen(seenCard, rating, review === "" ? null : review);
            if (!error) setSeenCard(null);
            return error;
          }}
        />
      )}
      {!seenCard && <Toasts toast={state.toast} notice={state.notice} />}
    </Screen>
  );
}
