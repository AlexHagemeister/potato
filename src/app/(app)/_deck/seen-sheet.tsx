"use client";

import { useEffect, useState } from "react";
import { REVIEW_MAX_LENGTH } from "@/core/library/types";
import { StarRating } from "./star-rating";

/**
 * How far the on-screen keyboard covers the bottom of the layout viewport.
 * iOS Safari doesn't shrink fixed elements for the keyboard, so the sheet
 * lifts itself by this much to keep the review box and Save in view.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

function formatStars(rating: number): string {
  return `${rating} ${rating === 1 ? "star" : "stars"}`;
}

/**
 * Seen it: rate (required) and review (optional). Save marks the title seen
 * and the deck advances. Cancel, the backdrop, or Escape closes the sheet and
 * leaves the card as it was. After a failed save the sheet reopens with what
 * the user entered (`draft`) and the error.
 */
export function SeenSheet({
  title,
  draft,
  onSave,
  onCancel,
}: {
  title: string;
  draft?: { rating: number; review: string | null; error: string };
  onSave: (rating: number, review: string | null) => void;
  onCancel: () => void;
}) {
  const [rating, setRating] = useState<number | null>(draft?.rating ?? null);
  const [review, setReview] = useState(draft?.review ?? "");
  const keyboard = useKeyboardInset();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button type="button" aria-label="Cancel" onClick={onCancel} className="absolute inset-0 bg-black/60" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="seen-sheet-title"
        className="relative rounded-t-3xl bg-surface-raised px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] shadow-2xl"
        style={{ marginBottom: keyboard }}
      >
        <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-hairline" />
        <p className="text-sm text-muted">Seen it</p>
        <h2 id="seen-sheet-title" className="mb-4 text-xl leading-tight font-semibold">
          {title}
        </h2>
        {draft && (
          <p role="alert" className="mb-4 rounded-xl bg-surface px-4 py-2 text-sm">
            {draft.error}
          </p>
        )}

        <div className="mb-1 flex justify-center">
          <StarRating value={rating} onChange={setRating} />
        </div>
        <p className="mb-4 text-center text-sm text-muted" aria-live="polite">
          {rating === null ? "Tap a star to rate" : formatStars(rating)}
        </p>

        <label className="mb-4 block">
          <span className="sr-only">Review (optional)</span>
          <textarea
            value={review}
            onChange={(e) => setReview(e.target.value)}
            maxLength={REVIEW_MAX_LENGTH}
            rows={3}
            placeholder="Add a review (optional)"
            className="block w-full resize-none rounded-2xl bg-surface px-4 py-3 text-foreground placeholder:text-muted outline-none"
          />
        </label>

        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="h-12 flex-1 rounded-full bg-surface font-medium">
            Cancel
          </button>
          <button
            type="button"
            disabled={rating === null}
            // A blank review is sent as typed: core treats a blank review as none.
            onClick={() => rating !== null && onSave(rating, review === "" ? null : review)}
            className="h-12 flex-1 rounded-full bg-accent font-semibold text-black disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
