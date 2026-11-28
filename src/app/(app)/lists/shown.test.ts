import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { DEFAULT_FILTER_CHOICE, type FilterChoice } from "@/core/filters";
import { encodeCursor, updatedSortKey } from "@/core/library/list";
import type { ActionOutcome, TitleRecord } from "@/core/library/types";
import type { ListRow } from "@/core/lists";
import type { ListStatus, TitleStatus } from "@/core/types";
import {
  applyTitleChange,
  finishSave,
  getLiveReload,
  getShown,
  placeTitle,
  rowAsRecord,
  SAVE_REPLAY_MS,
  savesStartedCount,
  seedShown,
  setLiveReload,
  setShown,
  showMoved,
  startSave,
  withSaves,
  type Lists,
} from "./shown";

// The module keeps its rows for the life of the page, so each test starts them over as its own user.
let users = 0;
const newUser = () => `user-${++users}`;

const NONE: FilterChoice = { ...DEFAULT_FILTER_CHOICE, genres: [] };
const SERIES: FilterChoice = { ...NONE, type: "tv" };

const FIGHT_CLUB = { mediaType: "movie", tmdbId: 550 } as const;
const OTHER_MOVIE = { mediaType: "movie", tmdbId: 13 } as const;
const A_SERIES = { mediaType: "tv", tmdbId: 1399 } as const;

const at = (day: number) => new Date(Date.UTC(2026, 10, day));
const NOW = new Date("2026-11-25T10:00:00Z");

function row(ref: { mediaType: "movie" | "tv"; tmdbId: number }, status: ListStatus, day: number): ListRow {
  return {
    ...ref,
    status,
    rating: status === "seen" ? 8 : null,
    review: null,
    updatedAt: at(day),
    title: `Title ${ref.tmdbId}`,
    year: 1999,
    posterUrl: `https://img/${ref.tmdbId}.jpg`,
  };
}

function record(
  ref: { mediaType: "movie" | "tv"; tmdbId: number },
  status: TitleStatus,
  updatedAt: Date = NOW,
): TitleRecord {
  return {
    ...ref,
    status,
    rating: status === "seen" ? 8 : null,
    review: null,
    reviewVisibility: "private",
    skipUntil: status === "skipped" ? NOW : null,
    createdAt: at(1),
    updatedAt,
  };
}

const empty = () => ({ rows: [], nextCursor: null });
const keys = (lists: Lists, status: ListStatus) => lists[status].rows.map((r) => `${r.mediaType}:${r.tmdbId}`);
const shownLists = () => getShown()!.lists;

/** No filters: Fight Club on Passed, another movie on the Watchlist. */
function seedNoFilters(userId: string) {
  seedShown(`render-${userId}`, {
    userId,
    filters: NONE,
    lists: {
      watchlist: { rows: [row(OTHER_MOVIE, "watchlist", 10)], nextCursor: null },
      seen: empty(),
      passed: { rows: [row(FIGHT_CLUB, "passed", 5)], nextCursor: null },
    },
  });
}

