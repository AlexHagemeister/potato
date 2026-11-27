import { describe, expect, test } from "bun:test";
import { JUSTWATCH_ATTRIBUTION } from "../deck-service/constants";
import type { DeckPageCard } from "../deck-service/types";
import { addPage, emptyQueue } from "./index";
import { cardProblem, readDeckResponse } from "./card-shape";

function card(tmdbId: number): DeckPageCard {
  return {
    mediaType: "movie",
    tmdbId,
    posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg",
    title: `Title ${tmdbId}`,
    year: 2020,
    genres: [{ id: 878, name: "Science Fiction" }],
    runtimeMinutes: 120,
    numberOfSeasons: null,
    imdb: { kind: "rated", imdbId: `tt${tmdbId}`, rating: 7.1, votes: 1000 },
    synopsis: "A synopsis.",
    streaming: {
      kind: "known",
      country: "US",
      attribution: JUSTWATCH_ATTRIBUTION,
      providers: [{ id: 8, name: "Netflix", logoUrl: null, offers: ["subscription"], streams: true, isMine: true }],
      onMyServices: true,
      link: "https://www.themoviedb.org/movie/1/watch",
    },
    trailerYouTubeKey: "abc",
    userState: null,
    source: "popular",
  };
}

/** A card through JSON, as the client gets it, with `patch` applied. */
function wire(tmdbId: number, patch: (c: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(card(tmdbId))) as Record<string, unknown>;
  patch(c);
  return c;
}

const cardsBody = (cards: unknown[], nextCursor: string | null = "next") => ({ ok: true, page: { kind: "cards", cards, nextCursor } });

describe("cardProblem", () => {
  test("a card as the server sends it passes, in every imdb and streaming state", () => {
    expect(cardProblem(wire(1))).toBeNull();
    expect(cardProblem(wire(1, (c) => (c.imdb = { kind: "none", imdbId: null })))).toBeNull();
    expect(cardProblem(wire(1, (c) => (c.imdb = { kind: "unavailable", imdbId: "tt1" })))).toBeNull();
    expect(cardProblem(wire(1, (c) => (c.streaming = { kind: "unknown", country: "US", attribution: JUSTWATCH_ATTRIBUTION })))).toBeNull();
    expect(cardProblem(wire(1, (c) => ((c.mediaType = "tv"), (c.runtimeMinutes = null), (c.numberOfSeasons = 3))))).toBeNull();
    expect(cardProblem(wire(1, (c) => (c.userState = { status: "skipped", rating: null, review: null, skipUntil: "2020-01-01T00:00:00.000Z" })))).toBeNull();
  });

  test("fields it does not know are ignored, so a newer server can add one", () => {
    expect(cardProblem(wire(1, (c) => ((c.newField = { anything: 1 }), ((c.imdb as Record<string, unknown>).extra = true))))).toBeNull();
  });

  test("userState and source are not checked: the Discover client never reads them", () => {
    expect(cardProblem(wire(1, (c) => ((c.userState = "seen"), delete c.source)))).toBeNull();
  });

  test("an offer name it does not know passes: the card still shows", () => {
    expect(cardProblem(wire(1, (c) => ((c.streaming as { providers: { offers: string[] }[] }).providers[0].offers = ["cinema"])))).toBeNull();
  });

  const broken: [string, (c: Record<string, unknown>) => void][] = [
    ["a bad media type", (c) => (c.mediaType = "film")],
    ["a TMDB ID as a string", (c) => (c.tmdbId = "603")],
    ["no title", (c) => delete c.title],
    ["a poster URL as a number", (c) => (c.posterUrl = 3)],
    ["genres not a list", (c) => (c.genres = "Drama")],
    ["a genre without a name", (c) => (c.genres = [{ id: 18 }])],
    ["no synopsis", (c) => delete c.synopsis],
    ["no imdb", (c) => delete c.imdb],
    ["a rated imdb missing its imdbId (issue 129's case)", (c) => delete (c.imdb as Record<string, unknown>).imdbId],
    ["a rated imdb with a string rating", (c) => ((c.imdb as Record<string, unknown>).rating = "7.1")],
    ["an unknown imdb kind", (c) => (c.imdb = { kind: "pending", imdbId: null })],
    ["no streaming", (c) => delete c.streaming],
    ["streaming without the JustWatch credit", (c) => delete (c.streaming as Record<string, unknown>).attribution],
    ["an unknown streaming kind", (c) => ((c.streaming as Record<string, unknown>).kind = "maybe")],
    ["providers not a list", (c) => ((c.streaming as Record<string, unknown>).providers = null)],
    ["a provider without streams", (c) => delete (c.streaming as { providers: Record<string, unknown>[] }).providers[0].streams],
  ];
  for (const [name, patch] of broken) {
    test(`a card with ${name} is malformed`, () => {
      expect(cardProblem(wire(1, patch))).toEqual(expect.any(String));
    });
  }

  test("not an object is malformed", () => {
    for (const v of [null, undefined, 3, "card", [wire(1)]]) expect(cardProblem(v)).toEqual(expect.any(String));
  });
});

