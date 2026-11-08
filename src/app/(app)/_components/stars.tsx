// Star rendering shared by every screen that shows or takes a rating (half a
// star to 10 stars, in half steps: Alex, 2026-11-07, widening his ruling on
// issue 3). Core holds the scale. These draw it.

import { RATING_MAX } from "@/core/library/types";

const STAR_PATH =
  "M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z";

/** How many stars a rating row draws: one per whole point of the scale. */
export const STAR_COUNT = RATING_MAX;

/** The star numbers of a row, 1 to STAR_COUNT. */
export const STAR_NUMBERS = Array.from({ length: STAR_COUNT }, (_, i) => i + 1);

/**
 * One star, full, half, or empty. `size` is pixels, or any CSS length (the
 * picker sizes its stars to the row's width). The fill is drawn in percent of
 * the star's box, so it holds at any size.
 */
export function Star({ fill, size }: { fill: 0 | 0.5 | 1; size: number | string }) {
  return (
    <span aria-hidden className="relative inline-block aspect-square shrink-0" style={{ width: size }}>
      <svg viewBox="0 0 24 24" className="absolute inset-0 h-full w-full text-hairline">
        <path d={STAR_PATH} fill="currentColor" />
      </svg>
      {fill > 0 && (
        <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: fill === 1 ? "100%" : "50%" }}>
          {/* As wide as the whole star, so the clip shows its left half. */}
          <svg viewBox="0 0 24 24" className="block h-full text-accent" style={{ width: fill === 1 ? "100%" : "200%" }}>
            <path d={STAR_PATH} fill="currentColor" />
          </svg>
        </span>
      )}
    </span>
  );
}

/** How much of star `n` (1 to 10) a rating fills. */
export function starFill(rating: number, n: number): 0 | 0.5 | 1 {
  if (rating >= n) return 1;
  if (rating >= n - 0.5) return 0.5;
  return 0;
}

/** Written form of a rating: "8 / 10", "7.5 / 10". */
export function ratingText(rating: number): string {
  return `${rating} / ${RATING_MAX}`;
}

/** Spoken form of a rating, for VoiceOver: "8 out of 10", "7.5 out of 10". */
export function ratingLabel(rating: number): string {
  return `${rating} out of ${RATING_MAX}`;
}

/**
 * A read-only rating: ten stars, then "8.5 / 10". The stars are `size` px each at most,
 * and shrink together when the row is narrower (a 320-wide phone, a larger text size),
 * so the number never gets pushed out.
 */
export function Stars({ rating, size = 13 }: { rating: number; size?: number }) {
  return (
    <span role="img" aria-label={ratingLabel(rating)} className="flex max-w-full min-w-0 items-center gap-1.5">
      <span className="flex min-w-0 items-center" style={{ width: size * STAR_COUNT }}>
        {STAR_NUMBERS.map((n) => (
          <span key={n} className="flex min-w-0 flex-1">
            <Star fill={starFill(rating, n)} size="100%" />
          </span>
        ))}
      </span>
      <span aria-hidden className="shrink-0 text-xs font-semibold text-foreground tabular-nums">
        {ratingText(rating)}
      </span>
    </span>
  );
}
