import { describe, expect, test } from "bun:test";
import { DISCOVERY_MODES } from "../types";
import {
  DEFAULT_DECK_CHOICE,
  MODE_LABELS,
  MODE_NOTES,
  deckChoiceFromParams,
  deckChoiceKey,
  deckChoiceToParams,
  isDiscoveryMode,
  normalizeDeckChoice,
  type DeckChoice,
} from "./deck-choice";

const testCase: DeckChoice = {
  mode: "top_rated",
  filters: { type: "tv", genres: ["scifi"], era: "last10", onMyServices: true },
};

describe("deck choice", () => {
  test("every mode has a label and a note, and blend is the default", () => {
    for (const m of DISCOVERY_MODES) {
      expect(MODE_LABELS[m]).toBeTruthy();
      expect(MODE_NOTES[m]).toBeTruthy();
    }
    expect(DEFAULT_DECK_CHOICE.mode).toBe("blend");
  });

  test("isDiscoveryMode accepts the five modes only", () => {
    for (const m of DISCOVERY_MODES) expect(isDiscoveryMode(m)).toBe(true);
    expect(isDiscoveryMode("box_office")).toBe(false);
    expect(isDiscoveryMode(3)).toBe(false);
  });

  test("normalize falls back to the default for junk", () => {
    expect(normalizeDeckChoice(null)).toEqual({ mode: "blend", filters: DEFAULT_DECK_CHOICE.filters });
    expect(normalizeDeckChoice({ mode: "box_office", filters: "x" })).toEqual({ mode: "blend", filters: DEFAULT_DECK_CHOICE.filters });
    // A saved choice survives a JSON round trip.
    expect(normalizeDeckChoice(JSON.parse(JSON.stringify(testCase)))).toEqual(testCase);
  });

  test("params leave out defaults and round-trip", () => {
    expect(deckChoiceToParams(DEFAULT_DECK_CHOICE)).toEqual({});
    const params = deckChoiceToParams(testCase);
    expect(params).toEqual({ mode: "top_rated", type: "tv", genre: "scifi", era: "last10", mine: "1" });
    expect(deckChoiceFromParams(new URLSearchParams(params))).toEqual({ mode: "top_rated", filters: testCase.filters });
  });

  test("params keep an unknown mode raw, so core can refuse it", () => {
    expect(deckChoiceFromParams(new URLSearchParams("mode=box_office")).mode).toBe("box_office");
    expect(deckChoiceFromParams(new URLSearchParams("")).mode).toBeNull();
  });

  test("the key ignores genre tap order and changes with mode or filters", () => {
    const a: DeckChoice = { mode: "blend", filters: { type: "all", genres: ["scifi", "comedy"], era: "any", onMyServices: false } };
    const b: DeckChoice = { mode: "blend", filters: { type: "all", genres: ["comedy", "scifi"], era: "any", onMyServices: false } };
    expect(deckChoiceKey(a)).toBe(deckChoiceKey(b));
    expect(deckChoiceKey({ ...a, mode: "popular" })).not.toBe(deckChoiceKey(a));
    expect(deckChoiceKey({ ...a, filters: { ...a.filters, onMyServices: true } })).not.toBe(deckChoiceKey(a));
    expect(deckChoiceKey(DEFAULT_DECK_CHOICE)).toBe("");
  });
});
