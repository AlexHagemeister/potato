"use client";

import { useState } from "react";
import { REVIEW_MAX_LENGTH } from "@/core/library/types";
import { Poster } from "./poster";
import { StarInput } from "./star-input";

export interface RatingSheetProps {
  /** "Mark as seen" or "Edit rating". */
  heading: string;
  title: string;
  subtitle: string;
  posterUrl: string | null;
  initialRating: number | null;
  initialReview: string | null;
  onCancel: () => void;
  /** Saves. Resolves to an error message to show, or null when saved (the caller closes the sheet). */
  onSave: (rating: number, review: string) => Promise<string | null>;
}

/**
 * A full-screen sheet that asks for a rating (required) and a review
 * (optional), like an iOS compose sheet: Cancel and Save sit at the top, so
 * the keyboard never covers them. Shared by the Lists tab and, later, the
 * card's "Seen it" button.
 */
export function RatingSheet(props: RatingSheetProps) {
  const [rating, setRating] = useState<number | null>(props.initialRating);
  const [review, setReview] = useState(props.initialReview ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (rating === null || pending) return;
    setPending(true);
    setError(null);
    const message = await props.onSave(rating, review);
    // On success the caller unmounts the sheet. On failure, keep what was typed.
    if (message) {
      setError(message);
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rating-sheet-heading"
      className="sheet-in fixed inset-0 z-50 flex flex-col bg-background"
    >
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-hairline px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" onClick={props.onCancel} className="h-14 justify-self-start px-3 text-accent">
          Cancel
        </button>
        <h2 id="rating-sheet-heading" className="text-base font-semibold">
          {props.heading}
        </h2>
        <button
          type="button"
          onClick={save}
          disabled={rating === null || pending}
          className="h-14 justify-self-end px-3 font-semibold text-accent disabled:text-muted"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <div className="mb-6 flex items-center gap-3">
          <Poster url={props.posterUrl} title={props.title} width={48} />
          <div className="min-w-0">
            <p className="line-clamp-2 font-semibold">{props.title}</p>
            <p className="text-sm text-muted">{props.subtitle}</p>
          </div>
        </div>

        <StarInput value={rating} onChange={setRating} />

        <label className="mt-8 block">
          <span className="mb-2 block px-1 text-xs font-semibold tracking-wide text-muted uppercase">
            Review (optional)
          </span>
          <textarea
            value={review}
            onChange={(e) => setReview(e.target.value)}
            maxLength={REVIEW_MAX_LENGTH}
            rows={6}
            placeholder="What did you think?"
            className="block w-full resize-none rounded-2xl bg-surface px-4 py-3 outline-none placeholder:text-muted"
          />
        </label>

        {error && (
          <p role="alert" className="mt-3 px-1 text-sm text-red-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
