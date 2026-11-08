import { describe, expect, test } from "bun:test";
import type { TitleRecord } from "../library/types";
import type { ListStatus, TitleStatus } from "../types";
import { applyTitleRecord } from "./apply-record";
import type { ListRow } from "./lists";

/** When row `tmdbId` last changed in the fixture: a lower id is newer, so each list below is in list order. */
const at = (tmdbId: number) => new Date(Date.UTC(2026, 10, 20 - tmdbId));
/** A change made now, newer than every row. */
const NOW = new Date("2026-11-25T10:00:00Z");
const LONG_AGO = new Date("2026-10-01T10:00:00Z");

function row(tmdbId: number, status: ListStatus, extra: Partial<ListRow> = {}): ListRow {
  return {
    mediaType: "movie",
    tmdbId,
    status,
    rating: status === "seen" ? 3 : null,
    review: null,
    updatedAt: at(tmdbId),
    title: `Title ${tmdbId}`,
    year: 2000,
    posterUrl: `https://img/${tmdbId}.jpg`,
    ...extra,
  };
}

function record(tmdbId: number, status: TitleStatus, extra: Partial<TitleRecord> = {}): TitleRecord {
  return {
    mediaType: "movie",
    tmdbId,
    status,
    rating: status === "seen" ? 4 : null,
    review: null,
    reviewVisibility: "private",
    skipUntil: status === "skipped" ? NOW : null,
    createdAt: LONG_AGO,
    updatedAt: NOW,
    ...extra,
  };
}

type Lists = Record<ListStatus, { rows: ListRow[]; nextCursor: string | null }>;

function lists(): Lists {
  return {
    watchlist: { rows: [row(1, "watchlist"), row(2, "watchlist")], nextCursor: "w" },
    seen: { rows: [row(3, "seen"), row(4, "seen", { review: "Old review." })], nextCursor: null },
    passed: { rows: [row(5, "passed"), row(6, "passed")], nextCursor: "p" },
  };
}

const ids = (l: Lists, status: ListStatus) => l[status].rows.map((r) => r.tmdbId);
const ref = (tmdbId: number) => ({ mediaType: "movie" as const, tmdbId });

describe("applyTitleRecord", () => {
  test("an edit on the same list replaces the row in place, keeping its title and poster", () => {
    const out = applyTitleRecord(lists(), ref(4), record(4, "seen", { rating: 5, review: "New review." }));
    expect(ids(out, "seen")).toEqual([3, 4]);
    expect(out.seen.rows[1]).toEqual({ ...row(4, "seen"), rating: 5, review: "New review.", updatedAt: NOW });
  });

  test("a move puts the row at the top of its new list and keeps each list's cursor", () => {
    const out = applyTitleRecord(lists(), ref(6), record(6, "watchlist"));
    expect(ids(out, "passed")).toEqual([5]);
    expect(ids(out, "watchlist")).toEqual([6, 1, 2]);
    expect(out.watchlist.rows[0]).toMatchObject({ status: "watchlist", rating: null, title: "Title 6", updatedAt: NOW });
    expect(out.watchlist.nextCursor).toBe("w");
    expect(out.passed.nextCursor).toBe("p");
  });

  test("Seen carries the rating and review to the Seen list", () => {
    const out = applyTitleRecord(lists(), ref(2), record(2, "seen", { rating: 4.5, review: "Loved it." }));
    expect(ids(out, "watchlist")).toEqual([1]);
    expect(out.seen.rows[0]).toMatchObject({ tmdbId: 2, status: "seen", rating: 4.5, review: "Loved it." });
  });

  test("an Undo puts a moved row back where it was, from the earlier time it restores", () => {
    const moved = applyTitleRecord(lists(), ref(5), record(5, "watchlist"));
    expect(ids(moved, "watchlist")).toEqual([5, 1, 2]);
    const undone = applyTitleRecord(moved, ref(5), record(5, "passed", { updatedAt: at(5) }));
    expect(ids(undone, "watchlist")).toEqual([1, 2]);
    expect(ids(undone, "passed")).toEqual([5, 6]);
    expect(undone.passed.rows[0]).toEqual(row(5, "passed"));
  });

  test("an Undo of an edit applies though its time is older than the row's", () => {
    const edited = applyTitleRecord(lists(), ref(4), record(4, "seen", { rating: 5, review: "New review." }));
    const undone = applyTitleRecord(edited, ref(4), record(4, "seen", { rating: 3, review: "Old review.", updatedAt: at(4) }));
    expect(undone.seen.rows[1]).toEqual(row(4, "seen", { review: "Old review." }));
  });

  test("a row whose place is past the loaded rows waits for Show more, or ends a list with no more pages", () => {
    const later = applyTitleRecord(lists(), ref(3), record(3, "passed", { updatedAt: LONG_AGO }));
    expect(ids(later, "seen")).toEqual([4]);
    expect(ids(later, "passed")).toEqual([5, 6]);
    const last = applyTitleRecord(lists(), ref(1), record(1, "seen", { updatedAt: LONG_AGO }));
    expect(ids(last, "seen")).toEqual([3, 4, 1]);
  });

  test("equal times fall back to the identity order the server uses", () => {
    const base = lists();
    base.passed.rows = [5, 6, 7].map((id) => row(id, "passed", { updatedAt: NOW }));
    const out = applyTitleRecord(base, ref(6), record(6, "watchlist"));
    expect(ids(out, "passed")).toEqual([5, 7]);
    const back = applyTitleRecord(out, ref(6), record(6, "passed"));
    expect(ids(back, "passed")).toEqual([5, 6, 7]);
  });

  test("a skip or a removed row takes the title off the lists", () => {
    expect(ids(applyTitleRecord(lists(), ref(1), record(1, "skipped")), "watchlist")).toEqual([2]);
    const gone = applyTitleRecord(lists(), ref(3), null);
    expect(ids(gone, "seen")).toEqual([4]);
  });

  test("a title the lists don't show changes nothing", () => {
    const before = lists();
    expect(applyTitleRecord(before, ref(99), record(99, "watchlist"))).toBe(before);
    expect(applyTitleRecord(before, { mediaType: "tv", tmdbId: 1 }, null)).toBe(before);
  });

  test("leaves the lists it was given untouched", () => {
    const before = lists();
    const copy = structuredClone(before);
    applyTitleRecord(before, ref(6), record(6, "watchlist"));
    expect(before).toEqual(copy);
  });
});
