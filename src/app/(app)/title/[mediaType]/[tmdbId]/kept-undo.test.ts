import { describe, expect, test } from "bun:test";
import { undoAfterFailedTap } from "./kept-undo";

// A Remove rating's outcome: its Undo is the only way back to this rating and review.
const outcome = {
  previous: {
    mediaType: "movie",
    tmdbId: 603,
    status: "seen",
    rating: 8.5,
    review: "Écoute: still great.\nSecond line.",
    reviewVisibility: "private",
    skipUntil: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
    updatedAt: new Date("2026-10-03T08:30:15.123Z"),
  },
  current: null,
};
const kept = { id: 7, message: "Rating removed", outcome };
const next = () => 8;

describe("undoAfterFailedTap", () => {
  test("a failed save: the Undo that was up comes back as a new toast holding the very same outcome", () => {
    const back = undoAfterFailedTap(kept, { stale: false }, next);
    expect(back).toEqual({ id: 8, message: "Rating removed", outcome });
    // The same object, not a copy: nothing about what the Undo restores can have changed.
    expect(back?.outcome).toBe(outcome);
    expect(kept.id).toBe(7);
  });

  test("a failure with no stale flag (no connection, signed out) counts as a failed save", () => {
    expect(undoAfterFailedTap(kept, {}, next)?.id).toBe(8);
  });

  test("a stale refusal: nothing comes back, since the title changed elsewhere", () => {
    expect(undoAfterFailedTap(kept, { stale: true }, next)).toBeNull();
  });

  test("no Undo was up at the tap: none appears, and no id is used", () => {
    let used = 0;
    expect(undoAfterFailedTap(null, {}, () => ++used)).toBeNull();
    expect(undoAfterFailedTap(null, { stale: true }, () => ++used)).toBeNull();
    expect(used).toBe(0);
  });
});
