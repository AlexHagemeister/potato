"use client";

import { useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from "react";
import { RATING_MAX, RATING_MIN } from "@/core/library/types";
import { gestureOf, ratingAt, starAt, stepRating, tapRating, type Gesture } from "./star-scale";
import { ratingLabel, ratingText, Star, STAR_COUNT, STAR_NUMBERS, starFill } from "./stars";

/** A press on the stars in progress: where it went down, what it has turned into, and the rating a drag last set. */
interface Press {
  pointerId: number;
  downX: number;
  downY: number;
  gesture: Gesture;
  dragged: number | null;
}

/**
 * Takes a rating from half a star to 10 stars, in half steps (the picker Alex
 * chose from a prototype on 2026-11-07). Ten stars in one row, each slot as wide
 * as the row allows up to 56px, the star 3px narrower than its slot.
 *
 * - Tap a star for that many stars. Tap the same star again for half a star less.
 *   The star is the one under the finger when it went down.
 * - Or press on the stars and slide sideways: once the finger has moved 8px, the
 *   rating follows it in half steps and stays where it lifts. A press that moves
 *   up or down first is a scroll of the sheet and changes nothing.
 * - Keyboards, VoiceOver, and other assistive tech get a native range input,
 *   visually hidden, that steps half a star. The visible stars are hidden from them,
 *   so a VoiceOver double-tap cannot land on a star.
 */
export function StarInput({ value, onChange }: { value: number | null; onChange: (rating: number) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  // What a screen reader hears after a tap or a drag: set once, when the finger lifts.
  const [announced, setAnnounced] = useState("");

  function set(rating: number) {
    if (rating !== value) onChange(rating);
  }

  function announce(rating: number) {
    setAnnounced(ratingLabel(rating));
  }

  /** A point's position from the first star's left edge, and one star's slot width, measured now. */
  function measure(clientX: number): { x: number; slot: number } | null {
    const row = rowRef.current?.getBoundingClientRect();
    if (!row || row.width === 0) return null;
    return { x: clientX - row.left, slot: row.width / STAR_COUNT };
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    press.current = { pointerId: e.pointerId, downX: e.clientX, downY: e.clientY, gesture: "press", dragged: null };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety: without it the drag still works while the finger stays on the row.
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const p = press.current;
    if (!p || p.pointerId !== e.pointerId) return;
    if (p.gesture === "press") p.gesture = gestureOf(e.clientX - p.downX, e.clientY - p.downY);
    if (p.gesture !== "drag") return;
    const at = measure(e.clientX);
    if (!at) return;
    const rating = ratingAt(at.x, at.slot);
    if (rating === p.dragged) return;
    p.dragged = rating;
    onChange(rating);
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const p = press.current;
    press.current = null;
    if (!p || p.pointerId !== e.pointerId) return;
    if (p.gesture === "drag") {
      if (p.dragged !== null) announce(p.dragged);
      return;
    }
    if (p.gesture !== "press") return;
    // A press that never moved is a tap on the star it went down on.
    const at = measure(p.downX);
    const star = at && starAt(at.x, at.slot);
    if (!star) return;
    const rating = tapRating(value, star);
    set(rating);
    announce(rating);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = stepRating(value, 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = stepRating(value, -1);
    else if (e.key === "Home") next = RATING_MIN;
    else if (e.key === "End") next = RATING_MAX;
    else return;
    e.preventDefault();
    set(next);
  }

  function onRangeChange(e: ChangeEvent<HTMLInputElement>) {
    const rating = Number(e.target.value);
    if (Number.isFinite(rating)) set(rating);
  }

  return (
    <div className="group relative flex w-full flex-col items-center gap-1">
      {/* touch-action: pan-y lets a vertical swipe on the stars scroll the sheet (the browser
          cancels the press), while sideways movement stays with the drag. */}
      <div
        ref={rowRef}
        aria-hidden
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (press.current = null)}
        className="flex w-full max-w-[560px] touch-pan-y rounded-xl select-none [-webkit-touch-callout:none] group-has-[input:focus-visible]:outline-2 group-has-[input:focus-visible]:outline-offset-2 group-has-[input:focus-visible]:outline-accent"
      >
        {STAR_NUMBERS.map((n) => (
          <span key={n} className="flex h-14 min-w-0 flex-1 items-center justify-center">
            <Star fill={value === null ? 0 : starFill(value, n)} size="calc(100% - 3px)" />
          </span>
        ))}
      </div>
      <p aria-hidden className="text-base font-semibold tabular-nums">
        {value === null ? "Tap to rate" : ratingText(value)}
      </p>
      <p aria-hidden className="text-center text-xs text-muted">
        Tap a star again for a half star, or drag along the row.
      </p>
      {/* The slider for keyboards and assistive tech. Unrated, it sits at the lowest step so
          aria-valuenow stays valid, and its valuetext says "Not rated". It is pinned to the
          bottom-left corner, under the hint text, so a VoiceOver double-tap (a press at its
          spot) can never land on a star. */}
      <input
        type="range"
        min={RATING_MIN}
        max={RATING_MAX}
        step={0.5}
        value={value ?? RATING_MIN}
        aria-label="Rating"
        aria-valuetext={value === null ? "Not rated" : ratingLabel(value)}
        onKeyDown={onKeyDown}
        onChange={onRangeChange}
        className="sr-only bottom-0 left-0"
      />
      <p aria-live="polite" className="sr-only">
        {announced}
      </p>
    </div>
  );
}