describe("a row a card dropped (issue 121)", () => {
  test("comes back on Undo under the filters it was dropped under", () => {
    const userId = newUser();
    seedNoFilters(userId);
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "skipped"))).toBe(true);
    expect(keys(shownLists(), "passed")).toEqual([]);

    // The card's Undo restores the Passed row as it was.
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "passed", at(5)))).toBe(true);
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(shownLists().passed.rows[0].title).toBe("Title 550");
  });

  test("does not come back under filters that exclude it: the issue's walk", () => {
    const userId = newUser();
    seedNoFilters(userId);
    // Passed > Fight Club's card > Skip.
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "skipped"))).toBe(true);
    // Back > Filters, Type: Series > Done. The filter load replaces the rows.
    setShown({
      userId,
      filters: SERIES,
      lists: { watchlist: { rows: [row(A_SERIES, "watchlist", 9)], nextCursor: null }, seen: empty(), passed: empty() },
    });
    // Search > Fight Club's card > Watchlist. The kept rows can't take it, so the card reads the server instead.
    const before = shownLists();
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "watchlist"))).toBe(false);
    expect(shownLists()).toBe(before);
    expect(keys(shownLists(), "watchlist")).toEqual(["tv:1399"]);
  });

  test("comes back once the kept rows have its filters again", () => {
    const userId = newUser();
    seedNoFilters(userId);
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "skipped"))).toBe(true);
    setShown({ userId, filters: SERIES, lists: { watchlist: empty(), seen: empty(), passed: empty() } });
    // Clear filters: a fresh load with no filters, without Fight Club (it is skipped on the server).
    setShown({
      userId,
      filters: NONE,
      lists: { watchlist: { rows: [row(OTHER_MOVIE, "watchlist", 10)], nextCursor: null }, seen: empty(), passed: empty() },
    });
    expect(applyTitleChange(FIGHT_CLUB, record(FIGHT_CLUB, "watchlist"))).toBe(true);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:550", "movie:13"]);
  });

  test("a title the rows show still moves under a filter", () => {
    const userId = newUser();
    seedShown(`render-${userId}`, {
      userId,
      filters: SERIES,
      lists: { watchlist: empty(), seen: empty(), passed: { rows: [row(A_SERIES, "passed", 5)], nextCursor: null } },
    });
    expect(applyTitleChange(A_SERIES, record(A_SERIES, "watchlist"))).toBe(true);
    expect(keys(shownLists(), "watchlist")).toEqual(["tv:1399"]);
    expect(keys(shownLists(), "passed")).toEqual([]);
  });

  test("dropped under one filter, it comes back under the same filter", () => {
    const userId = newUser();
    seedShown(`render-${userId}`, {
      userId,
      filters: SERIES,
      lists: { watchlist: empty(), seen: empty(), passed: { rows: [row(A_SERIES, "passed", 5)], nextCursor: null } },
    });
    expect(applyTitleChange(A_SERIES, record(A_SERIES, "skipped"))).toBe(true);
    expect(applyTitleChange(A_SERIES, record(A_SERIES, "passed", at(5)))).toBe(true);
    expect(keys(shownLists(), "passed")).toEqual(["tv:1399"]);
  });
});

