// The title card's rule for the Undo on offer when a sort is tapped (issue 44 item 1). A tap takes the Undo toast
// down at once. If the tap's save then fails, nothing changed, so that Undo is offered again: a failed tap never
// costs the Undo of the tap before it (VISION invariant 2). It matters most after Remove rating, whose Undo is
// the only way back to the rating and review.

/**
 * The toast to show after a sort's save failed: the one that was up when the sort was tapped, as a new toast (a
 * new id, so it gets a full window of its own), or null when none was.
 *
 * Not after a stale refusal: the title changed elsewhere, so core would refuse that Undo too (its compare-and-set
 * needs the row the earlier action left), and the card now shows where the title really is.
 *
 * A save that failed here may still have reached the server (a dropped connection). The Undo offered again is then
 * refused by the same compare-and-set, and changes nothing.
 */
export function undoAfterFailedTap<T extends { id: number }>(kept: T | null, failure: { stale?: boolean }, nextId: () => number): T | null {
  if (!kept || failure.stale) return null;
  return { ...kept, id: nextId() };
}
