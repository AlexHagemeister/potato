import { describe, expect, test } from "bun:test";
import { JUSTWATCH_ATTRIBUTION } from "../deck-service/constants";
import type { DeckPageCard } from "../deck-service/types";
import type { MediaType } from "../types";
import {
  addPage,
  afterRefusal,
  deckSettingsKey,
  emptyQueue,
  forgetTitle,
  MAX_EMPTY_PAGES,
  needsMore,
  QUEUE_LOW_WATER,
  refreshQueue,
  removeCard,
  restartCursor,
  resumeQueue,
  returnToFront,
  stalled,
  startAgain,
} from "./index";

function card(tmdbId: number, mediaType: MediaType = "movie"): DeckPageCard {
  return {
    mediaType,
    tmdbId,
    posterUrl: null,
    title: `Title ${tmdbId}`,
    year: 2020,
    genres: [],
    runtimeMinutes: 100,
    numberOfSeasons: null,
    imdb: { kind: "unavailable", imdbId: null },
    synopsis: "",
    streaming: { country: "US", providers: [], onMyServices: false, link: null, attribution: JUSTWATCH_ATTRIBUTION },
    trailerYouTubeKey: null,
    userState: null,
    source: "popular",
  };
}

const ids = (q: { cards: DeckPageCard[] }) => q.cards.map((c) => `${c.mediaType}:${c.tmdbId}`);

describe("addPage", () => {
  test("appends cards and takes the cursor", () => {
    const q = addPage(emptyQueue(), { cards: [card(1), card(2)], nextCursor: "c1" });
    expect(ids(q)).toEqual(["movie:1", "movie:2"]);
    expect(q.cursor).toBe("c1");
    expect(q.exhausted).toBe(false);
  });

  test("drops a title already queued, and one already sorted", () => {
    let q = addPage(emptyQueue(), { cards: [card(1), card(2)], nextCursor: "c1" });
    q = removeCard(q, card(1)); // sorted, but its save may not have landed when the next page was built
    q = addPage(q, { cards: [card(1), card(2), card(3)], nextCursor: "c2" });
    expect(ids(q)).toEqual(["movie:2", "movie:3"]);
  });

  test("keeps a movie and a series with the same TMDB ID apart", () => {
    const q = addPage(emptyQueue(), { cards: [card(7, "movie"), card(7, "tv")], nextCursor: null });
    expect(ids(q)).toEqual(["movie:7", "tv:7"]);
  });

  test("drops duplicates inside one page", () => {
    const q = addPage(emptyQueue(), { cards: [card(1), card(1)], nextCursor: null });
    expect(ids(q)).toEqual(["movie:1"]);
  });

  test("a null cursor marks the deck exhausted", () => {
    const q = addPage(emptyQueue(), { cards: [card(1)], nextCursor: null });
    expect(q.exhausted).toBe(true);
    expect(needsMore(q)).toBe(false);
  });
});

describe("needsMore", () => {
  test("asks before the first page", () => {
    expect(needsMore(emptyQueue())).toBe(true);
  });

  test("keeps asking through empty pages while the cursor is not null", () => {
    let q = addPage(emptyQueue(), { cards: [], nextCursor: "c1" });
    expect(needsMore(q)).toBe(true);
    q = addPage(q, { cards: [], nextCursor: "c2" });
    expect(needsMore(q)).toBe(true);
  });

  test("stops asking once enough cards are queued", () => {
    const cards = Array.from({ length: QUEUE_LOW_WATER }, (_, i) => card(i + 1));
    const q = addPage(emptyQueue(), { cards, nextCursor: "c1" });
    expect(needsMore(q)).toBe(false);
    expect(needsMore(removeCard(q, cards[0]!))).toBe(true);
  });

  test("stalls after too many empty pages in a row, and resumes on retry", () => {
    let q = emptyQueue();
    for (let i = 0; i < MAX_EMPTY_PAGES; i++) q = addPage(q, { cards: [], nextCursor: `c${i}` });
    expect(needsMore(q)).toBe(false);
    expect(stalled(q)).toBe(true);
    q = resumeQueue(q);
    expect(needsMore(q)).toBe(true);
    expect(stalled(q)).toBe(false);
  });

  test("a page with a new card resets the empty streak", () => {
    let q = emptyQueue();
    for (let i = 0; i < MAX_EMPTY_PAGES - 1; i++) q = addPage(q, { cards: [], nextCursor: `c${i}` });
    q = addPage(q, { cards: [card(1)], nextCursor: "next" });
    expect(q.emptyPages).toBe(0);
  });
});

