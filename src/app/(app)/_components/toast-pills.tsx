"use client";

// The Undo toast and the error notice, shared by the deck and the full title card.
// Presentational only: each screen owns the state, the timer, and where the pills sit.
//
// Where they sit (issue 50): in the screen's top row, never over the card. The
// card's IMDb rating sits just above the fold (VISION invariant 5), so anything
// laid over the bottom of the scroll area, or any strip that shrinks it, hides
// the rating. The top row has room the card never uses.

// No vertical padding: each button fills the pill's full 44 px height, so its tap target meets the 44 pt minimum
// (issue 68) and the pill still fits the 44 px top row without moving anything.
const PILL = "flex min-h-11 min-w-0 items-center gap-2 rounded-full bg-surface-raised pr-1 pl-4 ring-1 ring-hairline";

/** The confirmation of a sort, with its Undo. The message wraps to two lines when the row is narrow. */
export function UndoPill({ message, onUndo }: { message: string; onUndo: () => void }) {
  return (
    <div role="status" data-toast="undo" className={PILL}>
      <span className="line-clamp-2 min-w-0 text-sm leading-tight">{message}</span>
      <button type="button" onClick={onUndo} className="h-11 shrink-0 rounded-full px-4 text-sm font-semibold text-accent">
        Undo
      </button>
    </div>
  );
}

/** An error message. It shows beside the Undo, never in place of it, and stays until dismissed. */
export function NoticePill({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="status" data-toast="notice" className={PILL}>
      {/* Unclamped (a notice can name a long title), so the text keeps its own padding when it wraps past 44 px. */}
      <span className="min-w-0 py-1 text-sm leading-tight">{message}</span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="h-11 shrink-0 rounded-full px-3 text-sm text-muted">
        OK
      </button>
    </div>
  );
}
