// Words for a rating sheet's save refused because the title changed elsewhere, shared by the card's Seen it and
// the Lists tab, so the same refusal reads the same on both (issues 74 and 79). A plain module, not a server action
// file: a "use server" file may export only async functions.

/** A title marked Seen on another device while a card or a sheet was open. */
export const ALREADY_SEEN = "you already marked this Seen somewhere else";

/** Seen it, or Watchlist to Seen, refused because the title is Seen already. */
export const STALE_SEEN = `Not saved: ${ALREADY_SEEN}, and the rating there stays.`;

/** Added when the sheet holds a review the user typed, so it is still there to copy. */
export const COPY_REVIEW = "Copy your review if you want to keep it.";
