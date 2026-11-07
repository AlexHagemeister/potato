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

/** The four card buttons, in the actions row just above the tab bar. One tap sorts (VISION invariant 4). */
export function DeckButtons({ disabled, onTap }: { disabled: boolean; onTap: (kind: SortKind) => void }) {
  return (
    <div role="group" aria-label="Sort this title" className="grid h-full grid-cols-4 items-center gap-2">
      {BUTTONS.map((b) => (
        <button
          key={b.kind}
          type="button"
          disabled={disabled}
          onClick={() => onTap(b.kind)}
          className={`flex h-14 flex-col items-center justify-center gap-0.5 rounded-2xl bg-surface-raised text-xs font-medium transition-transform active:scale-95 disabled:opacity-40 ${b.tone}`}
        >
          {b.icon}
          <span className="text-foreground">{b.label}</span>
        </button>
      ))}
    </div>
  );
}
