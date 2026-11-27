import { describe, expect, test } from "bun:test";
import { aboveRowTop, chooseLabelSpot, SPOT_GAP, spotIsClear, type Box, type SpotInput } from "./placement";

const box = (top: number, bottom: number, left = 16, right = 374): Box => ({ top, bottom, left, right });

/** A 390 by 844 screen: the button row starts at 700, and the label is 90 tall. */
const base: SpotInput = { rowTop: 700, minTop: 8, height: 90, left: 16, right: 374, keepClear: [], current: null };

describe("chooseLabelSpot", () => {
  test("above the buttons when nothing is there", () => {
    const input = { ...base, keepClear: [box(60, 104), box(400, 440)] };
    expect(chooseLabelSpot(input)).toEqual({ kind: "above_row" });
  });

  test("the IMDb row just above the buttons sends the label up, clear of everything", () => {
    // Controls at the top, the title, then the IMDb row right above the buttons.
    const keepClear = [box(12, 56), box(560, 600), box(640, 664)];
    const input = { ...base, keepClear };
    const spot = chooseLabelSpot(input);
    expect(spot.kind).toBe("at");
    expect(spotIsClear(spot, input)).toBe(true);
    // The highest clear spot: just under the controls row.
    expect(spot.kind === "at" && spot.top).toBe(64);
  });

  test("the error notice under the controls is kept clear too", () => {
    const keepClear = [box(12, 56), box(68, 112), box(640, 664)];
    const input = { ...base, keepClear };
    const spot = chooseLabelSpot(input);
    expect(spot.kind === "at" && spot.top).toBeGreaterThanOrEqual(112 + SPOT_GAP);
    expect(spotIsClear(spot, input)).toBe(true);
  });

  test("a title scrolled to where the label would sit pushes it past the title", () => {
    // 320 by 568, scrolled: the title is at the top of the screen, the IMDb row just above the buttons.
    const small: SpotInput = { ...base, rowTop: 430, height: 110, right: 304, keepClear: [box(70, 140, 16, 304), box(380, 404, 16, 304)] };
    const spot = chooseLabelSpot(small);
    expect(spot.kind).toBe("at");
    expect(spotIsClear(spot, small)).toBe(true);
    expect(spot.kind === "at" && spot.top).toBeGreaterThanOrEqual(140 + SPOT_GAP);
  });

  test("no clear spot: hidden, never over the title", () => {
    const tight: SpotInput = { ...base, rowTop: 300, height: 110, keepClear: [box(40, 120), box(170, 200)] };
    expect(chooseLabelSpot(tight)).toEqual({ kind: "hidden" });
  });

  test("an over-the-poster label never reaches the buttons", () => {
    const keepClear = [box(0, 520), box(640, 664)];
    const input = { ...base, keepClear };
    const spot = chooseLabelSpot(input);
    expect(spot.kind).toBe("at");
    if (spot.kind === "at") expect(spot.top + input.height).toBeLessThanOrEqual(input.rowTop - SPOT_GAP);
  });

  test("stays put while its spot is still clear", () => {
    const keepClear = [box(12, 56), box(640, 664)];
    const input = { ...base, keepClear, current: { kind: "at" as const, top: 300 } };
    expect(chooseLabelSpot(input)).toEqual({ kind: "at", top: 300 });
  });

  test("moves when its spot stops being clear (a scroll brought the title under it)", () => {
    const keepClear = [box(12, 56), box(290, 330), box(640, 664)];
    const input = { ...base, keepClear, current: { kind: "at" as const, top: 300 } };
    const spot = chooseLabelSpot(input);
    expect(spot).not.toEqual({ kind: "at", top: 300 });
    expect(spotIsClear(spot, input)).toBe(true);
  });

  test("something beside the label, not under it, doesn't count", () => {
    const input = { ...base, keepClear: [box(640, 664, 380, 390)] };
    expect(chooseLabelSpot(input)).toEqual({ kind: "above_row" });
  });

  test("the above-row label's top sits its height above the row, its pointer in the row's padding", () => {
    expect(aboveRowTop(base)).toBe(612);
  });

  test("every spot it picks is clear, across scroll positions", () => {
    // A title (70 tall) and an IMDb row (24 tall) 300px apart, scrolled through the screen in 10px steps.
    for (let scroll = 0; scroll <= 800; scroll += 10) {
      const titleTop = 600 - scroll;
      const keepClear = [box(12, 56), box(titleTop, titleTop + 70), box(titleTop + 300, titleTop + 324)];
      const input = { ...base, rowTop: 460, height: 100, keepClear };
      expect(spotIsClear(chooseLabelSpot(input), input)).toBe(true);
    }
  });
});
