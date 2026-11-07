import { describe, expect, test } from "bun:test";
import { countriesFor, toStreamingServices } from "./profile";
import { MAX_PROVIDER_IDS, normalizeProviderIds, parseCountry, SettingsInputError } from "./settings";

describe("parseCountry", () => {
  test("accepts two uppercase letters", () => {
    expect(parseCountry("US")).toBe("US");
    expect(parseCountry("GB")).toBe("GB");
  });

  test("rejects anything else", () => {
    for (const bad of ["us", "USA", "U", "", "U1", 12, null, undefined, ["US"]]) {
      expect(() => parseCountry(bad)).toThrow(SettingsInputError);
    }
  });
});

describe("normalizeProviderIds", () => {
  test("keeps positive integers, dedupes, keeps first-seen order", () => {
    expect(normalizeProviderIds([8, 337, 8, 9])).toEqual([8, 337, 9]);
    expect(normalizeProviderIds([])).toEqual([]);
  });

  test("rejects non-lists and bad IDs", () => {
    for (const bad of ["8", null, { 0: 8 }, [0], [-1], [1.5], ["8"], [Number.NaN], [2 ** 60]]) {
      expect(() => normalizeProviderIds(bad)).toThrow(SettingsInputError);
    }
  });

  test("caps the list length", () => {
    const many = Array.from({ length: MAX_PROVIDER_IDS + 1 }, (_, i) => i + 1);
    expect(() => normalizeProviderIds(many)).toThrow(SettingsInputError);
    expect(normalizeProviderIds(many.slice(0, MAX_PROVIDER_IDS))).toHaveLength(MAX_PROVIDER_IDS);
  });
});

describe("countriesFor", () => {
  const regions = [
    { code: "CA", name: "Canada" },
    { code: "US", name: "United States" },
  ];

  test("returns the regions when the saved country is among them", () => {
    expect(countriesFor("US", regions)).toEqual(regions);
  });

  test("adds a saved country TMDB no longer lists, in name order", () => {
    expect(countriesFor("BB", regions).map((r) => r.code)).toEqual(["BB", "CA", "US"]);
  });
});

describe("toStreamingServices", () => {
  test("builds logo URLs and keeps order", () => {
    const services = toStreamingServices([
      { id: 8, name: "Netflix", logoPath: "/n.jpg", displayPriority: 1, mediaTypes: ["movie", "tv"] },
      { id: 9, name: "Prime", logoPath: null, displayPriority: 2, mediaTypes: ["movie"] },
    ]);
    expect(services).toEqual([
      { id: 8, name: "Netflix", logoUrl: "https://image.tmdb.org/t/p/w92/n.jpg" },
      { id: 9, name: "Prime", logoUrl: null },
    ]);
  });
});
