// The star picker's arithmetic, apart from the DOM so it can be tested. Every
// function takes a position measured from the left edge of the first star,
// and the width of one star's slot, both in CSS pixels.

import { RATING_MAX, RATING_MIN } from "@/core/library/types";

/** How far a finger moves sideways before a press on the stars is a drag, not a tap. */
export const DRAG_THRESHOLD_PX = 8;

/** The rating under a point of the row, in half steps: the left half of star n is n − 0.5, the right half n. */
export function ratingAt(x: number, slot: number): number {
  const halves = Math.ceil((x / slot) * 2);
  return Math.min(RATING_MAX * 2, Math.max(RATING_MIN * 2, halves)) / 2;
}

/** The star (1 to 10) under a point of the row. */
export function starAt(x: number, slot: number): number {
  return Math.min(RATING_MAX, Math.max(1, Math.ceil(x / slot)));
}

/** A tap on star n: that many stars, or half a star less when the rating is already n. */
export function tapRating(current: number | null, n: number): number {
  return current === n ? n - 0.5 : n;
}

/** The rating after one keyboard step (±0.5). With no rating yet, either step gives the lowest. */
export function stepRating(current: number | null, direction: 1 | -1): number {
  if (current === null) return RATING_MIN;
  return Math.min(RATING_MAX, Math.max(RATING_MIN, current + direction * 0.5));
}
