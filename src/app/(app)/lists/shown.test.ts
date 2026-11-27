import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { DEFAULT_FILTER_CHOICE, type FilterChoice } from "@/core/filters";
import type { ActionOutcome, TitleRecord } from "@/core/library/types";
import type { ListRow } from "@/core/lists";
import type { ListStatus, TitleStatus } from "@/core/types";
import {
  applyTitleChange,
  finishSave,
  getLiveReload,
  getShown,
  SAVE_REPLAY_MS,
  savesStartedCount,
  seedShown,
  setLiveReload,
  setShown,
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