describe("a fresh render and the Lists saves it may be older than (issues 137 and 98)", () => {
  afterEach(() => setSystemTime());

  /** The lists as the server read them before Fight Club's move: on Passed since day 5. */
  const readBefore = (): Lists => ({
    watchlist: { rows: [row(OTHER_MOVIE, "watchlist", 10)], nextCursor: null },
    seen: { rows: [row(A_SERIES, "seen", 3)], nextCursor: null },
    passed: { rows: [row(FIGHT_CLUB, "passed", 5)], nextCursor: null },
  });
  /** The screen's + Watchlist, as it shows it before the save answers. */
  const move = (l: Lists): Lists =>
    l.passed.rows.some((r) => r.tmdbId === FIGHT_CLUB.tmdbId)
      ? {
          ...l,
          passed: { ...l.passed, rows: l.passed.rows.filter((r) => r.tmdbId !== FIGHT_CLUB.tmdbId) },
          watchlist: { ...l.watchlist, rows: [{ ...row(FIGHT_CLUB, "watchlist", 5) }, ...l.watchlist.rows] },
        }
      : l;
  const moved: ActionOutcome = { previous: record(FIGHT_CLUB, "passed", at(5)), current: record(FIGHT_CLUB, "watchlist") };
  const undone: ActionOutcome = { previous: moved.current, current: moved.previous };
  let renders = 0;
  const seed = (userId: string, lists: Lists) => seedShown(`fresh-${++renders}`, { userId, filters: NONE, lists });

  test("a save under way shows on a fresh render that read before it (issue 137)", () => {
    const userId = newUser();
    seed(userId, readBefore());
    startSave(userId, FIGHT_CLUB, move);
    seed(userId, readBefore());
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:550", "movie:13"]);
    expect(keys(shownLists(), "passed")).toEqual([]);
  });

  test("a save that answered shows on a fresh render that read before it (issue 98, item 1)", () => {
    const userId = newUser();
    seed(userId, readBefore());
    const save = startSave(userId, FIGHT_CLUB, move);
    finishSave(save, moved);
    seed(userId, readBefore());
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:550", "movie:13"]);
    expect(keys(shownLists(), "passed")).toEqual([]);
    // With the time the server saved, so an Undo or an Edit opened from here works from the row the server holds.
    expect(shownLists().watchlist.rows[0].updatedAt).toEqual(NOW);
  });

  test("the first paint of a fresh render already shows the save (withSaves)", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    expect(keys(withSaves(userId, readBefore()), "watchlist")).toEqual(["movie:550", "movie:13"]);
  });

  test("a render that read after the save keeps its rows", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    const readAfter: Lists = {
      ...readBefore(),
      watchlist: { rows: [{ ...row(FIGHT_CLUB, "watchlist", 5), updatedAt: NOW }, row(OTHER_MOVIE, "watchlist", 10)], nextCursor: null },
      passed: empty(),
    };
    seed(userId, readAfter);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:550", "movie:13"]);
    expect(keys(shownLists(), "passed")).toEqual([]);
  });

  test("a render that shows the title changed elsewhere since keeps its rows", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    // Another device then rated it: Seen, newer than the save.
    const later = new Date(NOW.getTime() + 60_000);
    const changed: Lists = { ...readBefore(), seen: { rows: [{ ...row(FIGHT_CLUB, "seen", 5), updatedAt: later }], nextCursor: null }, passed: empty() };
    seed(userId, changed);
    expect(keys(shownLists(), "seen")).toEqual(["movie:550"]);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:13"]);
  });

  test("a move and its Undo replay in order to where the server is, whenever the render read", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    finishSave(startSave(userId, FIGHT_CLUB, undefined, moved), undone);
    // Read before both.
    seed(userId, readBefore());
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(shownLists().passed.rows[0].updatedAt).toEqual(at(5));
    // Read between them: on the Watchlist since the move.
    seed(userId, {
      ...readBefore(),
      watchlist: { rows: [{ ...row(FIGHT_CLUB, "watchlist", 5), updatedAt: NOW }, row(OTHER_MOVIE, "watchlist", 10)], nextCursor: null },
      passed: empty(),
    });
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:13"]);
    // Read after both: back on Passed as it was.
    seed(userId, readBefore());
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:13"]);
  });

  test("a move doesn't replay while its Undo is under way (PR 158 review)", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    const undo = startSave(userId, FIGHT_CLUB, undefined, moved);
    // Read after the Undo landed, before its answer: back on Passed, exactly as the move found it.
    seed(userId, readBefore());
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:13"]);
    // Once the Undo answers, the pair replays in order, and still ends on Passed.
    finishSave(undo, undone);
    seed(userId, readBefore());
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:13"]);
  });

  test("a move doesn't replay once its Undo failed, since the server may have taken it", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    finishSave(startSave(userId, FIGHT_CLUB, undefined, moved), null);
    seed(userId, readBefore());
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:13"]);
  });

  /** The lists that show the title. Never more than one (VISION invariant 3). */
  const listsShowing = (key: string) =>
    (["watchlist", "seen", "passed"] as const).filter((s) => keys(shownLists(), s).includes(key));
  const SEEN_AT = new Date(NOW.getTime() + 60_000);
  const markedSeen: ActionOutcome = {
    previous: moved.current,
    current: { ...record(FIGHT_CLUB, "seen", SEEN_AT), review: "Seen review." },
  };
  const seenUndone: ActionOutcome = { previous: markedSeen.current, current: moved.current };

  test("a move still replays while a later edit on the title is under way: one list only (PR 158 re-check)", () => {
    const userId = newUser();
    seed(userId, readBefore());
    const moving = startSave(userId, FIGHT_CLUB, move);
    // Seen it on the moved row, after Back, before the move answers (issue 156's live button).
    const seeing = startSave(userId, FIGHT_CLUB);
    finishSave(moving, moved);
    // A render read before the move arrives while Seen it is under way: the server holds the Watchlist.
    seed(userId, readBefore());
    expect(listsShowing("movie:550")).toEqual(["watchlist"]);
    // Seen it answers: a render read before both shows the title on Seen only.
    finishSave(seeing, markedSeen);
    seed(userId, readBefore());
    expect(listsShowing("movie:550")).toEqual(["seen"]);
    expect(shownLists().seen.rows.find((r) => r.tmdbId === 550)).toMatchObject({ rating: 8, review: "Seen review." });
  });

  test("+ Watchlist and Seen it answered, Seen it's Undo under way: one list only", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    finishSave(startSave(userId, FIGHT_CLUB), markedSeen);
    const undo = startSave(userId, FIGHT_CLUB, undefined, markedSeen);
    // Read before the move: the move replays, Seen it waits for its Undo.
    seed(userId, readBefore());
    expect(listsShowing("movie:550")).toEqual(["watchlist"]);
    // Read after Seen it, before its Undo landed: the render's own row stands.
    seed(userId, { ...readBefore(), passed: empty(), seen: { rows: [...readBefore().seen.rows, { ...row(FIGHT_CLUB, "seen", 5), updatedAt: SEEN_AT, review: "Seen review." }], nextCursor: null } });
    expect(listsShowing("movie:550")).toEqual(["seen"]);
    // The Undo answers: every render ends on the Watchlist, where the server is.
    finishSave(undo, seenUndone);
    seed(userId, readBefore());
    expect(listsShowing("movie:550")).toEqual(["watchlist"]);
  });

  test("a later edit that fails doesn't forget the save before it", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    finishSave(startSave(userId, FIGHT_CLUB), null);
    seed(userId, readBefore());
    expect(listsShowing("movie:550")).toEqual(["watchlist"]);
  });

  test("a later save on another title doesn't stop a save from replaying", () => {
    const userId = newUser();
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    startSave(userId, A_SERIES);
    finishSave(startSave(userId, OTHER_MOVIE), null);
    seed(userId, readBefore());
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:550", "movie:13"]);
    expect(keys(shownLists(), "passed")).toEqual([]);
  });

  test("a save that failed doesn't show", () => {
    const userId = newUser();
    seed(userId, readBefore());
    const save = startSave(userId, FIGHT_CLUB, move);
    finishSave(save, null);
    seed(userId, readBefore());
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:13"]);
  });

  test("an edit replays in place, with its rating and review", () => {
    const userId = newUser();
    seed(userId, readBefore());
    const edited: ActionOutcome = {
      previous: record(A_SERIES, "seen", at(3)),
      current: { ...record(A_SERIES, "seen"), rating: 6.5, review: "Edited." },
    };
    finishSave(startSave(userId, A_SERIES), edited);
    seed(userId, readBefore());
    expect(shownLists().seen.rows).toHaveLength(1);
    expect(shownLists().seen.rows[0]).toMatchObject({ tmdbId: 1399, rating: 6.5, review: "Edited.", title: "Title 1399" });
  });

  test(`an answered save is kept ${SAVE_REPLAY_MS / 1000} s, then forgotten`, () => {
    const userId = newUser();
    setSystemTime(new Date("2026-11-26T10:00:00Z"));
    seed(userId, readBefore());
    finishSave(startSave(userId, FIGHT_CLUB, move), moved);
    setSystemTime(new Date(Date.UTC(2026, 10, 26, 10, 0, 0) + SAVE_REPLAY_MS - 1000));
    seed(userId, readBefore());
    expect(keys(shownLists(), "passed")).toEqual([]);
    setSystemTime(new Date(Date.UTC(2026, 10, 26, 10, 0, 0) + SAVE_REPLAY_MS + 1000));
    seed(userId, readBefore());
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
  });

  test("another user's saves don't show", () => {
    const userId = newUser();
    seed(userId, readBefore());
    startSave(userId, FIGHT_CLUB, move);
    const other = newUser();
    seed(other, readBefore());
    expect(keys(shownLists(), "passed")).toEqual(["movie:550"]);
  });

  test("every save started counts, so a reload can tell one started during its read", () => {
    const before = savesStartedCount();
    startSave(newUser(), FIGHT_CLUB);
    expect(savesStartedCount()).toBe(before + 1);
  });
});