describe("removeCard and returnToFront", () => {
  test("remove takes the card out wherever it is", () => {
    const q = addPage(emptyQueue(), { cards: [card(1), card(2), card(3)], nextCursor: "c" });
    expect(ids(removeCard(q, card(2)))).toEqual(["movie:1", "movie:3"]);
  });

  test("remove of an unknown title returns the same queue", () => {
    const q = addPage(emptyQueue(), { cards: [card(1)], nextCursor: "c" });
    expect(removeCard(q, card(9))).toBe(q);
  });

  test("an undone card returns on top, once", () => {
    let q = addPage(emptyQueue(), { cards: [card(1), card(2)], nextCursor: "c" });
    q = removeCard(q, card(1));
    q = returnToFront(q, card(1));
    expect(ids(q)).toEqual(["movie:1", "movie:2"]);
    q = returnToFront(q, card(1));
    expect(ids(q)).toEqual(["movie:1", "movie:2"]);
  });

  test("a returned card stays deduped against later pages", () => {
    let q = returnToFront(emptyQueue(), card(5));
    q = addPage(q, { cards: [card(5), card(6)], nextCursor: null });
    expect(ids(q)).toEqual(["movie:5", "movie:6"]);
  });
});

describe("restartCursor", () => {
  test("forgets the cursor, keeps cards and what was dealt", () => {
    let q = addPage(emptyQueue(), { cards: [card(1)], nextCursor: "stale" });
    q = restartCursor(q);
    expect(q.cursor).toBeNull();
    expect(q.exhausted).toBe(false);
    expect(ids(q)).toEqual(["movie:1"]);
    q = addPage(q, { cards: [card(1), card(2)], nextCursor: "fresh" });
    expect(ids(q)).toEqual(["movie:1", "movie:2"]);
  });
});

describe("afterRefusal", () => {
  test("a stale cursor restarts once without it", () => {
    const q = addPage(emptyQueue(), { cards: [card(1)], nextCursor: "v2-cursor" });
    const next = afterRefusal(q, "invalid_deck_query", false);
    expect(next?.cursor).toBeNull();
    expect(ids(next!)).toEqual(["movie:1"]);
    expect(afterRefusal(q, "invalid_deck_query", true)).toBeNull();
  });

  test("a refusal without a cursor, or any other error, shows the error", () => {
    expect(afterRefusal(emptyQueue(), "invalid_deck_query", false)).toBeNull();
    const q = addPage(emptyQueue(), { cards: [], nextCursor: "c" });
    expect(afterRefusal(q, "unavailable", false)).toBeNull();
  });
});

describe("refreshQueue", () => {
  test("drops queued cards so the next pages deal them again, keeping sorted titles out", () => {
    let q = addPage(emptyQueue(), { cards: [card(1), card(2), card(3)], nextCursor: "c" });
    q = removeCard(q, card(1)); // sorted
    q = refreshQueue(q);
    expect(q.cards).toEqual([]);
    expect(q.cursor).toBeNull();
    expect(needsMore(q)).toBe(true);
    q = addPage(q, { cards: [card(1), card(4), card(3), card(2)], nextCursor: null });
    // 2 was on screen, so it goes back on top. 1 was sorted, so it stays out.
    expect(ids(q)).toEqual(["movie:2", "movie:4", "movie:3"]);
  });

  test("keeps the old top only for the first page after the refresh", () => {
    let q = addPage(emptyQueue(), { cards: [card(7)], nextCursor: "c" });
    q = refreshQueue(q);
    q = addPage(q, { cards: [card(8)], nextCursor: "d" });
    q = addPage(q, { cards: [card(9), card(7)], nextCursor: null });
    expect(ids(q)).toEqual(["movie:8", "movie:9", "movie:7"]);
  });
});

describe("deckSettingsKey", () => {
  test("ignores service order and duplicates, and changes with country or services", () => {
    const a = deckSettingsKey({ country: "US", providerIds: [15, 8, 9, 8] });
    expect(a).toBe(deckSettingsKey({ country: "us", providerIds: [8, 9, 15] }));
    expect(a).not.toBe(deckSettingsKey({ country: "GB", providerIds: [8, 9, 15] }));
    expect(a).not.toBe(deckSettingsKey({ country: "US", providerIds: [8, 9] }));
  });
});

describe("startAgain", () => {
  test("restarts from the first page and forgets dealt titles except queued and saving ones", () => {
    let q = addPage(emptyQueue(), { cards: [card(1), card(2), card(3)], nextCursor: null });
    q = removeCard(q, card(1)); // sorted and saved
    q = removeCard(q, card(2)); // sorted, still saving
    q = startAgain(q, ["movie:2"]);
    expect(q.cursor).toBeNull();
    expect(q.exhausted).toBe(false);
    q = addPage(q, { cards: [card(1), card(2), card(3), card(4)], nextCursor: null });
    expect(ids(q)).toEqual(["movie:3", "movie:1", "movie:4"]);
  });
});

describe("forgetTitle", () => {
  test("lets a sorted title be dealt again, and leaves a queued one alone", () => {
    let q = addPage(emptyQueue(), { cards: [card(1), card(2)], nextCursor: "c" });
    q = removeCard(q, card(1));
    expect(forgetTitle(q, card(2))).toBe(q);
    q = forgetTitle(q, card(1));
    q = addPage(q, { cards: [card(1)], nextCursor: null });
    expect(ids(q)).toEqual(["movie:2", "movie:1"]);
  });
});
