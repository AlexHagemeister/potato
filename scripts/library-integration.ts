// Integration checks for the library core against the real database schema.
//
// Runs only against potato_dev, never production:
//   bun run test:db
// It reads the URL from .env.development.local alone (Bun's automatic .env
// loading is off, since .env.local points at production), refuses any URL
// whose database is not potato_dev, and checks current_database() over the
// same connection before writing anything. It creates two throwaway users and
// deletes them at the end (their rows cascade).
//
// Not a *.test.ts file, so CI's `bun test` (which has no database) skips it.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { inArray, sql } from "drizzle-orm";

const REQUIRED_DATABASE = "potato_dev";
const env = parseEnv(readFileSync(".env.development.local", "utf8"));
const url = env.DATABASE_URL;
if (!url) throw new Error(".env.development.local has no DATABASE_URL");
const database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
if (database !== REQUIRED_DATABASE) {
  console.error(`Refusing to run: expected database "${REQUIRED_DATABASE}", found "${database}".`);
  process.exit(1);
}
process.env.DATABASE_URL = url;

const { getDb } = await import("../src/db/client");
const { users } = await import("../src/db/schema");
const lib = await import("../src/core/library");
const lists = await import("../src/core/lists");
const { PostgresCacheStore } = await import("../src/core/cache");
const { SKIP_DAYS } = await import("../src/core/deck/constants");
type TitleRecord = import("../src/core/library").TitleRecord;
type TitleId = import("../src/core/types").TitleId;

const db = getDb();
const [{ current_database: live }] = (await db.execute(sql`select current_database()`)).rows as [{ current_database: string }];
if (live !== REQUIRED_DATABASE) {
  console.error(`Refusing to run: connected to "${live}", not "${REQUIRED_DATABASE}".`);
  process.exit(1);
}
console.log(`Connected to ${live}.`);

const runId = randomUUID().slice(0, 8);
const A = `itest-a-${runId}`;
const B = `itest-b-${runId}`;
const GHOST = `itest-ghost-${runId}`; // never inserted
await db.insert(users).values([
  { id: A, name: "Integration A", email: `${A}@example.invalid` },
  { id: B, name: "Integration B", email: `${B}@example.invalid` },
]);

let t = Date.UTC(2026, 10, 1, 12, 0, 0, 0);
/** A strictly increasing clock, so every write has a distinct, known time. */
const tick = () => new Date((t += 1_000));

let titleSeq = 1000;
const fresh = (mediaType: "movie" | "tv" = "movie"): TitleId => ({ mediaType, tmdbId: ++titleSeq });
// Stands in for TMDB's country list, so country changes need no TMDB token or network.
const watchRegions = async () => [
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
];

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
const state = async (user: string, ref: TitleId) => unwrap(await lib.getTitleState(user, ref));
async function rowCount(user: string, ref: TitleId): Promise<number> {
  const res = await db.execute(
    sql`select count(*)::int as n from title_status where user_id = ${user} and media_type = ${ref.mediaType} and tmdb_id = ${ref.tmdbId}`,
  );
  return (res.rows[0] as { n: number }).n;
}

/** An assert.rejects check that the database refused with this SQLSTATE and constraint, not some other error. */
function sqlState(code: string, constraint: string) {
  return (error: unknown) => {
    for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
      const { code: c, constraint: k } = e as { code?: unknown; constraint?: unknown };
      if (c === code && k === constraint) return true;
    }
    throw new Error(`expected ${code} on ${constraint}, got: ${error instanceof Error ? error.message : String(error)}`);
  };
}

