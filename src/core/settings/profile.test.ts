import { describe, expect, test } from "bun:test";
import { countriesFor, toStreamingServices } from "./profile";

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