describe("readDeckResponse", () => {
  test("a good cards page comes through with the same card objects and its cursor", () => {
    const a = wire(1);
    const b = wire(2);
    const read = readDeckResponse(cardsBody([a, b], "c2"));
    expect(read).toEqual({ kind: "page", page: { kind: "cards", cards: [a, b] as unknown as DeckPageCard[], nextCursor: "c2" }, dropped: [] });
    if (read.kind !== "page" || read.page.kind !== "cards") throw new Error("expected a cards page");
    expect(read.page.cards[0]).toBe(a as unknown as DeckPageCard);
  });

  test("a malformed card is dropped with its reason, and the rest of the page goes on (issue 41)", () => {
    const bad = wire(2, (c) => (c.tmdbId = -1));
    const read = readDeckResponse(cardsBody([wire(1), bad, wire(3)], null));
    expect(read.kind).toBe("page");
    if (read.kind !== "page" || read.page.kind !== "cards") throw new Error("expected a cards page");
    expect(read.page.cards.map((c) => c.tmdbId)).toEqual([1, 3]);
    expect(read.page.nextCursor).toBeNull();
    expect(read.dropped).toEqual([{ index: 1, reason: expect.stringContaining("TMDB ID") }]);
  });

  test("the deck goes on past a bad card: the queue takes the page, where a bad identity used to throw", () => {
    const bad = wire(2, (c) => (c.mediaType = "film"));
    // Before the check, the queue threw on the card, so the fetch failed and every retry asked for the same page.
    expect(() => addPage(emptyQueue(), { cards: [card(1), bad as unknown as DeckPageCard], nextCursor: "n" })).toThrow();
    const read = readDeckResponse(cardsBody([wire(1), bad], "n"));
    if (read.kind !== "page" || read.page.kind !== "cards") throw new Error("expected a cards page");
    const queue = addPage(emptyQueue(), read.page);
    expect(queue.cards.map((c) => c.tmdbId)).toEqual([1]);
    expect(queue.cursor).toBe("n");
  });

  test("a page of only bad cards is an empty page, not a failure: the cursor still moves on", () => {
    const read = readDeckResponse(cardsBody([wire(1, (c) => delete c.imdb)], "n2"));
    expect(read).toEqual({ kind: "page", page: { kind: "cards", cards: [], nextCursor: "n2" }, dropped: [{ index: 0, reason: expect.any(String) }] });
  });

  test("locked and no_seeds pages come through as they are", () => {
    const locked = { kind: "locked", mode: "for_you", ratedCount: 2, required: 5, remaining: 3 };
    expect(readDeckResponse({ ok: true, page: locked })).toEqual({ kind: "page", page: locked as never, dropped: [] });
    const noSeeds = { kind: "no_seeds", mode: "for_you", mediaTypes: ["tv"] };
    expect(readDeckResponse({ ok: true, page: noSeeds })).toEqual({ kind: "page", page: noSeeds as never, dropped: [] });
  });

  test("a refusal comes through with its error code", () => {
    expect(readDeckResponse({ ok: false, error: "invalid_deck_query" })).toEqual({ kind: "refused", error: "invalid_deck_query" });
    expect(readDeckResponse({ ok: false, error: "something_new" })).toEqual({ kind: "refused", error: "something_new" });
  });

  const malformed: [string, unknown][] = [
    ["null", null],
    ["a string", "<html>Gateway Timeout</html>"],
    ["a list", []],
    ["no ok", { page: { kind: "cards", cards: [], nextCursor: null } }],
    ["ok as a string", { ok: "true", page: { kind: "cards", cards: [], nextCursor: null } }],
    ["a refusal without an error string", { ok: false, error: 503 }],
    ["no page", { ok: true }],
    ["an unknown page kind", { ok: true, page: { kind: "ads", cards: [] } }],
    ["cards not a list", { ok: true, page: { kind: "cards", cards: {}, nextCursor: null } }],
    ["no nextCursor", { ok: true, page: { kind: "cards", cards: [] } }],
    ["a numeric cursor", { ok: true, page: { kind: "cards", cards: [], nextCursor: 4 } }],
    ["a locked page without remaining", { ok: true, page: { kind: "locked", mode: "for_you" } }],
  ];
  for (const [name, body] of malformed) {
    test(`an envelope with ${name} is malformed`, () => {
      expect(readDeckResponse(body)).toEqual({ kind: "malformed", reason: expect.any(String) });
    });
  }
});
