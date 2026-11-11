import { describe, expect, test } from "bun:test";
import { imdbTitleUrl } from "./url";

describe("imdbTitleUrl", () => {
  test("builds the title page from an IMDb ID", () => {
    expect(imdbTitleUrl("tt0133093")).toBe("https://www.imdb.com/title/tt0133093/");
  });

  test("keeps long IDs whole", () => {
    expect(imdbTitleUrl("tt10919420")).toBe("https://www.imdb.com/title/tt10919420/");
  });

  test("no ID, no link", () => {
    expect(imdbTitleUrl(null)).toBeNull();
    expect(imdbTitleUrl(undefined)).toBeNull();
    expect(imdbTitleUrl("")).toBeNull();
  });

  test("refuses anything that is not tt plus digits", () => {
    for (const bad of ["nm0000206", "tt", "tt12a", "tt123/../../name", "tt123?x=1", " tt123", "tt123\n", "TT123", "javascript:alert(1)"]) {
      expect(imdbTitleUrl(bad)).toBeNull();
    }
  });
});
