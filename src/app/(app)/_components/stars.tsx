// Star rendering shared by every screen that shows or takes a rating (half a
// star to 5 stars, in half steps: Alex's ruling on issue 3).

const STAR_PATH =
  "M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z";

/** One star, full, half, or empty. */
export function Star({ fill, size }: { fill: 0 | 0.5 | 1; size: number }) {
  return (
    <span aria-hidden className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 24 24" className="absolute inset-0 text-hairline">
        <path d={STAR_PATH} fill="currentColor" />
      </svg>
      {fill > 0 && (
        <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: fill === 1 ? size : size / 2 }}>
          <svg width={size} height={size} viewBox="0 0 24 24" className="text-accent">
            <path d={STAR_PATH} fill="currentColor" />
          </svg>
        </span>
      )}
    </span>
  );
}

/** How much of star `n` (1 to 5) a rating fills. */
export function starFill(rating: number, n: number): 0 | 0.5 | 1 {
  if (rating >= n) return 1;
  if (rating >= n - 0.5) return 0.5;
  return 0;
}

/** Spoken and written form of a rating: "4.5 stars", "1 star". */
export function ratingLabel(rating: number): string {
  return `${rating} ${rating === 1 ? "star" : "stars"}`;
}

/** A read-only row of five stars. */
export function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <span role="img" aria-label={ratingLabel(rating)} className="inline-flex items-center gap-px">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} fill={starFill(rating, n)} size={size} />
      ))}
    </span>
  );
}
