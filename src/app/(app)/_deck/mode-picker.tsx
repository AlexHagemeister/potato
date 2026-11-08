"use client";

import { useEffect, useRef, useState } from "react";
import { MODE_LABELS, MODE_NOTES } from "@/core/filters";
import { DISCOVERY_MODES, type DiscoveryMode } from "@/core/types";

/**
 * The discovery mode picker in Discover's header: a button with the current
 * mode, and a menu of the five modes. Picking one applies it at once (two
 * taps), since a mode is one choice, unlike the filters.
 */
export function ModePicker({ value, onChange }: { value: DiscoveryMode; onChange: (mode: DiscoveryMode) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function pick(mode: DiscoveryMode) {
    setOpen(false);
    if (mode !== value) onChange(mode);
  }

  // Not `relative`: the menu is placed against the header's control group (deck.tsx), so its right edge sits at
  // the screen's right margin. Anchored to this button instead, a wider Filters button pushed the 256 px menu
  // off the left edge (issue 68).
  return (
    <div ref={root} data-slot="mode" className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Mode: ${MODE_LABELS[value]}`}
        className="flex h-11 items-center gap-1.5 rounded-full bg-surface-raised px-3 text-sm font-semibold"
      >
        {MODE_LABELS[value]}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Mode"
          className="absolute top-full right-0 z-30 mt-2 w-64 overflow-hidden rounded-2xl bg-surface-raised py-1 shadow-xl ring-1 ring-hairline"
        >
          {DISCOVERY_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={mode === value}
              onClick={() => pick(mode)}
              className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className={`block font-medium ${mode === value ? "text-accent" : ""}`}>{MODE_LABELS[mode]}</span>
                <span className="block text-sm text-muted">{MODE_NOTES[mode]}</span>
              </span>
              {mode === value && (
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
                  <path d="m3.5 8.5 3 3 6-7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