describe("the Lists screen on screen now (issue 98, item 2)", () => {
  test("a screen that unmounts after a newer one mounted leaves the newer one registered", () => {
    const calls: string[] = [];
    const older = () => calls.push("older");
    const newer = () => calls.push("newer");
    const unregisterOlder = setLiveReload(older);
    const unregisterNewer = setLiveReload(newer);
    unregisterOlder();
    getLiveReload()?.();
    expect(calls).toEqual(["newer"]);
    unregisterNewer();
    expect(getLiveReload()).toBeNull();
  });
});

describe("one placement rule for a changed row (issue 119)", () => {
  afterEach(() => setSystemTime());

  const DARK_KNIGHT = { mediaType: "movie", tmdbId: 155 } as const;
  const MATRIX = { mediaType: "movie", tmdbId: 603 } as const;
  type Ref = { mediaType: "movie" | "tv"; tmdbId: number };
  /** Watchlist: the other movie (day 10), Fight Club (day 8), The Dark Knight (day 6). Seen: a series. Passed: The Matrix. */
  const lists = (): Lists => ({
    watchlist: {
      rows: [row(OTHER_MOVIE, "watchlist", 10), row(FIGHT_CLUB, "watchlist", 8), row(DARK_KNIGHT, "watchlist", 6)],
      nextCursor: null,
    },
    seen: { rows: [{ ...row(A_SERIES, "seen", 3), rating: 6.5, review: "Slow start." }], nextCursor: null },
    passed: { rows: [row(MATRIX, "passed", 4)], nextCursor: null },
  });
  let renders = 0;
  const seed = (userId: string, l: Lists = lists()) =>
    seedShown(`placement-${++renders}`, { userId, filters: NONE, lists: l });
  const seen = (ref: Ref, rating: number, review: string | null, updatedAt = NOW): TitleRecord => ({
    ...record(ref, "seen", updatedAt),
    rating,
    review,
  });
  const actedOn = (ref: Ref, status: ListStatus, day: number) => ({ row: row(ref, status, day), filters: NONE });
  const listsWith = (l: Lists, key: string) =>
    (["watchlist", "seen", "passed"] as const).filter((s) => l[s].rows.some((r) => `${r.mediaType}:${r.tmdbId}` === key));

  test("a change lands in the same place made on Lists or on a title card", () => {
    const changes: [Ref, TitleRecord][] = [
      [FIGHT_CLUB, seen(FIGHT_CLUB, 8, "Great.")],
      [A_SERIES, seen(A_SERIES, 9, "Better later.")],
      [MATRIX, record(MATRIX, "watchlist")],
      [FIGHT_CLUB, record(FIGHT_CLUB, "passed", at(7))],
    ];
    for (const [ref, rec] of changes) {
      seed(newUser());
      placeTitle(ref, rec, { row: row(ref, "watchlist", 1), filters: NONE });
      const fromLists = shownLists();
      seed(newUser());
      applyTitleChange(ref, rec);
      expect(shownLists()).toEqual(fromLists);
    }
  });

  test("Seen it lands on top of Seen, and its Undo puts the row back where its time sorts it (issue 38, item 4)", () => {
    seed(newUser());
    const marked: ActionOutcome = { previous: record(FIGHT_CLUB, "watchlist", at(8)), current: seen(FIGHT_CLUB, 8, "Great.") };
    placeTitle(FIGHT_CLUB, marked.current, actedOn(FIGHT_CLUB, "watchlist", 8));
    expect(keys(shownLists(), "seen")).toEqual(["movie:550", "tv:1399"]);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:13", "movie:155"]);
    // Meanwhile a title card puts The Matrix on top of the Watchlist, so the row's old index (1) is wrong now.
    applyTitleChange(MATRIX, record(MATRIX, "watchlist"));
    // The Undo answers with the row it restored.
    placeTitle(FIGHT_CLUB, marked.previous, actedOn(FIGHT_CLUB, "watchlist", 8));
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:603", "movie:13", "movie:550", "movie:155"]);
    expect(keys(shownLists(), "seen")).toEqual(["tv:1399"]);
  });

  test("an Edit stays in place, and its Undo brings the rating and review back exactly", () => {
    seed(newUser(), {
      ...lists(),
      seen: {
        rows: [
          { ...row(DARK_KNIGHT, "seen", 9), rating: 7 },
          { ...row(A_SERIES, "seen", 3), rating: 6.5, review: 'Slow start, "then" great.\nÉté.' },
        ],
        nextCursor: null,
      },
    });
    const before = shownLists().seen.rows[1];
    const edited: ActionOutcome = { previous: seen(A_SERIES, 6.5, before.review, at(3)), current: seen(A_SERIES, 9.5, "Changed.") };
    placeTitle(A_SERIES, edited.current, { row: before, filters: NONE });
    expect(keys(shownLists(), "seen")).toEqual(["movie:155", "tv:1399"]);
    expect(shownLists().seen.rows[1]).toMatchObject({ rating: 9.5, review: "Changed." });
    placeTitle(A_SERIES, edited.previous, { row: before, filters: NONE });
    expect(shownLists().seen.rows[1]).toEqual(before);
  });

  test("+ Watchlist shows on top before it answers, even with the phone's clock behind the server's", () => {
    seed(newUser());
    // The phone's clock reads day 2, earlier than every row these lists show.
    setSystemTime(at(2));
    const l = showMoved(shownLists(), row(MATRIX, "passed", 4), "watchlist");
    expect(keys(l, "watchlist")).toEqual(["movie:603", "movie:13", "movie:550", "movie:155"]);
    expect(keys(l, "passed")).toEqual([]);
    setShown({ ...getShown()!, lists: l });
    // The save answers with the server's time: in place, still on top.
    placeTitle(MATRIX, record(MATRIX, "watchlist"), actedOn(MATRIX, "passed", 4));
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:603", "movie:13", "movie:550", "movie:155"]);
    expect(shownLists().watchlist.rows[0].updatedAt).toEqual(NOW);
  });

  test("+ Watchlist with the phone's clock ahead of the server's: a change stamped meanwhile sorts above it (PR 177 review)", () => {
    seed(newUser());
    // The phone's clock reads a year ahead of the server's.
    setSystemTime(new Date("2027-11-25T10:00:00Z"));
    setShown({ ...getShown()!, lists: showMoved(shownLists(), row(MATRIX, "passed", 4), "watchlist") });
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:603", "movie:13", "movie:550", "movie:155"]);
    // While its save is under way, a title card puts the series on the Watchlist, stamped by the server later.
    applyTitleChange(A_SERIES, record(A_SERIES, "watchlist", NOW));
    expect(keys(shownLists(), "watchlist")).toEqual(["tv:1399", "movie:603", "movie:13", "movie:550", "movie:155"]);
    // The Matrix's save answers with the earlier server time: it stays below the series, as a reload shows them.
    placeTitle(MATRIX, record(MATRIX, "watchlist", new Date("2026-11-25T09:59:00Z")), actedOn(MATRIX, "passed", 4));
    expect(keys(shownLists(), "watchlist")).toEqual(["tv:1399", "movie:603", "movie:13", "movie:550", "movie:155"]);
  });

  test("a fresh render replays the screen's real + Watchlist through the same rule", () => {
    const userId = newUser();
    const tapped = row(MATRIX, "passed", 4);
    // The screen's `move`, as lists-screen passes it to write() as showUnderWay.
    const move = (l: Lists) => (l.passed.rows.some((r) => r.tmdbId === MATRIX.tmdbId) ? showMoved(l, tapped, "watchlist") : l);
    const moved: ActionOutcome = { previous: record(MATRIX, "passed", at(4)), current: record(MATRIX, "watchlist") };
    const watchlistAfter = ["movie:603", "movie:13", "movie:550", "movie:155"];
    seed(userId);
    // Under way: a render read before the save shows the move, on the Watchlist only.
    const save = startSave(userId, MATRIX, move);
    seed(userId);
    expect(keys(shownLists(), "watchlist")).toEqual(watchlistAfter);
    expect(listsWith(shownLists(), "movie:603")).toEqual(["watchlist"]);
    // Answered: the same, with the server's time.
    finishSave(save, moved);
    seed(userId);
    expect(keys(shownLists(), "watchlist")).toEqual(watchlistAfter);
    expect(listsWith(shownLists(), "movie:603")).toEqual(["watchlist"]);
    expect(shownLists().watchlist.rows[0].updatedAt).toEqual(NOW);
    // Its Undo under way: the move waits, so a render read before the move shows the title on Passed only.
    const undo = startSave(userId, MATRIX, undefined, moved);
    seed(userId);
    expect(listsWith(shownLists(), "movie:603")).toEqual(["passed"]);
    // The Undo answered: a render read before the move ends on Passed too, where it was.
    finishSave(undo, { previous: moved.current, current: moved.previous });
    seed(userId);
    expect(keys(shownLists(), "passed")).toEqual(["movie:603"]);
    expect(listsWith(shownLists(), "movie:603")).toEqual(["passed"]);
  });

  test("a failed + Watchlist goes back where it was on Passed", () => {
    seed(newUser(), {
      ...lists(),
      watchlist: empty(),
      passed: { rows: [row(OTHER_MOVIE, "passed", 7), row(MATRIX, "passed", 4), row(DARK_KNIGHT, "passed", 2)], nextCursor: null },
    });
    const tapped = shownLists().passed.rows[1];
    setShown({ ...getShown()!, lists: showMoved(shownLists(), tapped, "watchlist") });
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:603"]);
    placeTitle(MATRIX, rowAsRecord(tapped), { row: tapped, filters: NONE });
    expect(keys(shownLists(), "passed")).toEqual(["movie:13", "movie:603", "movie:155"]);
    expect(shownLists().passed.rows[1]).toEqual(tapped);
    expect(keys(shownLists(), "watchlist")).toEqual([]);
  });

  test("a save answered after the rows started over shows the title on one list only", () => {
    seed(newUser());
    // The rows started over from a read that still shows The Matrix on Passed.
    setShown({ ...getShown()!, lists: lists() });
    placeTitle(MATRIX, record(MATRIX, "watchlist"), actedOn(MATRIX, "passed", 4));
    expect(listsWith(shownLists(), "movie:603")).toEqual(["watchlist"]);
    expect(keys(shownLists(), "watchlist")[0]).toBe("movie:603");
  });

  test("rows that no longer show the title take it back only under the filters it was shown under (issues 121, 155)", () => {
    const userId = newUser();
    seed(userId);
    const tapped = actedOn(MATRIX, "passed", 4);
    // Filters > Type: Series > Done while the save was under way: the rows are the Series ones now.
    setShown({ userId, filters: SERIES, lists: { watchlist: empty(), seen: empty(), passed: empty() } });
    const before = shownLists();
    placeTitle(MATRIX, record(MATRIX, "watchlist"), tapped);
    expect(shownLists()).toBe(before);
    // Under the filters it was shown under, it comes back.
    setShown({ userId, filters: NONE, lists: { watchlist: empty(), seen: empty(), passed: empty() } });
    placeTitle(MATRIX, record(MATRIX, "watchlist"), tapped);
    expect(keys(shownLists(), "watchlist")).toEqual(["movie:603"]);
  });

  test("a row that sorts past the list's cursor is left to Show more", () => {
    const last = row(OTHER_MOVIE, "passed", 10);
    seed(newUser(), {
      watchlist: { rows: [row(MATRIX, "watchlist", 12)], nextCursor: null },
      seen: empty(),
      passed: { rows: [last], nextCursor: encodeCursor({ sort: "updated_desc", values: updatedSortKey(last) }) },
    });
    // The Matrix had been on Passed since day 1, past the first page, before + Watchlist. Its Undo restores that.
    placeTitle(MATRIX, record(MATRIX, "passed", at(1)), actedOn(MATRIX, "passed", 1));
    expect(keys(shownLists(), "passed")).toEqual(["movie:13"]);
    expect(listsWith(shownLists(), "movie:603")).toEqual([]);
  });
});
