// The Discover store's Undo paths (issue 84, item 4). These pin the store's behavior as it is today, so a change to
// how Undo is sent (issue 112) shows up here first. They are not a statement of the ideal: where today's behavior is
// questionable, the test says so and names the issue.
//
// The store imports server actions (./actions), so the module is mocked before the store loads, and the store is
// loaded with a dynamic import after it. Its HTTP calls (/api/deck, /api/deck/sort, /api/deck/hidden) go through a
// stubbed fetch. The store's state is read through its own hook's server snapshot (renderToString), so store.ts
// needs no test seam.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JUSTWATCH_ATTRIBUTION } from "@/core/attribution";
import type { DeckPageCard } from "@/core/deck-service/types";
import { DEFAULT_DECK_CHOICE } from "@/core/filters";
import type { UndoInput } from "@/core/library";
import type { DeckResponse } from "@/app/api/deck/route";
import type { DeckActionResult } from "./actions";

// ---- The server actions, mocked ----

type UndoCall = { ref: unknown; outcome: unknown };
let undoCalls: UndoCall[] = [];
/** What the next undoSortAction answers. A function so a test can make it throw or wait. */
let undoAnswer: () => Promise<DeckActionResult> = async () => ({ ok: true, outcome: { previous: null, current: null } });
let seenAnswer: () => Promise<DeckActionResult> = async () => ({ ok: false, error: "unset" });

/** An export the store does not call here. A later test that reaches it fails with a clear message. */
const notMocked = (name: string) => () => {
  throw new Error(`${name} is not mocked in store.test.ts`);
};

// Every export of ./actions, so nothing reads as undefined.
mock.module("./actions", () => ({
  undoSortAction: (ref: unknown, outcome: unknown) => {
    undoCalls.push({ ref, outcome });
    return undoAnswer();
  },
  markSeenAction: () => seenAnswer(),
  sortCardAction: notMocked("sortCardAction"),
  sortDeckCardAction: notMocked("sortDeckCardAction"),
  saveDeckChoiceAction: notMocked("saveDeckChoiceAction"),
}));

const store = await import("./store");
type DeckState = ReturnType<typeof store.useDeck>;

/** The store's state now, read through useDeck's server snapshot. */
function snapshot(): DeckState {
  let seen: DeckState | undefined;
  function Probe() {
    seen = store.useDeck();
    return null;
  }
  renderToString(createElement(Probe));
  return seen!;
}

/**
 * How the store sent each Undo, as (title, outcome) pairs. Issue 112 changes the transport (a route instead of the
 * server action), so this is the one place that reads it.
 */
function undosSent(): UndoCall[] {
  return undoCalls;
}

// ---- Fixtures ----

function card(tmdbId: number): DeckPageCard {
  return {
    mediaType: "movie",
    tmdbId,
    posterUrl: null,
    title: `Title ${tmdbId}`,
    year: 2020,
    genres: [{ id: 878, name: "Science Fiction" }],
    runtimeMinutes: 120,
    numberOfSeasons: null,
    imdb: { kind: "rated", imdbId: `tt${tmdbId}`, rating: 7.1, votes: 1000 },
    synopsis: "A synopsis.",
    streaming: { kind: "known", country: "US", attribution: JUSTWATCH_ATTRIBUTION, providers: [], onMyServices: false, link: null },
    trailerYouTubeKey: null,
    userState: null,
    source: "popular",
  };
}

const CARDS = [101, 102, 103, 104, 105, 106, 107, 108].map(card);

/** A row as it crosses JSON from the sort route: every date an ISO string. */
function row(tmdbId: number, fields: Partial<Record<string, unknown>>) {
  return {
    mediaType: "movie" as const,
    tmdbId,
    status: "passed" as const,
    rating: null,
    review: null,
    reviewVisibility: "private" as const,
    skipUntil: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-02T12:00:00.000Z",
    ...fields,
  };
}

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const FAR_PAST = "2001-01-01T00:00:00.000Z";

/** Earlier rows a sorted title can carry, each as the sort's `previous`. */
const PREVIOUS = {
  seen: (id: number) =>
    row(id, { status: "seen", rating: 7.5, review: "Slow start, great last act.\nWould watch again.", updatedAt: "2026-10-03T08:30:15.123Z" }),
  watchlist: (id: number) => row(id, { status: "watchlist" }),
  skippedUntilLater: (id: number) => row(id, { status: "skipped", skipUntil: FAR_FUTURE }),
  skippedRunOut: (id: number) => row(id, { status: "skipped", skipUntil: FAR_PAST }),
};

