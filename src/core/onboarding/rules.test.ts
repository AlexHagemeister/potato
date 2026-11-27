import { describe, expect, test } from "bun:test";
import { INSTALL_SEEN_KEY, type SeenStorage } from "../install/guide";
import {
  advance,
  currentHint,
  doneKey,
  FIRST_PROGRESS,
  HINTS,
  isNewAccount,
  isQuiet,
  nextQuietSince,
  parseProgress,
  progressKey,
  QUIET_MS_BEFORE_INSTALL,
  QUIET_MS_BEFORE_SHEET,
  quietFor,
  readDeviceRecord,
  sheetStillNeeded,
  SORTS_BEFORE_SHEET,
  startingProgress,
  startSortTracker,
  trackSorts,
  writeDone,
  writeProgress,
  type Progress,
  type ScreenFacts,
  type SortSignals,
} from "./rules";

class MemoryStorage implements SeenStorage {
  map = new Map<string, string>();
  refuseWrites = false;
  throwOnRead = false;
  getItem(key: string) {
    if (this.throwOnRead) throw new Error("blocked");
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.refuseWrites) throw new Error("quota");
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

describe("isNewAccount", () => {
  const fresh = { titleRows: 0, country: "US", providerIds: [] };
  test("no rows and untouched settings is new", () => {
    expect(isNewAccount(fresh)).toBe(true);
  });
  test("any title row, skipped included, is not new", () => {
    expect(isNewAccount({ ...fresh, titleRows: 1 })).toBe(false);
  });
  test("saved services are not new", () => {
    expect(isNewAccount({ ...fresh, providerIds: [8] })).toBe(false);
  });
  test("a changed country is not new", () => {
    expect(isNewAccount({ ...fresh, country: "GB" })).toBe(false);
  });
});

describe("hints", () => {
  test("one per button, in the buttons' order on screen, Skip explained", () => {
    expect(HINTS.map((h) => h.label)).toEqual(["Pass", "Skip", "Watchlist", "Seen it"]);
    const skip = HINTS.find((h) => h.button === "skip")!;
    expect(skip.text).toContain("comes back");
    expect(skip.text).toContain("no list");
  });

  test("the first hint shows first", () => {
    expect(currentHint(FIRST_PROGRESS)?.button).toBe("pass");
  });

  test("a sort's tap moves on to the next hint without counting yet", () => {
    const p = advance(FIRST_PROGRESS, { kind: "tapped" });
    expect(p).toEqual({ stage: "hints", hint: 1, sorts: 0 });
    expect(currentHint(p)?.button).toBe("skip");
  });

  test("a sort that stood counts without moving the hint", () => {
    expect(advance(FIRST_PROGRESS, { kind: "settled" })).toEqual({ stage: "hints", hint: 0, sorts: 1 });
  });

  test("Got it moves on without counting a sort", () => {
    expect(advance(FIRST_PROGRESS, { kind: "next" })).toEqual({ stage: "hints", hint: 1, sorts: 0 });
  });

  test("four sorts that stood end the hints and bring the sheet", () => {
    let p: Progress = FIRST_PROGRESS;
    for (let i = 0; i < 4; i++) p = advance(advance(p, { kind: "tapped" }), { kind: "settled" });
    expect(currentHint(p)).toBeNull();
    expect(p.stage).toBe("sheet");
  });

  test("taps alone (every sort undone) never bring the sheet", () => {
    let p: Progress = FIRST_PROGRESS;
    for (let i = 0; i < 10; i++) p = advance(p, { kind: "tapped" });
    expect(currentHint(p)).toBeNull();
    expect(p.stage).toBe("hints");
    expect(p.sorts).toBe(0);
  });

  test("hiding the tips waits for the first few sorts before the sheet", () => {
    let p = advance(FIRST_PROGRESS, { kind: "hide_hints" });
    expect(currentHint(p)).toBeNull();
    expect(p.stage).toBe("hints");
    for (let i = 1; i < SORTS_BEFORE_SHEET; i++) p = advance(p, { kind: "settled" });
    expect(p.stage).toBe("hints");
    p = advance(p, { kind: "settled" });
    expect(p.stage).toBe("sheet");
  });

  test("an event that changes nothing returns the same progress", () => {
    const over: Progress = { stage: "hints", hint: HINTS.length, sorts: 0 };
    expect(advance(over, { kind: "tapped" })).toBe(over);
    expect(advance(over, { kind: "next" })).toBe(over);
    expect(advance(over, { kind: "hide_hints" })).toBe(over);
  });

  test("Got it through every hint with enough sorts brings the sheet", () => {
    let p: Progress = { stage: "hints", hint: 3, sorts: SORTS_BEFORE_SHEET };
    p = advance(p, { kind: "next" });
    expect(p.stage).toBe("sheet");
  });

  test("the sheet stage ignores further events", () => {
    const sheet: Progress = { stage: "sheet", hint: HINTS.length, sorts: 4 };
    expect(advance(sheet, { kind: "tapped" })).toBe(sheet);
    expect(advance(sheet, { kind: "settled" })).toBe(sheet);
    expect(advance(sheet, { kind: "hide_hints" })).toBe(sheet);
  });

  test("the hint index never runs past the end", () => {
    let p: Progress = FIRST_PROGRESS;
    for (let i = 0; i < 10; i++) p = advance(p, { kind: "next" });
    expect(p.hint).toBe(HINTS.length);
  });
});

describe("trackSorts", () => {
  const quietDeck: SortSignals = { toastId: null, noticeId: null, undoing: false };
  /** Feeds the signals in turn and collects the events' kinds. */
  function run(...steps: SortSignals[]): string[] {
    let tracker = startSortTracker(quietDeck);
    const kinds: string[] = [];
    for (const step of steps) {
      const out = trackSorts(tracker, step);
      tracker = out.tracker;
      kinds.push(...out.events.map((e) => e.kind));
    }
    return kinds;
  }

  test("a sort whose toast runs out stood", () => {
    expect(run({ ...quietDeck, toastId: 1 }, quietDeck)).toEqual(["tapped", "settled"]);
  });

  test("an undone sort is tapped but never stands", () => {
    expect(run({ ...quietDeck, toastId: 1 }, { ...quietDeck, undoing: true }, quietDeck)).toEqual(["tapped"]);
  });

  test("a failed save (toast gone, a new notice) never stands", () => {
    expect(run({ ...quietDeck, toastId: 1 }, { ...quietDeck, noticeId: 2 })).toEqual(["tapped"]);
  });

  test("a sort replaced by a newer one stood", () => {
    expect(run({ ...quietDeck, toastId: 1 }, { ...quietDeck, toastId: 2 }, quietDeck)).toEqual([
      "tapped",
      "settled",
      "tapped",
      "settled",
    ]);
  });

  test("an older notice still up when the toast runs out doesn't make it a failure", () => {
    const withNotice = { ...quietDeck, noticeId: 5 };
    let tracker = startSortTracker(withNotice);
    const kinds: string[] = [];
    for (const step of [{ ...withNotice, toastId: 6 }, withNotice]) {
      const out = trackSorts(tracker, step);
      tracker = out.tracker;
      kinds.push(...out.events.map((e) => e.kind));
    }
    expect(kinds).toEqual(["tapped", "settled"]);
  });

  test("a toast already up on mount is an older sort's, and isn't counted", () => {
    let tracker = startSortTracker({ ...quietDeck, toastId: 3 });
    const out = trackSorts(tracker, quietDeck);
    tracker = out.tracker;
    expect(out.events).toEqual([]);
  });

  test("three rounds of a sort and its Undo count no sorts", () => {
    const undo = { ...quietDeck, undoing: true };
    const kinds = run(
      { ...quietDeck, toastId: 1 },
      undo,
      quietDeck,
      { ...quietDeck, toastId: 2 },
      undo,
      quietDeck,
      { ...quietDeck, toastId: 3 },
      undo,
      quietDeck,
    );
    expect(kinds.filter((k) => k === "settled")).toEqual([]);
  });
});

describe("sheetStillNeeded", () => {
  test("no services saved yet: the sheet asks", () => {
    expect(sheetStillNeeded({ providerIds: [] })).toBe(true);
  });
  test("services saved elsewhere meanwhile: nothing left to ask", () => {
    expect(sheetStillNeeded({ providerIds: [8] })).toBe(false);
  });
});

describe("quiet moments", () => {
  const calm: ScreenFacts = { onDeck: true, visible: true, toast: false, undoing: false, notice: false, overlay: false };

  test("the deck with nothing up is quiet", () => {
    expect(isQuiet(calm)).toBe(true);
  });

  test("each thing that would be covered breaks the quiet", () => {
    expect(isQuiet({ ...calm, onDeck: false })).toBe(false);
    expect(isQuiet({ ...calm, visible: false })).toBe(false);
    expect(isQuiet({ ...calm, toast: true })).toBe(false);
    expect(isQuiet({ ...calm, undoing: true })).toBe(false);
    expect(isQuiet({ ...calm, notice: true })).toBe(false);
    expect(isQuiet({ ...calm, overlay: true })).toBe(false);
  });

  test("a quiet stretch starts once, ends when it breaks, and is timed from its start", () => {
    let since = nextQuietSince(null, true, 1000);
    expect(since).toBe(1000);
    since = nextQuietSince(since, true, 1400);
    expect(since).toBe(1000);
    expect(quietFor(since, 1400, QUIET_MS_BEFORE_SHEET)).toBe(false);
    expect(quietFor(since, 1000 + QUIET_MS_BEFORE_SHEET, QUIET_MS_BEFORE_SHEET)).toBe(true);
    since = nextQuietSince(since, false, 2600);
    expect(since).toBeNull();
    expect(quietFor(since, 9999, QUIET_MS_BEFORE_INSTALL)).toBe(false);
  });

  test("the sheet waits longer than the prompt after it", () => {
    expect(QUIET_MS_BEFORE_SHEET).toBeGreaterThan(QUIET_MS_BEFORE_INSTALL);
  });
});

describe("startingProgress", () => {
  test("a new account on a clean device starts", () => {
    expect(startingProgress({ isNew: true, device: { done: false, progress: null } })).toEqual(FIRST_PROGRESS);
  });
  test("an existing account on a clean device never starts", () => {
    expect(startingProgress({ isNew: false, device: { done: false, progress: null } })).toBeNull();
  });
  test("progress on the device carries on, even once the account has rows", () => {
    const progress: Progress = { stage: "hints", hint: 2, sorts: 2 };
    expect(startingProgress({ isNew: false, device: { done: false, progress } })).toEqual(progress);
  });
  test("finished on this device never starts again", () => {
    expect(startingProgress({ isNew: true, device: { done: true, progress: null } })).toBeNull();
  });
  test("storage that can't keep a mark never starts", () => {
    expect(startingProgress({ isNew: true, device: { done: null, progress: null } })).toBeNull();
  });
});

describe("the device record", () => {
  test("a clean storage reads as not done, no progress, and the probe leaves nothing", () => {
    const s = new MemoryStorage();
    expect(readDeviceRecord(s, "u1")).toEqual({ done: false, progress: null });
    expect(s.map.size).toBe(0);
  });

  test("progress round-trips, per user", () => {
    const s = new MemoryStorage();
    writeProgress(s, "u1", { stage: "hints", hint: 2, sorts: 1 });
    expect(readDeviceRecord(s, "u1").progress).toEqual({ stage: "hints", hint: 2, sorts: 1 });
    expect(readDeviceRecord(s, "u2")).toEqual({ done: false, progress: null });
  });

  test("done wins and drops the progress", () => {
    const s = new MemoryStorage();
    writeProgress(s, "u1", { stage: "sheet", hint: 4, sorts: 4 });
    expect(writeDone(s, "u1")).toBe(true);
    expect(readDeviceRecord(s, "u1")).toEqual({ done: true, progress: null });
    expect(s.map.has(progressKey("u1"))).toBe(false);
    expect(s.map.get(doneKey("u1"))).toBeDefined();
  });

  test("onboarding's mark is separate from the home-screen prompt's", () => {
    const s = new MemoryStorage();
    writeDone(s, "u1");
    expect(s.map.has(INSTALL_SEEN_KEY)).toBe(false);
    s.map.set(INSTALL_SEEN_KEY, "seen");
    expect(readDeviceRecord(s, "u2").done).toBe(false);
  });

  test("storage that reads but refuses writes reads as unusable", () => {
    const s = new MemoryStorage();
    s.refuseWrites = true;
    expect(readDeviceRecord(s, "u1")).toEqual({ done: null, progress: null });
    expect(writeDone(s, "u1")).toBe(false);
    expect(() => writeProgress(s, "u1", FIRST_PROGRESS)).not.toThrow();
  });

  test("storage that throws on read reads as unusable", () => {
    const s = new MemoryStorage();
    s.throwOnRead = true;
    expect(readDeviceRecord(s, "u1")).toEqual({ done: null, progress: null });
  });

  test("a progress value this build didn't write reads as none", () => {
    for (const raw of ["{", "null", "[]", '{"stage":"x","hint":0,"sorts":0}', '{"stage":"hints","hint":9,"sorts":0}', '{"stage":"hints","hint":1.5,"sorts":0}']) {
      expect(parseProgress(raw)).toBeNull();
    }
  });
});
