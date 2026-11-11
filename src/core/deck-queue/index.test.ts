import { describe, expect, test } from "bun:test";
import { JUSTWATCH_ATTRIBUTION } from "../deck-service/constants";
import type { DeckPageCard } from "../deck-service/types";
import type { MediaType } from "../types";
import {
  addPage,
  afterRefusal,
  afterUndo,
  deckInputChange,
  deckSettingsKey,
  dropTitles,
  emptyQueue,
  forgetTitle,
  keepOutAfterUndo,
  MAX_EMPTY_PAGES,
  needsMore,
  QUEUE_LOW_WATER,
  queuedTitles,
  queueStop,
  refreshQueue,
  removeCard,
  restartCursor,
  resumeQueue,
  returnToFront,
  stalled,
  startAgain,
  withShuffleSeed,
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
    streaming: { kind: "known", country: "US", providers: [], onMyServices: false, link: null, attribution: JUSTWATCH_ATTRIBUTION },
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
    // Under a minimum IMDb rating the same stop is the end of the bounded search, not a stall.
    expect(queueStop(q, false)).toBe("stalled");
    expect(queueStop(q, true)).toBe("reach_spent");
    expect(queueStop(emptyQueue(), true)).toBeNull();
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

describe("afterUndo (issue 54)", () => {
  const now = new Date("2026-11-07T12:00:00.000Z");
  const later = "2026-11-21T12:00:00.000Z";
  const earlier = "2026-11-01T12:00:00.000Z";
  // The deck after a sort of movie:1: the next card is on top.
  const sortedAway = () => removeCard(addPage(emptyQueue(), { cards: [card(1), card(2)], nextCursor: "c" }), card(1));

  test("no row before the sort: the card comes back on top, once", () => {
    let q = afterUndo(sortedAway(), card(1), null, now);
    expect(ids(q)).toEqual(["movie:1", "movie:2"]);
    q = afterUndo(q, card(1), null, now);
    expect(ids(q)).toEqual(["movie:1", "movie:2"]);
  });

  test.each(["watchlist", "passed", "seen"] as const)("a %s row: the card stays out, and stays dealt", (status) => {
    const q = afterUndo(sortedAway(), card(1), { status, skipUntil: null }, now);
    expect(ids(q)).toEqual(["movie:2"]);
    expect(q.dealt.has("movie:1")).toBe(true);
    // A later page can't deal it again.
    expect(ids(addPage(q, { cards: [card(1), card(3)], nextCursor: null }))).toEqual(["movie:2", "movie:3"]);
  });

  test("a listed title on top (an optimistic return) is taken out", () => {
    const shown = returnToFront(sortedAway(), card(1));
    expect(ids(afterUndo(shown, card(1), { status: "watchlist" }, now))).toEqual(["movie:2"]);
  });

  test("a skip that has not run out keeps the card out, as a Date or an ISO string", () => {
    expect(ids(afterUndo(sortedAway(), card(1), { status: "skipped", skipUntil: new Date(later) }, now))).toEqual(["movie:2"]);
    expect(ids(afterUndo(sortedAway(), card(1), { status: "skipped", skipUntil: later }, now))).toEqual(["movie:2"]);
  });

  test("a skip that has run out puts the card back on top", () => {
    expect(ids(afterUndo(sortedAway(), card(1), { status: "skipped", skipUntil: earlier }, now))).toEqual(["movie:1", "movie:2"]);
  });

  test("a skip whose return time names no moment fails closed: the card stays out", () => {
    expect(ids(afterUndo(sortedAway(), card(1), { status: "skipped", skipUntil: null }, now))).toEqual(["movie:2"]);
    expect(ids(afterUndo(sortedAway(), card(1), { status: "skipped", skipUntil: "not a date" }, now))).toEqual(["movie:2"]);
  });

  test("a title not in the queue and not dealt is added to dealt when it stays out", () => {
    const q = afterUndo(emptyQueue(), card(7), { status: "passed" }, now);
    expect(ids(q)).toEqual([]);
    expect(q.dealt.has("movie:7")).toBe(true);
  });

  test("a listed title that keepOnTop names after a refresh is no longer kept on top", () => {
    const refreshed = refreshQueue(returnToFront(sortedAway(), card(1)), false);
    expect(refreshed.keepOnTop).toBe("movie:1");
    const q = afterUndo(refreshed, card(1), { status: "passed" }, now);
    expect(q.keepOnTop).toBeNull();
    expect(ids(addPage(q, { cards: [card(1), card(2)], nextCursor: null }))).toEqual(["movie:2"]);
  });

  test("the pair (media type, TMDB ID) decides, not the ID alone", () => {
    const q = afterUndo(addPage(emptyQueue(), { cards: [card(1, "tv"), card(2)], nextCursor: "c" }), card(1), { status: "watchlist" }, now);
    expect(ids(q)).toEqual(["tv:1", "movie:2"]);
  });
});

describe("keepOutAfterUndo (the Undo's late step, PR 82 review)", () => {
  const now = new Date("2026-11-07T12:00:00.000Z");
  // The Undo was tapped before the sort's save settled: the card went back on top at the tap.
  const returned = () => returnToFront(addPage(emptyQueue(), { cards: [card(2), card(3)], nextCursor: "c" }), card(1));

  test("a row the deck shows: the same queue comes back, so nothing re-renders", () => {
    const q = returned();
    expect(keepOutAfterUndo(q, card(1), null, now)).toBe(q);
    expect(keepOutAfterUndo(q, card(1), { status: "skipped", skipUntil: "2026-11-01T12:00:00.000Z" }, now)).toBe(q);
  });

  test("a listed row: the card leaves the top and stays dealt", () => {
    const q = keepOutAfterUndo(returned(), card(1), { status: "watchlist" }, now);
    expect(ids(q)).toEqual(["movie:2", "movie:3"]);
    expect(q.dealt.has("movie:1")).toBe(true);
  });

  test("never puts back a card a settings refresh took out, so the fresh copy can be dealt", () => {
    // Pass, Undo before the save lands, then the country or services change: the queue refreshes.
    const refreshed = refreshQueue(returned(), false);
    expect(ids(refreshed)).toEqual([]);
    const q = keepOutAfterUndo(refreshed, card(1), null, now);
    expect(q).toBe(refreshed);
    expect(q.dealt.has("movie:1")).toBe(false);
    // The next page deals the title again, with fresh data, and it goes back on top.
    expect(ids(addPage(q, { cards: [card(4), card(1)], nextCursor: null }))).toEqual(["movie:1", "movie:4"]);
  });

  test("a listed row after a refresh: the title stays out of the refreshed deck", () => {
    const q = keepOutAfterUndo(refreshQueue(returned(), false), card(1), { status: "passed" }, now);
    expect(ids(addPage(q, { cards: [card(1), card(4)], nextCursor: null }))).toEqual(["movie:4"]);
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
    q = refreshQueue(q, false);
    expect(q.cards).toEqual([]);
    expect(q.cursor).toBeNull();
    expect(needsMore(q)).toBe(true);
    q = addPage(q, { cards: [card(1), card(4), card(3), card(2)], nextCursor: null });
    // 2 was on screen, so it goes back on top. 1 was sorted, so it stays out.
    expect(ids(q)).toEqual(["movie:2", "movie:4", "movie:3"]);
  });

  test("keeps the old top only for the first page after the refresh", () => {
    let q = addPage(emptyQueue(), { cards: [card(7)], nextCursor: "c" });
    q = refreshQueue(q, false);
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

describe("deckInputChange", () => {
  const base = { settingsKey: "US:8,9,15", choiceKey: "" };

  test("nothing changed: no refresh", () => {
    expect(deckInputChange(base, { ...base })).toEqual({ refresh: false });
  });

  test("a new mode or new filters refresh the queue and keep Undo", () => {
    expect(deckInputChange(base, { ...base, choiceKey: "mode=popular" })).toEqual({ refresh: true, dropUndo: false, newDeal: true });
    expect(deckInputChange(base, { ...base, choiceKey: "genre=scifi&type=tv" })).toEqual({ refresh: true, dropUndo: false, newDeal: true });
  });

  test("new settings refresh the queue and end Undo, with or without a new choice", () => {
    expect(deckInputChange(base, { ...base, settingsKey: "GB:8" })).toEqual({ refresh: true, dropUndo: true, newDeal: false });
    expect(deckInputChange(base, { settingsKey: "GB:8", choiceKey: "mode=popular" })).toEqual({ refresh: true, dropUndo: true, newDeal: true });
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

describe("dropTitles (a queued title sorted elsewhere)", () => {
  test("drops the card on screen and a later card, and a later page can't deal them again", () => {
    let q = addPage(emptyQueue(), { cards: [card(2734, "tv"), card(1), card(2), card(3)], nextCursor: "c" });
    q = dropTitles(q, ["tv:2734", "movie:2"]);
    expect(ids(q)).toEqual(["movie:1", "movie:3"]);
    expect(q.cursor).toBe("c");
    q = addPage(q, { cards: [card(2734, "tv"), card(2), card(4)], nextCursor: null });
    expect(ids(q)).toEqual(["movie:1", "movie:3", "movie:4"]);
  });

  test("keeps titles this screen is still sorting or undoing", () => {
    const q = addPage(emptyQueue(), { cards: [card(1), card(2)], nextCursor: "c" });
    expect(ids(dropTitles(q, ["movie:1", "movie:2"], ["movie:1"]))).toEqual(["movie:1"]);
  });

  test("returns the same queue when nothing changes, so a quiet check costs no re-render", () => {
    const q = addPage(emptyQueue(), { cards: [card(1), card(2)], nextCursor: "c" });
    expect(dropTitles(q, [])).toBe(q);
    expect(dropTitles(q, ["movie:9"])).toBe(q);
    expect(dropTitles(q, ["movie:1"], ["movie:1"])).toBe(q);
  });

  test("keeps a movie and a series with the same TMDB ID apart", () => {
    const q = addPage(emptyQueue(), { cards: [card(7, "movie"), card(7, "tv")], nextCursor: "c" });
    expect(ids(dropTitles(q, ["tv:7"]))).toEqual(["movie:7"]);
  });

  test("a dropped title can't come back on top after a refresh", () => {
    let q = addPage(emptyQueue(), { cards: [card(1), card(2)], nextCursor: "c" });
    q = refreshQueue(q, false);
    expect(q.keepOnTop).toBe("movie:1");
    q = dropTitles(q, ["movie:1"]);
    expect(q.keepOnTop).toBeNull();
    q = addPage(q, { cards: [card(2), card(1)], nextCursor: null });
    expect(ids(q)).toEqual(["movie:2"]);
  });
});

describe("queuedTitles", () => {
  test("lists the queued identities, the card on screen first, at most max", () => {
    const q = addPage(emptyQueue(), { cards: [card(2734, "tv"), card(1), card(2)], nextCursor: "c" });
    expect(queuedTitles(q, 2)).toEqual([
      { mediaType: "tv", tmdbId: 2734 },
      { mediaType: "movie", tmdbId: 1 },
    ]);
    expect(queuedTitles(emptyQueue(), 10)).toEqual([]);
  });
});

describe("the queue's shuffle seed (its deal)", () => {
  const dealt = () => addPage(withShuffleSeed(emptyQueue(), () => "s1"), { cards: [card(1), card(2)], nextCursor: "c" });

  test("a new queue has none, takes one once, and keeps it from page to page", () => {
    expect(emptyQueue().shuffleSeed).toBeNull();
    const q = dealt();
    expect(q.shuffleSeed).toBe("s1");
    expect(withShuffleSeed(q, () => "s2")).toBe(q);
    expect(addPage(q, { cards: [card(3)], nextCursor: null }).shuffleSeed).toBe("s1");
  });

  test("a settings refresh, a retry, and a stale cursor keep the deal", () => {
    expect(refreshQueue(dealt(), false).shuffleSeed).toBe("s1");
    expect(resumeQueue(dealt()).shuffleSeed).toBe("s1");
    expect(restartCursor(dealt()).shuffleSeed).toBe("s1");
    expect(afterRefusal(dealt(), "invalid_deck_query", false)?.shuffleSeed).toBe("s1");
  });

  test("a new mode or filters, and Check again, start a new deal", () => {
    expect(refreshQueue(dealt(), true).shuffleSeed).toBeNull();
    expect(startAgain(dealt(), []).shuffleSeed).toBeNull();
    expect(withShuffleSeed(startAgain(dealt(), []), () => "s2").shuffleSeed).toBe("s2");
  });
});
