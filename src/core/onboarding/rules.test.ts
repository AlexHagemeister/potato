import { describe, expect, test } from "bun:test";
import { INSTALL_SEEN_KEY, type SeenStorage } from "../install/guide";
import {
  advance,
  currentHint,
  doneKey,
  FIRST_PROGRESS,
  HINTS,
  isNewAccount,
  parseProgress,
  progressKey,
  readDeviceRecord,
  SORTS_BEFORE_SHEET,
  startingProgress,
  writeDone,
  writeProgress,
  type Progress,
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

  test("a sort moves on to the next hint and counts", () => {
    const p = advance(FIRST_PROGRESS, { kind: "sorted" });
    expect(p).toEqual({ stage: "hints", hint: 1, sorts: 1 });
    expect(currentHint(p)?.button).toBe("skip");
  });

  test("Got it moves on without counting a sort", () => {
    expect(advance(FIRST_PROGRESS, { kind: "next" })).toEqual({ stage: "hints", hint: 1, sorts: 0 });
  });

  test("four sorts end the hints and bring the sheet", () => {
    let p: Progress = FIRST_PROGRESS;
    for (let i = 0; i < 4; i++) p = advance(p, { kind: "sorted" });
    expect(currentHint(p)).toBeNull();
    expect(p.stage).toBe("sheet");
  });

  test("hiding the tips waits for the first few sorts before the sheet", () => {
    let p = advance(FIRST_PROGRESS, { kind: "hide_hints" });
    expect(currentHint(p)).toBeNull();
    expect(p.stage).toBe("hints");
    for (let i = 1; i < SORTS_BEFORE_SHEET; i++) p = advance(p, { kind: "sorted" });
    expect(p.stage).toBe("hints");
    p = advance(p, { kind: "sorted" });
    expect(p.stage).toBe("sheet");
  });

  test("Got it through every hint with enough sorts brings the sheet", () => {
    let p: Progress = { stage: "hints", hint: 3, sorts: SORTS_BEFORE_SHEET };
    p = advance(p, { kind: "next" });
    expect(p.stage).toBe("sheet");
  });

  test("the sheet stage ignores further events", () => {
    const sheet: Progress = { stage: "sheet", hint: HINTS.length, sorts: 4 };
    expect(advance(sheet, { kind: "sorted" })).toBe(sheet);
    expect(advance(sheet, { kind: "hide_hints" })).toBe(sheet);
  });

  test("the hint index never runs past the end", () => {
    let p: Progress = FIRST_PROGRESS;
    for (let i = 0; i < 10; i++) p = advance(p, { kind: "next" });
    expect(p.hint).toBe(HINTS.length);
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