const results: { name: string; error?: unknown }[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name });
    console.log(`  pass  ${name}`);
  } catch (error) {
    results.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Runs an action, then undoes it, and checks the row is exactly as before (or gone, if there was none). */
async function actThenUndo(
  ref: TitleId,
  act: () => Promise<{ ok: true; value: { previous: TitleRecord | null; current: TitleRecord | null } } | { ok: false; error: unknown }>,
) {
  const before = await state(A, ref);
  const outcome = unwrap(await act());
  assert.deepEqual(outcome.previous, before, "previous is the row as it was");
  assert.deepEqual(await state(A, ref), outcome.current, "current is the row as it is now");
  // The undo value crosses JSON, as it would through the API.
  const undo = unwrap(await lib.restoreTitleState(A, ref, JSON.parse(JSON.stringify(outcome))));
  assert.deepEqual(undo.previous, outcome.current, "undo reports the state it replaced");
  assert.deepEqual(await state(A, ref), before, "undo restores the row exactly, timestamps included");
  return outcome;
}

try {
  console.log("Card actions");

  await check("each card action on a new title creates one row; undo deletes it", async () => {
    for (const act of ["pass", "watchlist", "skip", "seen"] as const) {
      const ref = fresh();
      const now = tick();
      const outcome = await actThenUndo(ref, () =>
        act === "pass"
          ? lib.passTitle(A, ref, { now })
          : act === "watchlist"
            ? lib.watchlistTitle(A, ref, { now })
            : act === "skip"
              ? lib.skipTitle(A, ref, { now })
              : lib.markSeen(A, ref, { rating: 4.5, review: "Good." }, { now }),
      );
      assert.equal(outcome.previous, null);
      assert.equal(outcome.current?.createdAt.getTime(), now.getTime());
      assert.equal(await rowCount(A, ref), 0, `${act} undo leaves no row`);
    }
  });

  await check("skip sets skipUntil to exactly SKIP_DAYS after now", async () => {
    const ref = fresh();
    const now = tick();
    const { current } = unwrap(await lib.skipTitle(A, ref, { now }));
    assert.equal(current?.skipUntil?.getTime(), now.getTime() + SKIP_DAYS * 86_400_000);
    assert.equal(current?.rating, null);
  });

  await check("every transition between statuses keeps one row and undoes exactly", async () => {
    const actions = {
      passed: (ref: TitleId, now: Date) => lib.passTitle(A, ref, { now }),
      watchlist: (ref: TitleId, now: Date) => lib.watchlistTitle(A, ref, { now }),
      skipped: (ref: TitleId, now: Date) => lib.skipTitle(A, ref, { now }),
      seen: (ref: TitleId, now: Date) => lib.markSeen(A, ref, { rating: 3, review: "Fine." }, { now }),
    };
    const statuses = Object.keys(actions) as (keyof typeof actions)[];
    for (const from of statuses) {
      for (const to of statuses) {
        // No card button moves a Seen title (issues 43, 65, and 74), checked below.
        if (from === "seen") continue;
        const ref = fresh();
        const first = unwrap(await actions[from](ref, tick()));
        const outcome = await actThenUndo(ref, () => actions[to](ref, tick()));
        assert.equal(outcome.current?.status, to, `${from} -> ${to}`);
        assert.equal(await rowCount(A, ref), 1, `${from} -> ${to} keeps one row`);
        // created_at keeps the first action's time. Columns the new status does not use are cleared.
        assert.equal(outcome.current?.createdAt.getTime(), first.current?.createdAt.getTime());
        if (to !== "seen") assert.equal(outcome.current?.rating, null);
        if (to !== "seen") assert.equal(outcome.current?.review, null);
        if (to !== "skipped") assert.equal(outcome.current?.skipUntil, null);
      }
    }
  });

  await check("markSeen on a Seen title changes nothing and says where it is, whatever the review (issue 65)", async () => {
    const ref = fresh();
    unwrap(await lib.markSeen(A, ref, { rating: 2, review: "Old." }, { now: tick() }));
    const before = await state(A, ref);
    for (const review of [undefined, null, "", "   ", "New."]) {
      const r = await lib.markSeen(A, ref, { rating: 3, review }, { now: tick() });
      assert.deepEqual(
        r,
        { ok: false, error: { code: "wrong_state", status: "seen", expected: ["watchlist", "passed", "skipped"] } },
        `review ${JSON.stringify(review)}`,
      );
      assert.deepEqual(await state(A, ref), before, `review ${JSON.stringify(review)} leaves the row exactly as it was`);
    }
  });

  await check("two devices: a stale card's Seen it never erases or replaces a review written elsewhere (issue 65)", async () => {
    // The phone shows the title's card while it is on the Watchlist, or on no list. Another device then marks it
    // Seen with a review. The phone's card still shows the old state, and the user taps Seen it.
    for (const startOn of ["watchlist", "none"] as const) {
      for (const review of [null, "", "Stale take."]) {
        const ref = fresh();
        if (startOn === "watchlist") unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
        unwrap(
          startOn === "watchlist"
            ? await lib.moveTitle(A, ref, { from: "watchlist", to: "seen", rating: 5, review: "Elsewhere." }, { now: tick() })
            : await lib.markSeen(A, ref, { rating: 5, review: "Elsewhere." }, { now: tick() }),
        );
        const elsewhere = await state(A, ref);
        const r = await lib.markSeen(A, ref, { rating: 3, review }, { now: tick() });
        const label = `${startOn}, review ${JSON.stringify(review)}`;
        assert.equal(!r.ok && r.error.code, "wrong_state", label);
        assert.deepEqual(await state(A, ref), elsewhere, `${label}: the rating and review written elsewhere survive`);
        assert.equal((await state(A, ref))?.review, "Elsewhere.");
      }
    }
  });

  const NOT_SEEN = ["watchlist", "passed", "skipped"];
  const sorts = {
    pass: (ref: TitleId, opts: object) => lib.passTitle(A, ref, { now: tick(), ...opts }),
    skip: (ref: TitleId, opts: object) => lib.skipTitle(A, ref, { now: tick(), ...opts }),
    watchlist: (ref: TitleId, opts: object) => lib.watchlistTitle(A, ref, { now: tick(), ...opts }),
  };
  /** Puts a fresh title on `startOn` (or no list), then marks it Seen "elsewhere", as another device would. */
  async function seenElsewhere(startOn: "none" | "watchlist" | "passed" | "skipped"): Promise<TitleId> {
    const ref = fresh();
    if (startOn !== "none") unwrap(await sorts[startOn === "passed" ? "pass" : startOn === "skipped" ? "skip" : "watchlist"](ref, {}));
    unwrap(
      startOn === "watchlist"
        ? await lib.moveTitle(A, ref, { from: "watchlist", to: "seen", rating: 5, review: "Elsewhere." }, { now: tick() })
        : await lib.markSeen(A, ref, { rating: 5, review: "Elsewhere." }, { now: tick() }),
    );
    return ref;
  }

  await check("Pass, Skip, or Watchlist never erases a Seen title's rating and review, whatever the caller sends (issues 43 and 74)", async () => {
    // The phone's card shows the title on no list or another list. Another device marks it Seen with a review.
    // The phone's card then gets Pass, Skip, or Watchlist. The option PR 78 used to let a Seen card move the title
    // (seenShown) is gone: smuggled in as an extra field, it changes nothing.
    for (const startOn of ["none", "watchlist", "passed", "skipped"] as const) {
      for (const kind of Object.keys(sorts) as (keyof typeof sorts)[]) {
        for (const opts of [{}, { seenShown: false }, { seenShown: true }]) {
          const ref = await seenElsewhere(startOn);
          const elsewhere = await state(A, ref);
          const label = `${startOn}, ${kind}, ${JSON.stringify(opts)}`;
          const r = await sorts[kind](ref, opts);
          assert.deepEqual(r, { ok: false, error: { code: "wrong_state", status: "seen", expected: NOT_SEEN } }, label);
          assert.deepEqual(await state(A, ref), elsewhere, `${label}: the row written elsewhere survives exactly`);
          assert.equal((await state(A, ref))?.review, "Elsewhere.", label);
        }
      }
    }
  });

  await check("a smuggled seenShown never lets Seen it replace a Seen row", async () => {
    const ref = await seenElsewhere("none");
    const elsewhere = await state(A, ref);
    const r = await lib.markSeen(A, ref, { rating: 1, review: "Over it." }, { now: tick(), seenShown: true } as object);
    assert.deepEqual(r, { ok: false, error: { code: "wrong_state", status: "seen", expected: NOT_SEEN } });
    assert.deepEqual(await state(A, ref), elsewhere);
  });

  await check("Pass, Skip, and Watchlist still move a title that is not Seen, stale or not, and undo restores it", async () => {
    // A stale card that showed another list (or none) still re-sorts the title (PR 48, judgment call 5).
    for (const startOn of ["none", "watchlist", "passed", "skipped"] as const) {
      for (const kind of Object.keys(sorts) as (keyof typeof sorts)[]) {
        const ref = fresh();
        if (startOn !== "none") unwrap(await sorts[startOn === "passed" ? "pass" : startOn === "skipped" ? "skip" : "watchlist"](ref, {}));
        const out = await actThenUndo(ref, () => sorts[kind](ref, {}));
        assert.equal(out.current?.status, kind === "pass" ? "passed" : kind === "skip" ? "skipped" : "watchlist");
      }
    }
  });

  await check("two devices at the same instant: a refusal always says Seen, never not_found, and the Seen row survives", async () => {
    // The phone's card shows no list. Another device marks the title Seen while the phone's Pass is in flight.
    // Whichever lands first, the review survives, and a refused Pass reports where the title really is.
    let refused = 0;
    for (let i = 0; i < 30; i++) {
      const ref = fresh();
      const [, pass] = await Promise.all([lib.markSeen(A, ref, { rating: 5, review: "Elsewhere." }, { now: tick() }), sorts.pass(ref, {})]);
      const row = await state(A, ref);
      assert.equal(row?.status, "seen", `round ${i}`);
      assert.equal(row?.review, "Elsewhere.", `round ${i}`);
      if (!pass.ok) {
        refused++;
        assert.deepEqual(pass.error, { code: "wrong_state", status: "seen", expected: NOT_SEEN }, `round ${i}: ${JSON.stringify(pass.error)}`);
      }
    }
    console.log(`        (${refused} of 30 Passes landed after the Seen write and were refused)`);
  });

  await check("markSeen still moves a title from no list or any other list, and undo restores the exact row", async () => {
    for (const from of ["none", "watchlist", "passed", "skipped"] as const) {
      const ref = fresh();
      if (from === "watchlist") unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
      if (from === "passed") unwrap(await lib.passTitle(A, ref, { now: tick() }));
      if (from === "skipped") unwrap(await lib.skipTitle(A, ref, { now: tick() }));
      for (const review of [undefined, null, "", "Mine."]) {
        const out = await actThenUndo(ref, () => lib.markSeen(A, ref, { rating: 4, review }, { now: tick() }));
        assert.equal(out.current?.status, "seen", `${from}, review ${JSON.stringify(review)}`);
        assert.equal(out.current?.review, review === "Mine." ? "Mine." : null);
      }
    }
  });

  await check("a Seen title's review can still be cleared on purpose, through the edit path", async () => {
    const ref = fresh();
    unwrap(await lib.markSeen(A, ref, { rating: 4, review: "To clear." }, { now: tick() }));
    const out = await actThenUndo(ref, () => lib.updateRatingReview(A, ref, { rating: 4, review: null }, { now: tick() }));
    assert.equal(out.current?.review, null);
  });

  console.log("Removing a rating and review (issue 43)");

  await check("removeRatingReview with the rating and review shown deletes the row; undo restores it exactly", async () => {
    // From markSeen and from a Watchlist move, with and without a review. A shown review left out means none.
    const cases = [
      { via: "markSeen", rating: 4.5, review: "Loved it.", shown: "Loved it." },
      { via: "markSeen", rating: 0.5, review: null, shown: null },
      { via: "markSeen", rating: 2, review: null, shown: undefined },
      { via: "move", rating: 5, review: "Again.", shown: "Again." },
    ] as const;
    for (const c of cases) {
      const ref = fresh();
      if (c.via === "move") {
        unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
        unwrap(await lib.moveTitle(A, ref, { from: "watchlist", to: "seen", rating: c.rating, review: c.review }, { now: tick() }));
      } else {
        unwrap(await lib.markSeen(A, ref, { rating: c.rating, review: c.review }, { now: tick() }));
      }
      const label = JSON.stringify(c);
      const out = await actThenUndo(ref, async () => {
        const r = await lib.removeRatingReview(A, ref, { rating: c.rating, review: c.shown });
        assert.equal(await rowCount(A, ref), 0, `${label}: the row is gone`);
        return r;
      });
      assert.equal(out.current, null, label);
      assert.equal(out.previous?.review, c.review, label);
    }
  });

  await check("after a removal the title is on no list, so a card button sorts it again (the rewatch path)", async () => {
    const ref = await seenElsewhere("none");
    unwrap(await lib.removeRatingReview(A, ref, { rating: 5, review: "Elsewhere." }));
    const states = unwrap(await lib.getUserTitleStates(A));
    assert.equal(states.some((s) => s.mediaType === ref.mediaType && s.tmdbId === ref.tmdbId), false);
    const { current } = unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    assert.equal(current?.status, "watchlist");
    assert.equal(current?.rating, null);
  });

  await check("removeRatingReview refuses when the rating or review differs from what was shown, changing nothing", async () => {
    const ref = await seenElsewhere("none"); // 5 stars, "Elsewhere."
    const before = await state(A, ref);
    for (const shown of [
      { rating: 4.5, review: "Elsewhere." },
      { rating: 5, review: "Older take." },
      { rating: 5, review: null },
      { rating: 5 },
      { rating: 5, review: "elsewhere." },
    ]) {
      const r = await lib.removeRatingReview(A, ref, shown);
      // Its own code: the title is Seen as expected, but not with what was shown.
      assert.deepEqual(r, { ok: false, error: { code: "stale_value", status: "seen" } }, JSON.stringify(shown));
      assert.deepEqual(await state(A, ref), before, JSON.stringify(shown));
    }
    // A shown review that is null never matches a stored one, and a shown one never matches none. A blank shown
    // review is compared as it is, so it doesn't match none either.
    const bare = fresh();
    unwrap(await lib.markSeen(A, bare, { rating: 3 }, { now: tick() }));
    for (const review of ["Something.", "", "  "]) {
      const r = await lib.removeRatingReview(A, bare, { rating: 3, review });
      assert.equal(!r.ok && r.error.code, "stale_value", JSON.stringify(review));
    }
    assert.equal((await state(A, bare))?.status, "seen");
  });

  await check("a Seen row whose stored review is blank (put back by an undo) can be removed by showing it as stored", async () => {
    // No write stores a blank review, but restoreTitleState puts back whatever the undo carries.
    const ref = fresh();
    unwrap(await lib.markSeen(A, ref, { rating: 3, review: "Placeholder." }, { now: tick() }));
    const removed = unwrap(await lib.removeRatingReview(A, ref, { rating: 3, review: "Placeholder." }));
    const blank = JSON.parse(JSON.stringify(removed));
    blank.previous.review = "   ";
    unwrap(await lib.restoreTitleState(A, ref, blank));
    assert.equal((await state(A, ref))?.review, "   ");
    const none = await lib.removeRatingReview(A, ref, { rating: 3, review: null });
    assert.equal(!none.ok && none.error.code, "stale_value");
    unwrap(await lib.removeRatingReview(A, ref, { rating: 3, review: "   " }));
    assert.equal(await rowCount(A, ref), 0);
  });

  await check("two devices: a removal shown an older review never erases a newer one written elsewhere", async () => {
    const ref = fresh();
    unwrap(await lib.markSeen(A, ref, { rating: 3, review: "First take." }, { now: tick() })); // the phone shows this
    unwrap(await lib.updateRatingReview(A, ref, { rating: 4, review: "Rewatched, better." }, { now: tick() })); // elsewhere
    const after = await state(A, ref);
    const r = await lib.removeRatingReview(A, ref, { rating: 3, review: "First take." });
    assert.equal(!r.ok && r.error.code, "stale_value");
    assert.deepEqual(await state(A, ref), after);
  });

  await check("two devices at the same instant: a removal and an edit never both land", async () => {
    // The phone removes what it showed while another device edits the review. Either the edit lands first and the
    // removal refuses, or the removal lands first and the edit finds no Seen row. The newer review is never erased.
    let editsFirst = 0;
    for (let i = 0; i < 20; i++) {
      const ref = fresh();
      unwrap(await lib.markSeen(A, ref, { rating: 3, review: "Shown." }, { now: tick() }));
      const [removed, edited] = await Promise.all([
        lib.removeRatingReview(A, ref, { rating: 3, review: "Shown." }),
        lib.updateRatingReview(A, ref, { review: "Newer." }, { now: tick() }),
      ]);
      assert.notEqual(removed.ok && edited.ok, true, `round ${i}: both landed`);
      const row = await state(A, ref);
      if (edited.ok) {
        editsFirst++;
        assert.equal(row?.review, "Newer.", `round ${i}`);
      } else {
        assert.ok(removed.ok, `round ${i}: one of the two lands`);
        assert.equal(row, null, `round ${i}`);
      }
    }
    console.log(`        (${editsFirst} of 20 edits landed first)`);
  });

  await check("removeRatingReview refuses a title that is not Seen, or on no list, changing nothing", async () => {
    assert.deepEqual(await lib.removeRatingReview(A, fresh(), { rating: 3 }), { ok: false, error: { code: "not_found" } });
    for (const kind of Object.keys(sorts) as (keyof typeof sorts)[]) {
      const ref = fresh();
      unwrap(await sorts[kind](ref, {}));
      const before = await state(A, ref);
      const r = await lib.removeRatingReview(A, ref, { rating: 3 });
      assert.deepEqual(r, { ok: false, error: { code: "wrong_state", status: before!.status, expected: ["seen"] } }, kind);
      assert.deepEqual(await state(A, ref), before, kind);
    }
  });

  await check("removeRatingReview needs the shown rating, and checks the shown review", async () => {
    const ref = await seenElsewhere("none");
    const before = await state(A, ref);
    for (const shown of [{}, null, { rating: 0 }, { review: "Elsewhere." }]) {
      const r = await lib.removeRatingReview(A, ref, shown as never);
      assert.equal(!r.ok && r.error.code, "invalid_rating", JSON.stringify(shown));
    }
    const bad = await lib.removeRatingReview(A, ref, { rating: 5, review: 42 } as never);
    assert.equal(!bad.ok && bad.error.code, "invalid_review");
    assert.deepEqual(await state(A, ref), before);
  });

  await check("removeTitle refuses a Seen title, so it can't erase a rating and review either", async () => {
    for (const startOn of ["none", "watchlist"] as const) {
      const ref = await seenElsewhere(startOn);
      const before = await state(A, ref);
      assert.deepEqual(await lib.removeTitle(A, ref), { ok: false, error: { code: "wrong_state", status: "seen", expected: NOT_SEEN } });
      assert.deepEqual(await state(A, ref), before);
    }
  });

  await check("two removeTitle calls at the same instant both succeed: a row that vanished is not called Seen", async () => {
    for (let i = 0; i < 20; i++) {
      const ref = fresh();
      unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
      const both = await Promise.all([lib.removeTitle(A, ref), lib.removeTitle(A, ref)]);
      for (const r of both) assert.ok(r.ok, `round ${i}: ${JSON.stringify(r)}`);
      assert.equal(both.filter((r) => r.ok && r.value.previous !== null).length, 1, `round ${i}: exactly one deleted the row`);
      assert.equal(await rowCount(A, ref), 0, `round ${i}`);
    }
  });

  await check("an undo built by hand can't take a title off the Seen list without its exact rating and review", async () => {
    // markSeen on a new title: undo deletes the row. Forge the current side with another rating or review.
    const made = fresh();
    const seen = JSON.parse(JSON.stringify(unwrap(await lib.markSeen(A, made, { rating: 4, review: "Mine." }, { now: tick() }))));
    const before = await state(A, made);
    for (const forged of [{ rating: 3 }, { review: "Other." }, { review: null }]) {
      const r = await lib.restoreTitleState(A, made, { ...seen, current: { ...seen.current, ...forged } });
      assert.deepEqual(r, { ok: false, error: { code: "stale_value", status: "seen" } }, JSON.stringify(forged));
      assert.deepEqual(await state(A, made), before, JSON.stringify(forged));
    }
    // Watchlist to Seen: undo moves the row back to Watchlist. Same check.
    const moved = fresh();
    unwrap(await lib.watchlistTitle(A, moved, { now: tick() }));
    const move = JSON.parse(
      JSON.stringify(unwrap(await lib.moveTitle(A, moved, { from: "watchlist", to: "seen", rating: 5, review: "Yes." }, { now: tick() }))),
    );
    const movedBefore = await state(A, moved);
    const r = await lib.restoreTitleState(A, moved, { ...move, current: { ...move.current, review: "No." } });
    assert.deepEqual(r, { ok: false, error: { code: "stale_value", status: "seen" } });
    assert.deepEqual(await state(A, moved), movedBefore);
    // The real undo values still work.
    unwrap(await lib.restoreTitleState(A, made, seen));
    assert.equal(await rowCount(A, made), 0);
    unwrap(await lib.restoreTitleState(A, moved, move));
    assert.equal((await state(A, moved))?.status, "watchlist");
  });

  await check("a removal, its undo, and the redo (the undo's result passed back) all pass the Seen value check", async () => {
    const ref = fresh();
    unwrap(await lib.markSeen(A, ref, { rating: 2.5, review: "Meh." }, { now: tick() }));
    const before = await state(A, ref);
    const removed = unwrap(await lib.removeRatingReview(A, ref, { rating: 2.5, review: "Meh." }));
    const undone = unwrap(await lib.restoreTitleState(A, ref, JSON.parse(JSON.stringify(removed))));
    assert.deepEqual(await state(A, ref), before);
    unwrap(await lib.restoreTitleState(A, ref, JSON.parse(JSON.stringify(undone))));
    assert.equal(await rowCount(A, ref), 0);
  });

  await check("markSeen with no review on a title that was not seen writes no review", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const { current } = unwrap(await lib.markSeen(A, ref, { rating: 4 }, { now: tick() }));
    assert.equal(current?.review, null);
  });

  await check("a review with a NUL character is invalid_review, not a database error", async () => {
    const ref = fresh();
    const r = await lib.markSeen(A, ref, { rating: 4, review: "bad\u0000byte" });
    assert.equal(!r.ok && r.error.code, "invalid_review");
    assert.equal(await rowCount(A, ref), 0);
  });

  console.log("Rating bounds");

  await check("every half step from 0.5 to 5 stores exactly", async () => {
    for (let r = 0.5; r <= 5; r += 0.5) {
      const ref = fresh();
      unwrap(await lib.markSeen(A, ref, { rating: r }, { now: tick() }));
      assert.equal((await state(A, ref))?.rating, r);
    }
  });

  await check("off-scale ratings return invalid_rating and change nothing", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const before = await state(A, ref);
    for (const rating of [0, 0.25, 5.5, 3.3, -1, Number.NaN]) {
      const r = await lib.markSeen(A, ref, { rating });
      assert.equal(!r.ok && r.error.code, "invalid_rating", `rating ${rating}`);
    }
    assert.deepEqual(await state(A, ref), before);
  });

  await check("the database refuses an off-scale rating written around the core", async () => {
    const ref = fresh();
    await assert.rejects(
      db.execute(sql`insert into title_status (user_id, media_type, tmdb_id, status, rating)
        values (${A}, ${ref.mediaType}, ${ref.tmdbId}, 'seen', 5.5)`),
      sqlState("23514", "title_status_rating_scale_check"),
    );
    await assert.rejects(
      db.execute(sql`insert into title_status (user_id, media_type, tmdb_id, status, rating)
        values (${A}, ${ref.mediaType}, ${ref.tmdbId}, 'seen', 3.3)`),
      sqlState("23514", "title_status_rating_scale_check"),
    );
    assert.equal(await rowCount(A, ref), 0);
  });

  console.log("One row per title");

  await check("the primary key refuses a second row for the same title", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    await assert.rejects(
      db.execute(sql`insert into title_status (user_id, media_type, tmdb_id, status)
        values (${A}, ${ref.mediaType}, ${ref.tmdbId}, 'passed')`),
      sqlState("23505", "title_status_pkey"),
    );
    assert.equal(await rowCount(A, ref), 1);
  });

  await check("movie and tv with the same TMDB ID are different titles", async () => {
    const id = ++titleSeq;
    unwrap(await lib.watchlistTitle(A, { mediaType: "movie", tmdbId: id }, { now: tick() }));
    unwrap(await lib.passTitle(A, { mediaType: "tv", tmdbId: id }, { now: tick() }));
    assert.equal((await state(A, { mediaType: "movie", tmdbId: id }))?.status, "watchlist");
    assert.equal((await state(A, { mediaType: "tv", tmdbId: id }))?.status, "passed");
  });

  await check("one user's actions never touch another user's row", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(B, ref, { now: tick() }));
    const bBefore = await state(B, ref);
    unwrap(await lib.markSeen(A, ref, { rating: 1 }, { now: tick() }));
    unwrap(await lib.removeRatingReview(A, ref, { rating: 1 }));
    unwrap(await lib.passTitle(A, ref, { now: tick() }));
    unwrap(await lib.removeTitle(A, ref));
    assert.deepEqual(await state(B, ref), bBefore);
  });

  console.log("Edits and moves");

  await check("updateRatingReview: rating only keeps the review; null clears it; undo restores", async () => {
    const ref = fresh();
    unwrap(await lib.markSeen(A, ref, { rating: 3, review: "First take." }, { now: tick() }));
    const r1 = await actThenUndo(ref, () => lib.updateRatingReview(A, ref, { rating: 4 }, { now: tick() }));
    assert.equal(r1.current?.rating, 4);
    assert.equal(r1.current?.review, "First take.");
    const r2 = await actThenUndo(ref, () => lib.updateRatingReview(A, ref, { review: null }, { now: tick() }));
    assert.equal(r2.current?.review, null);
    assert.equal(r2.current?.rating, 3);
    const r3 = await actThenUndo(ref, () => lib.updateRatingReview(A, ref, { review: "Better." }, { now: tick() }));
    assert.equal(r3.current?.review, "Better.");
  });

  await check("updateRatingReview refuses a title that is not seen, or not there", async () => {
    const ref = fresh();
    const missing = await lib.updateRatingReview(A, ref, { rating: 4 });
    assert.deepEqual(missing, { ok: false, error: { code: "not_found" } });
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const before = await state(A, ref);
    const wrong = await lib.updateRatingReview(A, ref, { rating: 4 });
    assert.deepEqual(wrong, { ok: false, error: { code: "wrong_state", status: "watchlist", expected: ["seen"] } });
    assert.deepEqual(await state(A, ref), before);
    const bad = await lib.updateRatingReview(A, ref, { rating: 6 });
    assert.equal(!bad.ok && bad.error.code, "invalid_rating");
  });

  await check("moveTitle Watchlist to Seen asks for a rating; undo restores", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const noRating = await lib.moveTitle(A, ref, { from: "watchlist", to: "seen" } as never);
    assert.equal(!noRating.ok && noRating.error.code, "invalid_rating");
    const out = await actThenUndo(ref, () =>
      lib.moveTitle(A, ref, { from: "watchlist", to: "seen", rating: 5, review: "Worth it." }, { now: tick() }),
    );
    assert.equal(out.current?.status, "seen");
    assert.equal(out.current?.rating, 5);
    assert.equal(out.current?.review, "Worth it.");
  });

  await check("moveTitle Passed to Watchlist; undo restores", async () => {
    const ref = fresh();
    unwrap(await lib.passTitle(A, ref, { now: tick() }));
    const out = await actThenUndo(ref, () => lib.moveTitle(A, ref, { from: "passed", to: "watchlist" }, { now: tick() }));
    assert.equal(out.current?.status, "watchlist");
  });

  await check("moveTitle refuses a stale from-list, a missing title, and an unlisted move", async () => {
    const ref = fresh();
    assert.deepEqual(await lib.moveTitle(A, ref, { from: "passed", to: "watchlist" }), { ok: false, error: { code: "not_found" } });
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const before = await state(A, ref);
    assert.deepEqual(await lib.moveTitle(A, ref, { from: "passed", to: "watchlist" }), {
      ok: false,
      error: { code: "wrong_state", status: "watchlist", expected: ["passed"] },
    });
    const unlisted = await lib.moveTitle(A, ref, { from: "watchlist", to: "passed" } as never);
    assert.equal(!unlisted.ok && unlisted.error.code, "invalid_move");
    assert.deepEqual(await state(A, ref), before);
  });

  await check("a refused edit or Watchlist-to-Seen reads where the title is now (issue 79)", async () => {
    // Edit rating, after another device removed the rating and put the title on the Watchlist.
    const ref = fresh();
    unwrap(await lib.markSeen(A, ref, { rating: 4, review: "Shown." }, { now: tick() }));
    unwrap(await lib.removeRatingReview(A, ref, { rating: 4, review: "Shown." })); // elsewhere
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() })); // elsewhere
    const before = await state(A, ref);
    const edit = await lib.updateRatingReview(A, ref, { rating: 2, review: "Typed here." });
    assert.equal(edit.ok, false);
    if (edit.ok) return;
    assert.deepEqual(await lib.readChangedElsewhere(A, ref, edit.error), { current: before });
    assert.deepEqual(await state(A, ref), before);

    // Edit rating, on no list now.
    const gone = fresh();
    const none = await lib.updateRatingReview(A, gone, { rating: 2 });
    assert.equal(!none.ok && none.error.code, "not_found");
    if (none.ok) return;
    assert.deepEqual(await lib.readChangedElsewhere(A, gone, none.error), { current: null });

    // Watchlist to Seen, after another device marked it Seen: the row read carries that device's rating and review.
    const marked = fresh();
    unwrap(await lib.watchlistTitle(A, marked, { now: tick() }));
    unwrap(await lib.markSeen(A, marked, { rating: 5, review: "From the other device." }, { now: tick() })); // elsewhere
    const seenRow = await state(A, marked);
    const move = await lib.moveTitle(A, marked, { from: "watchlist", to: "seen", rating: 1, review: "Typed here." });
    assert.equal(move.ok, false);
    if (move.ok) return;
    assert.deepEqual(await lib.readChangedElsewhere(A, marked, move.error), { current: seenRow });
    assert.deepEqual(await state(A, marked), seenRow);

    // Bad input is not a change elsewhere: no read, null.
    const bad = await lib.updateRatingReview(A, marked, { rating: 6 });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(await lib.readChangedElsewhere(A, marked, bad.error), null);
  });

  console.log("Remove and restore");

  await check("removeTitle deletes a row that is not Seen, the deck sees it gone, and undo brings it back exactly", async () => {
    for (const kind of Object.keys(sorts) as (keyof typeof sorts)[]) {
      const ref = fresh();
      unwrap(await sorts[kind](ref, {}));
      const out = await actThenUndo(ref, async () => {
        const r = await lib.removeTitle(A, ref);
        const states = unwrap(await lib.getUserTitleStates(A));
        assert.equal(states.some((s) => s.mediaType === ref.mediaType && s.tmdbId === ref.tmdbId), false);
        return r;
      });
      assert.equal(out.current, null);
      assert.equal(out.previous?.status, kind === "pass" ? "passed" : kind === "skip" ? "skipped" : "watchlist");
    }
  });

  await check("removing a title with no row is not an error", async () => {
    assert.deepEqual(unwrap(await lib.removeTitle(A, fresh())), { previous: null, current: null });
  });

  await check("undo of an undo redoes the action", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const act = unwrap(await lib.passTitle(A, ref, { now: tick() }));
    const undo = unwrap(await lib.restoreTitleState(A, ref, act));
    unwrap(await lib.restoreTitleState(A, ref, undo));
    assert.deepEqual(await state(A, ref), act.current);
    // Redo of a remove's undo, too.
    const removed = unwrap(await lib.removeTitle(A, ref));
    const putBack = unwrap(await lib.restoreTitleState(A, ref, removed));
    unwrap(await lib.restoreTitleState(A, ref, putBack));
    assert.equal(await state(A, ref), null);
  });

  await check("restore refuses a state for another title and a malformed state, changing nothing", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const act = unwrap(await lib.passTitle(A, ref, { now: tick() }));
    const before = await state(A, ref);
    const other = { previous: { ...act.previous!, tmdbId: ref.tmdbId + 1 }, current: act.current };
    assert.equal((await lib.restoreTitleState(A, ref, other)).ok, false);
    const malformed = { previous: { ...act.previous!, status: "seen" as const, rating: 9 }, current: act.current };
    assert.equal((await lib.restoreTitleState(A, ref, malformed)).ok, false);
    const noCurrent = { previous: act.previous } as never;
    assert.equal((await lib.restoreTitleState(A, ref, noCurrent)).ok, false);
    assert.deepEqual(await state(A, ref), before);
  });

  console.log("Stale undo (compare-and-set)");

  await check("undo works with the default clock (no now passed), as the app will call it", async () => {
    const ref = fresh();
    await actThenUndo(ref, () => lib.watchlistTitle(A, ref));
    unwrap(await lib.watchlistTitle(A, ref));
    await actThenUndo(ref, () => lib.moveTitle(A, ref, { from: "watchlist", to: "seen", rating: 3 }));
    unwrap(await lib.markSeen(A, ref, { rating: 3 }));
    await actThenUndo(ref, () => lib.updateRatingReview(A, ref, { review: "Fine." }));
    await actThenUndo(ref, () => lib.removeRatingReview(A, ref, { rating: 3 }));
    unwrap(await lib.removeRatingReview(A, ref, { rating: 3 }));
    unwrap(await lib.passTitle(A, ref));
    await actThenUndo(ref, () => lib.removeTitle(A, ref));
  });

  await check("a stale undo of a change refuses to overwrite a later edit", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const seen = unwrap(await lib.markSeen(A, ref, { rating: 4 }, { now: tick() })); // undo entry held on the phone
    unwrap(await lib.updateRatingReview(A, ref, { rating: 5, review: "Rewatched." }, { now: tick() })); // elsewhere
    const after = await state(A, ref);
    const r = await lib.restoreTitleState(A, ref, JSON.parse(JSON.stringify(seen)));
    assert.deepEqual(r, { ok: false, error: { code: "wrong_state", status: "seen", expected: ["seen"] } });
    assert.deepEqual(await state(A, ref), after, "the later rating and review survive");
  });

  await check("a stale undo of a first action refuses to delete a row edited since", async () => {
    const ref = fresh();
    const first = unwrap(await lib.markSeen(A, ref, { rating: 3 }, { now: tick() })); // previous: null
    unwrap(await lib.updateRatingReview(A, ref, { review: "Added later." }, { now: tick() }));
    const after = await state(A, ref);
    const r = await lib.restoreTitleState(A, ref, first);
    assert.deepEqual(r, { ok: false, error: { code: "wrong_state", status: "seen", expected: ["seen"] } });
    assert.deepEqual(await state(A, ref), after);
  });

  await check("a stale undo of a status change refuses a row that moved to another list", async () => {
    const ref = fresh();
    unwrap(await lib.passTitle(A, ref, { now: tick() }));
    const toWatchlist = unwrap(await lib.moveTitle(A, ref, { from: "passed", to: "watchlist" }, { now: tick() }));
    unwrap(await lib.skipTitle(A, ref, { now: tick() }));
    const after = await state(A, ref);
    const r = await lib.restoreTitleState(A, ref, toWatchlist);
    assert.deepEqual(r, { ok: false, error: { code: "wrong_state", status: "skipped", expected: ["watchlist"] } });
    assert.deepEqual(await state(A, ref), after);
  });

  await check("a stale undo of a removal refuses to overwrite a row added back since", async () => {
    const ref = fresh();
    unwrap(await lib.markSeen(A, ref, { rating: 2, review: "Meh." }, { now: tick() }));
    const removed = unwrap(await lib.removeRatingReview(A, ref, { rating: 2, review: "Meh." }));
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const after = await state(A, ref);
    const r = await lib.restoreTitleState(A, ref, removed);
    assert.deepEqual(r, { ok: false, error: { code: "wrong_state", status: "watchlist", expected: [] } });
    assert.deepEqual(await state(A, ref), after);
  });

  await check("a stale undo whose row was removed since returns not_found and creates nothing", async () => {
    const ref = fresh();
    unwrap(await lib.watchlistTitle(A, ref, { now: tick() }));
    const passed = unwrap(await lib.passTitle(A, ref, { now: tick() }));
    unwrap(await lib.removeTitle(A, ref));
    assert.deepEqual(await lib.restoreTitleState(A, ref, passed), { ok: false, error: { code: "not_found" } });
    assert.equal(await rowCount(A, ref), 0);
  });

  console.log("Queries");

  await check("getUserTitleStates returns only the deck's fields, with skipUntil on skipped rows", async () => {
    const states = unwrap(await lib.getUserTitleStates(B));
    assert.ok(states.length >= 1);
    for (const s of states) {
      const keys = Object.keys(s).sort();
      assert.deepEqual(keys, s.status === "skipped" ? ["mediaType", "skipUntil", "status", "tmdbId"] : ["mediaType", "status", "tmdbId"]);
    }
    const ref = fresh();
    unwrap(await lib.skipTitle(B, ref, { now: tick() }));
    const skipped = unwrap(await lib.getUserTitleStates(B)).find((s) => s.tmdbId === ref.tmdbId);
    assert.ok(skipped?.status === "skipped" && skipped.skipUntil instanceof Date);
  });

  await check("getRatedCount counts seen rows only", async () => {
    const before = unwrap(await lib.getRatedCount(B));
    unwrap(await lib.markSeen(B, fresh(), { rating: 4 }, { now: tick() }));
    unwrap(await lib.watchlistTitle(B, fresh(), { now: tick() }));
    assert.equal(unwrap(await lib.getRatedCount(B)), before + 1);
  });

  await check("getTitleState is null for an untouched title", async () => {
    assert.equal(await state(A, fresh()), null);
  });

  await check("getList pages a list in order with no repeats, and carries timestamps, rating, review", async () => {
    const C = `itest-c-${runId}`;
    await db.insert(users).values({ id: C, name: "Integration C", email: `${C}@example.invalid` });
    try {
      const refs = [fresh(), fresh(), fresh(), fresh(), fresh()];
      for (const [i, ref] of refs.entries()) unwrap(await lib.markSeen(C, ref, { rating: (i % 3) + 1, review: `R${i}` }, { now: tick() }));
      unwrap(await lib.watchlistTitle(C, fresh(), { now: tick() }));
      const got: number[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof lib.getList>> = await lib.getList(C, "seen", { limit: 2, cursor });
        const p = unwrap(page);
        got.push(...p.entries.map((e) => e.tmdbId));
        for (const e of p.entries) assert.ok(e.createdAt instanceof Date && e.rating !== null && e.review?.startsWith("R"));
        cursor = p.nextCursor;
      } while (cursor);
      assert.deepEqual(got, refs.map((r) => r.tmdbId).reverse(), "newest change first");
      const byRating = unwrap(await lib.getList(C, "seen", { sort: "rating_desc" })).entries.map((e) => e.rating);
      assert.deepEqual(byRating, [3, 2, 2, 1, 1]);
      assert.equal(unwrap(await lib.getList(C, "watchlist")).entries.length, 1);
      assert.equal(unwrap(await lib.getList(C, "passed")).entries.length, 0);
    } finally {
      await db.delete(users).where(inArray(users.id, [C]));
    }
  });

  await check("getList filters with the deck's matchesFilters through a details lookup", async () => {
    const D = `itest-d-${runId}`;
    await db.insert(users).values({ id: D, name: "Integration D", email: `${D}@example.invalid` });
    try {
      const sciFiOnNetflix = fresh("tv");
      const sciFiElsewhere = fresh("tv");
      const drama = fresh("movie");
      for (const ref of [sciFiOnNetflix, sciFiElsewhere, drama]) unwrap(await lib.watchlistTitle(D, ref, { now: tick() }));
      unwrap(await lib.updateUserSettings(D, { providerIds: [8] }));
      const meta = new Map([
        [sciFiOnNetflix.tmdbId, { genreIds: [10765], year: 2023, providerIds: [8] }],
        [sciFiElsewhere.tmdbId, { genreIds: [10765], year: 2023, providerIds: [337] }],
        [drama.tmdbId, { genreIds: [18], year: 2001, providerIds: [8] }],
      ]);
      let lookups = 0;
      const countries: (string | undefined)[] = [];
      const lookupDetails = async (refs: readonly TitleId[], context?: { country?: string }) => {
        lookups++;
        countries.push(context?.country);
        return new Map(
          refs.map((r) => [
            `${r.mediaType}:${r.tmdbId}`,
            { ...r, title: "x", popularity: 1, tmdbVoteAverage: 7, tmdbVoteCount: 10, ...meta.get(r.tmdbId)! },
          ]),
        );
      };
      const needs = await lib.getList(D, "watchlist", { filters: { genreIds: [10765] } });
      assert.deepEqual(needs, { ok: false, error: { code: "details_lookup_required" } });
      const page = unwrap(
        await lib.getList(D, "watchlist", { filters: { genreIds: [10765], era: { fromYear: 2020 }, onMyServices: true }, lookupDetails }),
      );
      assert.deepEqual(page.entries.map((e) => e.tmdbId), [sciFiOnNetflix.tmdbId]);
      assert.equal(page.entries[0]?.details?.year, 2023);
      assert.equal(lookups, 1, "one batched lookup");
      assert.deepEqual(countries, ["US"], "on my services passes the user's country to the lookup");
      const genreOnly = unwrap(await lib.getList(D, "watchlist", { filters: { genreIds: [10765] }, lookupDetails }));
      assert.equal(genreOnly.entries.length, 2);
      assert.deepEqual(countries, ["US", undefined], "no country without on my services");
      // A minimum IMDb rating asks the lookup for ratings, and keeps only the rows rated at or above it.
      const contexts: unknown[] = [];
      const ratedLookup = async (refs: readonly TitleId[], context?: { country?: string; imdbRatings?: boolean }) => {
        contexts.push(context);
        return new Map(
          refs.map((r) => [
            `${r.mediaType}:${r.tmdbId}`,
            {
              ...r,
              title: "x",
              popularity: 1,
              tmdbVoteAverage: 9,
              tmdbVoteCount: 10,
              ...meta.get(r.tmdbId)!,
              ...(r.tmdbId === sciFiOnNetflix.tmdbId ? { imdb: { rating: 8.1, votes: 5000 } } : {}),
            },
          ]),
        );
      };
      const rated = unwrap(await lib.getList(D, "watchlist", { filters: { minImdbRating: 7.5 }, lookupDetails: ratedLookup }));
      assert.deepEqual(rated.entries.map((e) => e.tmdbId), [sciFiOnNetflix.tmdbId]);
      assert.deepEqual(contexts, [{ imdbRatings: true }], "a minimum IMDb rating asks the lookup for ratings");
      const tvOnly = unwrap(await lib.getList(D, "watchlist", { filters: { mediaTypes: ["tv"] } }));
      assert.equal(tvOnly.entries.length, 2, "media type needs no lookup");
      unwrap(await lib.updateUserSettings(D, { providerIds: [] }));
      const noServices = unwrap(await lib.getList(D, "watchlist", { filters: { onMyServices: true }, lookupDetails }));
      assert.deepEqual(noServices, { status: "watchlist", entries: [], nextCursor: null });
      assert.equal(lookups, 2, "no services: nothing can match, so no lookup");
    } finally {
      await db.delete(users).where(inArray(users.id, [D]));
    }
  });

  console.log("Settings");

  await check("getUserSettings creates the default row, update changes only the named fields", async () => {
    const s0 = unwrap(await lib.getUserSettings(A));
    assert.equal(s0.country, "US");
    assert.deepEqual(s0.providerIds, []);
    const s1 = unwrap(await lib.updateUserSettings(A, { country: "gb" }, { watchRegions }));
    assert.equal(s1.country, "GB");
    assert.deepEqual(s1.providerIds, []);
    const s2 = unwrap(await lib.updateUserSettings(A, { providerIds: [8, 337, 8] }));
    assert.equal(s2.country, "GB");
    assert.deepEqual(s2.providerIds, [8, 337]);
    assert.deepEqual(unwrap(await lib.getUserSettings(A)).providerIds, [8, 337]);
    const bad = await lib.updateUserSettings(A, { country: "Great Britain" });
    assert.equal(!bad.ok && bad.error.code, "invalid_settings");
  });

  await check("a country TMDB has no data for and too many services are refused, and nothing changes", async () => {
    const before = unwrap(await lib.getUserSettings(A));
    const zz = await lib.updateUserSettings(A, { country: "ZZ" }, { watchRegions });
    assert.deepEqual(zz, { ok: false, error: { code: "unknown_country", country: "ZZ" } });
    const many = Array.from({ length: lib.MAX_PROVIDER_IDS + 1 }, (_, i) => i + 1);
    const tooMany = await lib.updateUserSettings(A, { providerIds: many });
    assert.deepEqual(tooMany, { ok: false, error: { code: "too_many_services", max: lib.MAX_PROVIDER_IDS } });
    const after = unwrap(await lib.getUserSettings(A));
    assert.equal(after.country, before.country);
    assert.deepEqual(after.providerIds, before.providerIds);
  });

  await check("deck choice: default until saved, saved normalized, survives other settings writes, bad input changes nothing", async () => {
    const D = `itest-deck-choice-${runId}`;
    await db.insert(users).values({ id: D, name: "Integration Deck Choice", email: `${D}@example.invalid` });
    try {
      // No settings row yet: the read creates it and gives the default.
      assert.deepEqual(unwrap(await lib.getDeckChoice(D)), { mode: "blend", filters: { type: "all", genres: [], era: "any", minRating: "any", onMyServices: false } });
      const choice = { mode: "top_rated", filters: { type: "tv", genres: ["scifi", "nosuchgenre"], era: "recent", minRating: "7.5", onMyServices: true } };
      const saved = unwrap(await lib.saveDeckChoice(D, choice));
      assert.deepEqual(saved, { mode: "top_rated", filters: { type: "tv", genres: ["scifi"], era: "recent", minRating: "7.5", onMyServices: true } });
      assert.deepEqual(unwrap(await lib.getDeckChoice(D)), saved);
      // A settings change keeps the choice, and the choice keeps the settings.
      unwrap(await lib.updateUserSettings(D, { providerIds: [8] }));
      assert.deepEqual(unwrap(await lib.getDeckChoice(D)), saved);
      assert.deepEqual(unwrap(await lib.getUserSettings(D)).providerIds, [8]);
      const bad = await lib.saveDeckChoice(D, { mode: "box_office", filters: {} });
      assert.equal(!bad.ok && bad.error.code, "invalid_settings");
      assert.deepEqual(unwrap(await lib.getDeckChoice(D)), saved);
      assert.deepEqual(await lib.saveDeckChoice(GHOST, saved), { ok: false, error: { code: "unknown_user" } });
    } finally {
      await db.delete(users).where(inArray(users.id, [D]));
    }
  });

  console.log("Lists tab rows");

  await check("getListRows: each list's rows, newest change first, with metadata or null fallbacks", async () => {
    const W = `itest-lists-${runId}`;
    await db.insert(users).values({ id: W, name: "Integration Lists", email: `${W}@example.invalid` });
    try {
      const known = fresh();
      const unknown = fresh("tv");
      const passed = fresh();
      const seen = fresh();
      unwrap(await lib.watchlistTitle(W, known, { now: tick() }));
      unwrap(await lib.watchlistTitle(W, unknown, { now: tick() }));
      unwrap(await lib.passTitle(W, passed, { now: tick() }));
      unwrap(await lib.markSeen(W, seen, { rating: 3.5, review: "Fine." }, { now: tick() }));
      const asked: string[][] = [];
      const lookup = async (refs: readonly TitleId[]) => {
        asked.push(refs.map((r) => `${r.mediaType}:${r.tmdbId}`));
        const key = `${known.mediaType}:${known.tmdbId}`;
        return new Map(
          refs.some((r) => r.mediaType === known.mediaType && r.tmdbId === known.tmdbId)
            ? [[key, { ...known, title: "Known", year: 2001, posterPath: "/p.jpg" } as never]]
            : [],
        );
      };
      const all = unwrap(await lists.getAllLists(W, { lookup }));
      assert.deepEqual(
        all.watchlist.rows.map((r) => [r.mediaType, r.tmdbId, r.title, r.year, r.posterUrl]),
        [
          [unknown.mediaType, unknown.tmdbId, null, null, null],
          [known.mediaType, known.tmdbId, "Known", 2001, "https://image.tmdb.org/t/p/w185/p.jpg"],
        ],
      );
      assert.deepEqual(all.passed.rows.map((r) => r.tmdbId), [passed.tmdbId]);
      assert.deepEqual(all.seen.rows.map((r) => [r.tmdbId, r.rating, r.review]), [[seen.tmdbId, 3.5, "Fine."]]);
      assert.equal(all.watchlist.nextCursor, null);
      assert.equal(asked.length, 3, "one lookup per non-empty list");

      // Watchlist to Seen, then Passed to Watchlist: each list reflects the move.
      unwrap(await lib.moveTitle(W, known, { from: "watchlist", to: "seen", rating: 4.5, review: "Great." }, { now: tick() }));
      unwrap(await lib.moveTitle(W, passed, { from: "passed", to: "watchlist" }, { now: tick() }));
      const after = unwrap(await lists.getAllLists(W, { lookup }));
      assert.deepEqual(after.watchlist.rows.map((r) => r.tmdbId), [passed.tmdbId, unknown.tmdbId]);
      assert.deepEqual(after.seen.rows.map((r) => [r.tmdbId, r.rating, r.review, r.title]), [
        [known.tmdbId, 4.5, "Great.", "Known"],
        [seen.tmdbId, 3.5, "Fine.", null],
      ]);
      assert.deepEqual(after.passed.rows, []);
    } finally {
      await db.delete(users).where(inArray(users.id, [W]));
    }
  });

  await check("getListRows pages at LISTS_PAGE_SIZE and follows the cursor", async () => {
    const P = `itest-paging-${runId}`;
    await db.insert(users).values({ id: P, name: "Integration Paging", email: `${P}@example.invalid` });
    try {
      const total = lists.LISTS_PAGE_SIZE + 3;
      for (let i = 0; i < total; i++) unwrap(await lib.passTitle(P, fresh(), { now: tick() }));
      const lookup = async () => new Map();
      const first = unwrap(await lists.getListRows(P, "passed", { lookup }));
      assert.equal(first.rows.length, lists.LISTS_PAGE_SIZE);
      assert.notEqual(first.nextCursor, null);
      const second = unwrap(await lists.getListRows(P, "passed", { lookup, cursor: first.nextCursor }));
      assert.equal(second.rows.length, 3);
      assert.equal(second.nextCursor, null);
      const ids = new Set([...first.rows, ...second.rows].map((r) => r.tmdbId));
      assert.equal(ids.size, total, "no row repeats across pages");
    } finally {
      await db.delete(users).where(inArray(users.id, [P]));
    }
  });

  await check("PostgresCacheStore.getMany reads many keys in one statement; missing keys are absent", async () => {
    const store = new PostgresCacheStore();
    const k1 = `itest:${runId}:one`;
    const k2 = `itest:${runId}:two`;
    const expires = new Date(Date.UTC(2030, 0, 1));
    try {
      await store.set(k1, { n: 1 }, expires);
      await store.set(k2, { n: 2 }, expires);
      const got = await store.getMany([k1, k2, `itest:${runId}:missing`, k1]);
      assert.deepEqual([...got.keys()].sort(), [k1, k2]);
      assert.deepEqual(got.get(k2), { data: { n: 2 }, expiresAt: expires });
      assert.equal((await store.getMany([])).size, 0);
    } finally {
      await db.execute(sql`delete from tmdb_cache where key in (${k1}, ${k2})`);
    }
  });

  console.log("Unknown users and bad input");

  await check("writes for a user id with no users row return unknown_user", async () => {
    assert.deepEqual(await lib.watchlistTitle(GHOST, fresh()), { ok: false, error: { code: "unknown_user" } });
    assert.deepEqual(await lib.getUserSettings(GHOST), { ok: false, error: { code: "unknown_user" } });
    assert.deepEqual(await lib.updateUserSettings(GHOST, { country: "US" }, { watchRegions }), { ok: false, error: { code: "unknown_user" } });
  });

  await check("a bad title or user id is a typed error before any query", async () => {
    const r1 = await lib.passTitle(A, { mediaType: "film", tmdbId: 1 } as never);
    assert.equal(!r1.ok && r1.error.code, "invalid_title");
    const r2 = await lib.passTitle("", fresh());
    assert.equal(!r2.ok && r2.error.code, "invalid_user");
    const r3 = await lib.passTitle(A, { mediaType: "movie", tmdbId: 3_000_000_000 });
    assert.equal(!r3.ok && r3.error.code, "invalid_title");
    const r4 = await lib.getTitleState(A, { mediaType: "tv", tmdbId: 2_147_483_648 });
    assert.equal(!r4.ok && r4.error.code, "invalid_title");
  });

  await check("malformed list options and filters are invalid_list_query, not a throw", async () => {
    const bad: unknown[] = [
      "not an object",
      { filters: "x" },
      { filters: { mediaTypes: "movie" } },
      { filters: { genreIds: ["18"] } },
      { filters: { era: 2020 } },
      { filters: { era: { fromYear: "2020" } } },
      { filters: { onMyServices: "yes" } },
      { lookupDetails: "not a function" },
    ];
    for (const options of bad) {
      const r = await lib.getList(A, "watchlist", options as never);
      assert.equal(!r.ok && r.error.code, "invalid_list_query", JSON.stringify(options));
    }
    assert.equal((await lib.getList(A, "watchlist", null)).ok, true);
  });

  await check("a country that only becomes two ASCII letters when uppercased is invalid_settings", async () => {
    for (const country of ["ß", "ıt"]) {
      const r = await lib.updateUserSettings(A, { country });
      assert.equal(!r.ok && r.error.code, "invalid_settings", country);
    }
  });
} finally {
  await db.delete(users).where(inArray(users.id, [A, B]));
  const left = await db.execute(sql`select count(*)::int as n from title_status where user_id in (${A}, ${B})`);
  console.log(`Cleaned up test users (title_status rows left: ${(left.rows[0] as { n: number }).n}).`);
}

const failed = results.filter((r) => r.error);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed.`);
process.exit(failed.length ? 1 : 0);
