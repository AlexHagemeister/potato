"use client";

import { ratingLabel, Star, starFill } from "./stars";

/**
 * Takes a rating from half a star to 5 stars, in half steps. Each star is one
 * 56pt target: tap a star for that many stars, tap the same star again for
 * half a star less. Half-width targets would be under 44pt on a phone.
 */
export function StarInput({ value, onChange }: { value: number | null; onChange: (rating: number) => void }) {
  const tap = (n: number) => onChange(value === n ? n - 0.5 : n);
  return (
    <div className="flex flex-col items-center gap-1">
      <div role="group" aria-label="Rating" className="flex">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={ratingLabel(value === n ? n - 0.5 : n)}
            aria-pressed={value !== null && value >= n - 0.5}
            onClick={() => tap(n)}
            className="flex h-14 w-14 items-center justify-center"
          >
            <Star fill={value === null ? 0 : starFill(value, n)} size={40} />
          </button>
        ))}
      </div>
      <p aria-live="polite" className="text-base font-semibold">
        {value === null ? "Tap to rate" : ratingLabel(value)}
      </p>
      <p className="text-xs text-muted">Tap a star again for a half star.</p>
    </div>
  );
}
