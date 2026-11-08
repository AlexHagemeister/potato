"use client";

import { useEffect, useRef, useState } from "react";
import { REVIEW_MAX_LENGTH } from "@/core/library/types";
import { Poster } from "./poster";
import { StarInput } from "./star-input";

/**
 * How long the removal's Remove button ignores taps after the confirmation opens (issue 43). Longer than a double
 * tap (iOS counts taps up to about 300 ms apart), shorter than reading the question. This, not where the buttons
 * sit, is what stops a double tap on "Remove rating and review" from confirming: the trigger can sit anywhere on
 * screen, depending on the phone, the scroll, the title's length, and the text size.
 */
export const REMOVE_ARM_MS = 600;

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
  /**
   * When set, the sheet offers "Remove rating and review", behind a confirmation (issue 43). Resolves to an error
   * message to show, or null when removed (the caller closes the sheet).
   */
  onRemove?: () => Promise<string | null>;
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
  // The removal's confirmation is up.
  const [confirming, setConfirming] = useState(false);
  // When the confirmation opened (performance.now()), for the REMOVE_ARM_MS gate.
  const confirmOpenedAt = useRef(0);
  const keepRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function openConfirm() {
    confirmOpenedAt.current = performance.now();
    setConfirming(true);
  }

  function closeConfirm() {
    if (!pending) setConfirming(false);
  }

  // Keep, the safe answer, takes focus when the confirmation opens, so VoiceOver reads the question and Enter keeps.
  // When it closes, focus goes back to the trigger, once the sheet behind is no longer inert.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  // Escape closes the confirmation, unless the removal is already on its way.
  useEffect(() => {
    if (!confirming || pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirming(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming, pending]);

  async function remove() {
    if (!props.onRemove || pending) return;
    // A tap this soon after the confirmation opened is the second half of a double tap on the trigger.
    if (performance.now() - confirmOpenedAt.current < REMOVE_ARM_MS) return;
    setPending(true);
    setError(null);
    let message: string | null;
    try {
      message = await props.onRemove();
    } catch {
      message = "Couldn't remove. Try again.";
    }
    // On success the caller unmounts the sheet.
    if (message) {
      setError(message);
      setConfirming(false);
      setPending(false);
    }
  }

  async function save() {
    if (rating === null || pending) return;
    setPending(true);
    setError(null);
    let message: string | null;
    try {
      message = await props.onSave(rating, review);
    } catch {
      // onSave should resolve with its own words. This is the backstop for a throw.
      message = "Couldn't save. Try again.";
    }
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
      {/* Inert behind the removal's confirmation, so VoiceOver and the keyboard can't reach Save or Cancel there. */}
      <header
        inert={confirming}
        className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-hairline px-2 pt-[env(safe-area-inset-top)]">
        {/* Disabled while saving: the save can't be called back, so Cancel would hide its result. */}
        <button
          type="button"
          onClick={props.onCancel}
          disabled={pending}
          className="h-14 justify-self-start px-3 text-accent disabled:text-muted"
        >
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

      <div
        inert={confirming}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
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

        {props.onRemove && (
          // Set well apart from Save and the stars, and it only opens a confirmation: removing takes two
          // deliberate taps (issue 43).
          <button
            ref={triggerRef}
            type="button"
            onClick={openConfirm}
            disabled={pending}
            className="mx-auto mt-12 block h-11 px-4 text-sm font-medium text-red-400 disabled:text-muted"
          >
            Remove rating and review
          </button>
        )}
      </div>

      {confirming && (
        <div className="fixed inset-0 z-10 flex flex-col justify-end bg-black/60" onClick={closeConfirm}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="remove-rating-heading"
            aria-describedby="remove-rating-body"
            onClick={(e) => e.stopPropagation()}
            className="sheet-in rounded-t-3xl bg-surface px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
          >
            <h3 id="remove-rating-heading" className="text-center text-base font-semibold">
              Remove rating and review?
            </h3>
            <p id="remove-rating-body" className="mt-2 px-2 text-center text-sm text-muted">
              Your stars and review for {props.title} will be deleted, and it leaves your Seen list.
            </p>
            {/* Keep comes first, nearer the trigger, and Remove sits last, at the bottom edge. Layout alone can't keep
                Remove out from under the trigger on every phone, so Remove also ignores taps for REMOVE_ARM_MS. */}
            <div className="mt-5 flex flex-col gap-2">
              <button
                ref={keepRef}
                type="button"
                onClick={closeConfirm}
                disabled={pending}
                className="h-14 rounded-2xl bg-surface-raised font-semibold text-accent disabled:text-muted"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={pending}
                className="h-14 rounded-2xl bg-surface-raised font-semibold text-red-400 disabled:text-muted"
              >
                {pending ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
