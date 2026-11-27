import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CHOICES, EXAMPLE_CARD } from "./copy";
import { Landing } from "./landing";

const html = renderToStaticMarkup(<Landing signIn={<button type="button">Sign in with Google</button>} />);
const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");

describe("landing page (issue 145)", () => {
  test("says what Potato is", () => {
    expect(text).toContain("Decide what to watch, one card at a time.");
  });

  test("names the four choices in the deck's order, each with a few words", () => {
    expect(CHOICES.map((c) => c.label)).toEqual(["Pass", "Skip", "Watchlist", "Seen it"]);
    for (const c of CHOICES) {
      expect(text).toContain(c.label);
      expect(text).toContain(c.words);
      expect(c.words.split(" ").length).toBeLessThanOrEqual(12);
    }
  });

  test("says what builds up: a watchlist, and what you've seen with ratings and reviews", () => {
    expect(text).toContain("Watchlist");
    expect(text).toMatch(/ratings and reviews/);
  });

  test("shows an example card with a generic star score", () => {
    expect(html).toContain('aria-label="An example card"');
    expect(text).toContain("Example");
    expect(html).toContain(`aria-label="Example rating ${EXAMPLE_CARD.rating}"`);
    expect(text).toMatch(new RegExp(`★\\s+${EXAMPLE_CARD.rating.replace(".", "\\.")}`));
  });

  test("the sign-in slot is rendered, and it is the only control", () => {
    expect(text).toContain("Sign in with Google");
    // Two copies of the slot (phone row and wide-window hero); CSS shows one.
    expect(html.match(/<button/g)?.length).toBe(2);
    expect(html).not.toMatch(/<a\s|<input|tabindex/i);
  });

  test("ships no poster: the only image is the app's own icon", () => {
    const images = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(images).toEqual(["/icons/icon-192.png"]);
  });

  test("shows nothing from TMDB or IMDb, so no attribution is owed here", () => {
    expect(html).not.toMatch(/tmdb\.org|themoviedb|imdb\.com|justwatch/i);
    // The example card's score is invented, so it carries a plain star, never IMDb's name.
    expect(text).not.toMatch(/imdb/i);
  });

  test("no pricing or sign-up pitch", () => {
    expect(text).not.toMatch(/\bfree\b|pric|sign up|\$\d/i);
  });
});

describe("landing files stay static", () => {
  test("nothing under _landing imports the database, core, the auth client, or TMDB", () => {
    const dir = import.meta.dir;
    for (const file of readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source).not.toMatch(/from\s+["'](@\/db|@\/core|@\/lib|.*auth)/);
    }
  });
});
