import { describe, expect, test } from "bun:test";
import { IMDB_NOTICE, TMDB_NOTICE } from "./attribution";

// The providers' required wording, verbatim. Change these only when the
// source changes, and check the source first.
describe("attribution notices", () => {
  test("TMDB: the notice from the API Terms of Use, section 3 (https://www.themoviedb.org/api-terms-of-use)", () => {
    expect(TMDB_NOTICE).toBe(
      "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.",
    );
  });

  test('IMDb: the statement from "Can I use IMDb data in my software?" (help.imdb.com, G5JTRESSHJBBHTGX)', () => {
    expect(IMDB_NOTICE).toBe("Information courtesy of IMDb (https://www.imdb.com). Used with permission.");
  });
});
