"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { RATING_MAX, RATING_MIN } from "@/core/library/types";

const STARS = [1, 2, 3, 4, 5] as const;
const STEP = 0.5;

const STAR_PATH =
  "M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z";

function Star({ fill }: { fill: 0 | 0.5 | 1 }) {
  return (
    <span className="relative block size-12">
      <svg viewBox="0 0 24 24" className="absolute inset-0 size-full text-hairline" aria-hidden>
        <path d={STAR_PATH} fill="currentColor" />
      </svg>
      {fill > 0 && (
        <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
          <svg viewBox="0 0 24 24" className="block size-12 text-accent" aria-hidden>
            <path d={STAR_PATH} fill="currentColor" />
          </svg>
        </span>
      )}
    </span>
  );
}

/**
 * Half a star to 5 stars in half steps (Alex's ruling on issue 3). Tap a
 * star's left half for the half step, its right half for the whole star, or
 * drag along the row. Keyboard: arrows step by a half star.
 */
export function StarRating({ value, onChange }: { value: number | null; onChange: (rating: number) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function valueAt(clientX: number): number {
    const box = row.current!.getBoundingClientRect();
    const fraction = (clientX - box.left) / box.width;
    // Round up to the next half star: the left half of star 3 is 2.5, its right half 3.
    const halves = Math.ceil(fraction * RATING_MAX * 2);
    return Math.min(RATING_MAX, Math.max(RATING_MIN, halves * STEP));
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(valueAt(e.clientX));
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (dragging.current) onChange(valueAt(e.clientX));
  }

  function onPointerEnd() {
    dragging.current = false;
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const current = value ?? 0;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = current + STEP;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = current - STEP;
    else if (e.key === "Home") next = RATING_MIN;
    else if (e.key === "End") next = RATING_MAX;
    if (next === null) return;
    e.preventDefault();
    onChange(Math.min(RATING_MAX, Math.max(RATING_MIN, next)));
  }

  return (
    <div
      ref={row}
      role="slider"
      tabIndex={0}
      aria-label="Rating"
      aria-valuemin={RATING_MIN}
      aria-valuemax={RATING_MAX}
      aria-valuenow={value ?? undefined}
      aria-valuetext={value === null ? "Not rated" : `${value} ${value === 1 ? "star" : "stars"}`}
      data-rating={value ?? ""}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      className="flex w-fit touch-none outline-none"
    >
      {STARS.map((n) => {
        const v = value ?? 0;
        const fill = v >= n ? 1 : v >= n - STEP ? 0.5 : 0;
        return <Star key={n} fill={fill} />;
      })}
    </div>
  );
}