// ---- The HTTP side, stubbed ----

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Sort requests in the order sent. Each answers when its test resolves it. */
let sortRequests: { body: { kind: string; title: unknown }; reply: Deferred<Response> }[] = [];

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/deck/sort")) {
      const reply = deferred<Response>();
      sortRequests.push({ body: JSON.parse(String(init?.body)), reply });
      return reply.promise;
    }
    if (url.startsWith("/api/deck/hidden")) return Response.json({ ok: true, hidden: [] });
    if (url.startsWith("/api/deck/choice")) return Response.json({ ok: true });
    if (url.startsWith("/api/deck")) {
      const body: DeckResponse = { ok: true, page: { kind: "cards", cards: CARDS, nextCursor: null } };
      return Response.json(body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Lets every pending promise and timer-free callback run. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The sort route's answer: a saved sort with the given outcome, sent through JSON as the route sends it. */
function answerSort(i: number, result: DeckActionResult | { ok: true; outcome: UndoInput }) {
  sortRequests[i].reply.resolve(Response.json(result));
}

let userSeq = 0;

beforeEach(async () => {
  undoCalls = [];
  sortRequests = [];
  undoAnswer = async () => ({ ok: true, outcome: { previous: null, current: null } });
  // A fresh user each test resets the store's module state (the queue, the last sort, the toast).
  store.startDeck(`user-${++userSeq}`, "US:", DEFAULT_DECK_CHOICE);
  await settle();
  expect(top()).toBe(101);
});

/** The TMDB id of the card on screen, or null. */
function top(): number | null {
  return snapshot().queue.cards[0]?.tmdbId ?? null;
}
function queued(id: number): boolean {
  return snapshot().queue.cards.some((c) => c.tmdbId === id);
}

// ---- The tests ----

describe("sort, then Undo after the save settles", () => {
  test("the card comes back on top and the sort's outcome is sent back unchanged", async () => {
    const c = CARDS[0];
    store.sortCard("pass", c);
    expect(top()).toBe(102);
    expect(snapshot().toast?.message).toBe("Passed");
    expect(sortRequests[0].body).toEqual({ kind: "pass", title: { mediaType: "movie", tmdbId: 101 } });

    const outcome = { previous: null, current: row(101, { status: "passed" }) };
    answerSort(0, { ok: true, outcome });
    await settle();

    const undoing = store.undoLastSort();
    // At the tap: the card is back, the toast is gone, and the buttons wait.
    expect(top()).toBe(101);
    expect(snapshot().toast).toBeNull();
    expect(snapshot().undoing).toBe(true);
    await undoing;

    expect(undosSent()).toEqual([{ ref: { mediaType: "movie", tmdbId: 101 }, outcome }]);
    expect(top()).toBe(101);
    expect(snapshot().undoing).toBe(false);
    expect(snapshot().notice).toBeNull();
  });

  test("a second Undo does nothing: the toast's Undo is spent", async () => {
    store.sortCard("pass", CARDS[0]);
    answerSort(0, { ok: true, outcome: { previous: null, current: row(101, {}) } });
    await settle();
    await store.undoLastSort();
    await store.undoLastSort();
    expect(undosSent()).toHaveLength(1);
  });

  test("Undo after the toast was dismissed does nothing", async () => {
    store.sortCard("skip", CARDS[0]);
    answerSort(0, { ok: true, outcome: { previous: null, current: row(101, { status: "skipped", skipUntil: FAR_FUTURE }) } });
    await settle();
    store.dismissToast(snapshot().toast!.id);
    await store.undoLastSort();
    expect(undosSent()).toHaveLength(0);
    expect(top()).toBe(102);
  });
});

describe("Undo of a sort of a title that already had a row sends that row back exactly", () => {
  // In each case the sort's outcome names the earlier row as `previous`, and the Undo sends the whole outcome back
  // byte for byte: the rating, the review (newlines included), the return date, and the timestamps, still ISO strings.
  const cases: { name: string; previous: (id: number) => ReturnType<typeof row>; cardBack: boolean }[] = [
    { name: "Seen with a rating and a review", previous: PREVIOUS.seen, cardBack: false },
    { name: "Watchlist", previous: PREVIOUS.watchlist, cardBack: false },
    { name: "Skipped until later", previous: PREVIOUS.skippedUntilLater, cardBack: false },
    { name: "Skipped, its return date passed", previous: PREVIOUS.skippedRunOut, cardBack: true },
  ];

  for (const { name, previous, cardBack } of cases) {
    test(`${name}: ${cardBack ? "the card comes back on top" : "the card stays out of the deck"}`, async () => {
      const c = CARDS[0];
      store.sortCard("watchlist", c);
      const outcome = { previous: previous(101), current: row(101, { status: "watchlist", createdAt: "2026-10-01T12:00:00.000Z" }) };
      answerSort(0, { ok: true, outcome });
      await settle();

      const undoing = store.undoLastSort();
      // The place is decided at the tap, from the known outcome. A title on a list, or skipped until later, never
      // shows in the deck (VISION invariant 3), so it does not flash back.
      expect(top()).toBe(cardBack ? 101 : 102);
      await undoing;

      expect(undosSent()).toHaveLength(1);
      expect(undosSent()[0].ref).toEqual({ mediaType: "movie", tmdbId: 101 });
      expect(undosSent()[0].outcome).toEqual(outcome);
      expect(queued(101)).toBe(cardBack);
      expect(snapshot().notice).toBeNull();
      expect(snapshot().undoing).toBe(false);
    });
  }

  test("Seen it, then Undo: the Seen save's outcome is sent back", async () => {
    const c = CARDS[0];
    const outcome = {
      previous: PREVIOUS.skippedRunOut(101),
      current: row(101, { status: "seen", rating: 9.5, review: "Loved it." }),
    };
    // A copy, so a store that edited the outcome in place would fail the comparison below.
    seenAnswer = async () => ({ ok: true, outcome: structuredClone(outcome) as never });
    expect(await store.markCardSeen(c, 9.5, "Loved it.")).toBeNull();
    expect(snapshot().toast?.message).toBe("Marked as seen");
    expect(top()).toBe(102);

    await store.undoLastSort();
    expect(undosSent()).toEqual([{ ref: { mediaType: "movie", tmdbId: 101 }, outcome }]);
    expect(top()).toBe(101);
  });
});

describe("Undo while the sort's save is still on its way", () => {
  test("the card comes back at once, and the Undo waits for the save before it is sent", async () => {
    store.sortCard("pass", CARDS[0]);
    const undoing = store.undoLastSort();
    expect(top()).toBe(101);
    expect(snapshot().undoing).toBe(true);
    await settle();
    // Nothing to undo yet: the sort hasn't answered.
    expect(undosSent()).toHaveLength(0);

    const outcome = { previous: null, current: row(101, { status: "passed" }) };
    answerSort(0, { ok: true, outcome });
    await undoing;
    expect(undosSent()).toEqual([{ ref: { mediaType: "movie", tmdbId: 101 }, outcome }]);
    expect(top()).toBe(101);
    expect(snapshot().undoing).toBe(false);
  });

  test("when the save shows the title was on a list, the card leaves again once it settles (issue 84 item 2)", async () => {
    // Today's behavior: an early Undo shows a listed title on top until the sort answers. The root fix is issue 83.
    store.sortCard("pass", CARDS[0]);
    const undoing = store.undoLastSort();
    expect(top()).toBe(101);

    const outcome = { previous: PREVIOUS.watchlist(101), current: row(101, { status: "passed" }) };
    answerSort(0, { ok: true, outcome });
    await undoing;
    expect(queued(101)).toBe(false);
    expect(undosSent()).toEqual([{ ref: { mediaType: "movie", tmdbId: 101 }, outcome }]);
  });

  test("a failed sort sends no Undo: the card stays on top and the sort's error shows", async () => {
    store.sortCard("pass", CARDS[0]);
    const undoing = store.undoLastSort();
    answerSort(0, { ok: false, error: "Couldn't save. Try again." });
    await undoing;
    expect(undosSent()).toHaveLength(0);
    expect(top()).toBe(101);
    expect(snapshot().notice?.message).toBe("Couldn't save. Try again.");
    expect(snapshot().undoing).toBe(false);
  });

  test("a sort refused as stale sends no Undo, and the card stays out", async () => {
    store.sortCard("pass", CARDS[0]);
    const undoing = store.undoLastSort();
    answerSort(0, { ok: false, stale: true, error: "Already on your Watchlist." });
    await undoing;
    expect(undosSent()).toHaveLength(0);
    expect(queued(101)).toBe(false);
    expect(snapshot().notice?.message).toBe("Already on your Watchlist.");
  });
});

describe("a failed Undo leaves the state honest", () => {
  test("refused: the sort stands, so the card leaves again, the error shows, and the buttons free up", async () => {
    store.sortCard("pass", CARDS[0]);
    answerSort(0, { ok: true, outcome: { previous: null, current: row(101, {}) } });
    await settle();
    undoAnswer = async () => ({ ok: false, error: "That changed somewhere else." });
    await store.undoLastSort();
    expect(undosSent()).toHaveLength(1);
    expect(queued(101)).toBe(false);
    expect(top()).toBe(102);
    expect(snapshot().notice?.message).toBe("That changed somewhere else.");
    expect(snapshot().toast).toBeNull();
    expect(snapshot().undoing).toBe(false);
    // No second try: the Undo is spent.
    await store.undoLastSort();
    expect(undosSent()).toHaveLength(1);
  });

  test("thrown (no connection): the same, with the connection message", async () => {
    store.sortCard("pass", CARDS[0]);
    answerSort(0, { ok: true, outcome: { previous: null, current: row(101, {}) } });
    await settle();
    undoAnswer = async () => {
      throw new Error("network down");
    };
    await store.undoLastSort();
    expect(queued(101)).toBe(false);
    expect(snapshot().notice?.message).toBe("Couldn't undo. Check your connection.");
    expect(snapshot().undoing).toBe(false);
  });

  test("CURRENT BEHAVIOR, issue 84 item 1: a failed Undo of a kept-out card shows an error for a change never seen", async () => {
    // The card never came back (its earlier row was Watchlist), yet the failure still shows a notice. Declined in PR 82
    // round 1 with reasons; pinned here so a change to it is deliberate.
    store.sortCard("pass", CARDS[0]);
    answerSort(0, { ok: true, outcome: { previous: PREVIOUS.watchlist(101), current: row(101, {}) } });
    await settle();
    undoAnswer = async () => ({ ok: false, error: "Couldn't undo." });
    const undoing = store.undoLastSort();
    expect(snapshot().undoing).toBe(true);
    await undoing;
    expect(queued(101)).toBe(false);
    expect(snapshot().notice?.message).toBe("Couldn't undo.");
  });
});

describe("a second sort replaces the Undo toast", () => {
  test("Undo restores the second sort only", async () => {
    store.sortCard("pass", CARDS[0]);
    const first = snapshot().toast!;
    store.sortCard("watchlist", CARDS[1]);
    const second = snapshot().toast!;
    expect(second.id).not.toBe(first.id);
    expect(second.message).toBe("Added to Watchlist");
    expect(top()).toBe(103);

    const outcomeA = { previous: null, current: row(101, { status: "passed" }) };
    const outcomeB = { previous: null, current: row(102, { status: "watchlist" }) };
    answerSort(0, { ok: true, outcome: outcomeA });
    answerSort(1, { ok: true, outcome: outcomeB });
    await settle();

    await store.undoLastSort();
    expect(undosSent()).toEqual([{ ref: { mediaType: "movie", tmdbId: 102 }, outcome: outcomeB }]);
    expect(top()).toBe(102);
    expect(queued(101)).toBe(false);
  });

  test("the first sort failing later leaves the second sort's toast and Undo alone", async () => {
    store.sortCard("pass", CARDS[0]);
    store.sortCard("skip", CARDS[1]);
    const second = snapshot().toast!;
    answerSort(0, { ok: false, error: "Couldn't save. Try again." });
    await settle();
    // The failed card comes back on top with its error. The second sort's toast stays.
    expect(top()).toBe(101);
    expect(snapshot().toast).toEqual(second);
    expect(snapshot().notice?.message).toBe("Couldn't save. Try again.");

    const outcomeB = { previous: null, current: row(102, { status: "skipped", skipUntil: FAR_FUTURE }) };
    answerSort(1, { ok: true, outcome: outcomeB });
    await settle();
    await store.undoLastSort();
    expect(undosSent()).toEqual([{ ref: { mediaType: "movie", tmdbId: 102 }, outcome: outcomeB }]);
    expect(top()).toBe(102);
    expect(queued(101)).toBe(true);
  });
});
