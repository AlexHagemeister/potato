"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { RATING_MAX, RATING_MIN } from "@/core/library/types";
import { DRAG_THRESHOLD_PX, ratingAt, starAt, stepRating, tapRating } from "./star-scale";
import { ratingLabel, ratingText, Star, STAR_NUMBERS, starFill } from "./stars";

/** A press on the row in progress: where it went down, and whether it has turned into a drag. */
interface Press {
  pointerId: number;
  downX: number;
  dragging: boolean;
}

/**
 * Takes a rating from half a star to 10 stars, in half steps (the picker Alex
 * chose from a prototype on 2026-11-07). Ten stars in one row, each slot as wide
 * as the row allows up to 56px, the star 3px narrower than its slot.
 *
 * - Tap a star for that many stars. Tap the same star again for half a star less.
 * - Or press anywhere on the row and slide: once the finger has moved 8px
 *   sideways, the rating follows it in half steps and stays where it lifts.
 * - With a keyboard, the row is a slider: the arrow keys step half a star.
 */
export function StarInput({ value, onChange }: { value: number | null; onChange: (rating: number) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  // The rating as last set, so a tap that lands before React re-renders still sees it.
  const current = useRef(value);
  useEffect(() => {
    current.current = value;
  }, [value]);

  function set(rating: number) {
    if (rating === current.current) return;
    current.current = rating;
    onChange(rating);
  }

  /** The finger's position from the first star's left edge, and one slot's width, measured now. */
  function measure(clientX: number): { x: number; slot: number } | null {
    const first = rowRef.current?.firstElementChild?.getBoundingClientRect();
    if (!first || first.width === 0) return null;
    return { x: clientX - first.left, slot: first.width };
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    press.current = { pointerId: e.pointerId, downX: e.clientX, dragging: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety: without it the drag still works while the finger stays on the row.
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (!p.dragging && Math.abs(e.clientX - p.downX) < DRAG_THRESHOLD_PX) return;
    p.dragging = true;
    const at = measure(e.clientX);
    if (at) set(ratingAt(at.x, at.slot));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const p = press.current;
    press.current = null;
    if (!p || p.pointerId !== e.pointerId || p.dragging) return;
    // A press that never moved is a tap on the star under it.
    const at = measure(e.clientX);
    if (at) set(tapRating(current.current, starAt(at.x, at.slot)));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = stepRating(current.current, 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = stepRating(current.current, -1);
    else if (e.key === "Home") next = RATING_MIN;
    else if (e.key === "End") next = RATING_MAX;
    else return;
    e.preventDefault();
    set(next);
  }

  return (
    <div className="flex flex-col items-center gap-1">
      {/* touch-action: none keeps iOS from scrolling the sheet while a finger slides along the stars. */}
      <div
        ref={rowRef}
        role="slider"
        tabIndex={0}
        aria-label="Rating"
        aria-valuemin={RATING_MIN}
        aria-valuemax={RATING_MAX}
        aria-valuenow={value ?? undefined}
        aria-valuetext={value === null ? "Not rated" : ratingLabel(value)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (press.current = null)}
        onKeyDown={onKeyDown}
        className="flex w-full touch-none justify-center rounded-xl select-none [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {STAR_NUMBERS.map((n) => (
          <span key={n} className="flex h-14 max-w-14 min-w-0 flex-1 items-center justify-center">
            <Star fill={value === null ? 0 : starFill(value, n)} size="calc(100% - 3px)" />
          </span>
        ))}
      </div>
      <p aria-live="polite" className="text-base font-semibold tabular-nums">
        {value === null ? "Tap to rate" : ratingText(value)}
      </p>
      <p className="text-center text-xs text-muted">Tap a star again for a half star, or drag along the row.</p>
    </div>
  );
}
