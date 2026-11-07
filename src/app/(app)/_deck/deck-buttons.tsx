"use client";

import type { ReactNode } from "react";
import type { SortKind } from "./actions";

const iconProps = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const BUTTONS: { kind: SortKind; label: string; icon: ReactNode; tone: string }[] = [
  {
    kind: "pass",
    label: "Pass",
    tone: "text-foreground",
    icon: (
      <svg {...iconProps}>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    ),
  },
  {
    kind: "skip",
    label: "Skip",
    tone: "text-foreground",
    icon: (
      <svg {...iconProps}>
        <path d="M5 12h12M13 7l5 5-5 5" />
      </svg>
    ),
  },
  {
    kind: "watchlist",
    label: "Watchlist",
    tone: "text-accent",
    icon: (
      <svg {...iconProps}>
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
  },
  {
    kind: "seen",
    label: "Seen it",
    tone: "text-foreground",
    icon: (
      <svg {...iconProps}>
        <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="2.75" />
      </svg>
    ),
  },
];

/**
 * The four card buttons, in the actions row just above the tab bar. One tap sorts (VISION invariant 4).
 * `current` marks the button for where the title already is (a card opened from Search or Lists). That button
 * is pressed and does nothing, except Seen it, which stays tappable to edit the rating.
 */
export function DeckButtons({
  disabled,
  onTap,
  current = null,
}: {
  disabled: boolean;
  onTap: (kind: SortKind) => void;
  current?: SortKind | null;
}) {
  return (
    <div role="group" aria-label="Sort this title" className="grid h-full grid-cols-4 items-center gap-2">
      {BUTTONS.map((b) => {
        const pressed = current === b.kind;
        return (
          <button
            key={b.kind}
            type="button"
            disabled={disabled || (pressed && b.kind !== "seen")}
            aria-pressed={current === null ? undefined : pressed}
            onClick={() => onTap(b.kind)}
            className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-2xl text-xs font-medium transition-transform active:scale-95 disabled:opacity-40 ${
              pressed ? "bg-accent/15 ring-1 ring-accent/60 disabled:opacity-100" : "bg-surface-raised"
            } ${b.tone}`}
          >
            {b.icon}
            <span className="text-foreground">{b.label}</span>
          </button>
        );
      })}
    </div>
  );
}
