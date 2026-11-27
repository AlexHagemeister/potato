import type { ReactNode } from "react";
import type { ChoiceKind } from "./copy";

// The four card buttons' icons, the same paths as the deck's buttons
// (src/app/(app)/_deck/deck-buttons.tsx). Copied rather than imported: the
// deck's buttons are a live client control, and here they are an illustration.
// If the deck's icons change, change these to match.

const PATHS: Record<ChoiceKind, ReactNode> = {
  pass: <path d="M6 6l12 12M18 6L6 18" />,
  skip: <path d="M5 12h12M13 7l5 5-5 5" />,
  watchlist: <path d="M12 5v14M5 12h14" />,
  seen: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
};

export function ChoiceIcon({ kind, size = 24 }: { kind: ChoiceKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[kind]}
    </svg>
  );
}

/** Watchlist is the accent button on the deck; the others are plain. */
export function choiceTone(kind: ChoiceKind): string {
  return kind === "watchlist" ? "text-accent" : "text-foreground";
}
