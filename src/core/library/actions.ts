// The writes behind the four card buttons and the Lists tab (CLAUDE.md rules
// 2 and 3, VISION invariants 2, 3, and 7). Each function takes the user id
// explicitly: the app layer resolves the session, so the UI, the API, and a
// future AI connection all call the same code.
//
// Each write is a single SQL statement. Its first CTE reads the row as it was
// and the next one writes, and both see the same snapshot, so the previous
// state comes back atomically with no transaction (the Neon HTTP driver has
// none). The read takes no row lock: a lock taken in the same statement as
// the write depends on which CTE the planner runs first, and a lock could not
// fix the one real race anyway. That race: two writes on the same user's same
// title land at once (a double tap on two devices). The later one can return
// a stale previous, and when the title had no row before both, a null
// previous, so undoing it deletes the row the earlier write made. The user
// can redo with one tap. Closing it needs a transaction with a retry, which
// this driver cannot do.
//
// Timestamps come from the caller's clock (`now`), at millisecond precision,
// so a state read back into JavaScript restores to exactly the same value.

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import type { TitleId } from "../types";
import { fail, ok, type LibraryResult } from "./errors";
import { FOREIGN_KEY_VIOLATION, pgErrorCode } from "./pg-error";
import { recordFromJson } from "./rows";
import { columnsFor, planMove, planRatingReviewPatch, type CardIntent, type StatusColumns } from "./transitions";
import type { ActionOptions, ActionOutcome, MoveRequest, RatingReviewPatch, TitleRecord, TitleRecordInput } from "./types";
import { parseTitleRecord, validateTitleRef, validateUserId } from "./validate";

type Outcome = LibraryResult<ActionOutcome>;

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function pk(userId: string, ref: TitleId): SQL {
  return sql`user_id = ${userId} and media_type = ${ref.mediaType} and tmdb_id = ${ref.tmdbId}`;
}

/** Runs a "prev, then write" statement and maps its two JSON columns. */
async function run(statement: SQL): Promise<ActionOutcome> {
  const result = await getDb().execute(statement);
  const row = (result.rows[0] ?? {}) as { previous?: unknown; current?: unknown };
  return { previous: recordFromJson(row.previous), current: recordFromJson(row.current) };
}

/** Turns a foreign-key violation on user_id into a typed error. Anything else is rethrown. */
async function guardUser(write: () => Promise<ActionOutcome>): Promise<Outcome> {
  try {
    return ok(await write());
  } catch (error) {
    if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) return fail({ code: "unknown_user" });
    throw error;
  }
}

function checkIds(userId: unknown, ref: unknown): LibraryResult<{ userId: string; ref: TitleId }> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const r = validateTitleRef(ref);
  if (!r.ok) return r;
  return ok({ userId: u.value, ref: r.value });
}

/**
 * One upsert under the composite primary key. A title has one row per user,
 * so writing a status moves the title off whatever list it was on (VISION
 * invariant 3). created_at keeps the first time the user acted on the title.
 */
function upsertStatement(userId: string, ref: TitleId, c: StatusColumns, now: Date): SQL {
  return sql`
    with prev as (
      select * from title_status where ${pk(userId, ref)}
    ), up as (
      insert into title_status as t
        (user_id, media_type, tmdb_id, status, rating, review, skip_until, created_at, updated_at)
      values
        (${userId}, ${ref.mediaType}, ${ref.tmdbId}, ${c.status}, ${c.rating}, ${c.review},
         ${iso(c.skipUntil)}, ${now.toISOString()}, ${now.toISOString()})
      on conflict (user_id, media_type, tmdb_id) do update set
        status = excluded.status,
        rating = excluded.rating,
        review = excluded.review,
        skip_until = excluded.skip_until,
        updated_at = excluded.updated_at
      returning t.*
    )
    select (select row_to_json(prev) from prev) as previous,
           (select row_to_json(up) from up) as current`;
}

async function cardAction(userId: unknown, ref: unknown, intent: CardIntent, options: ActionOptions): Promise<Outcome> {
  const ids = checkIds(userId, ref);
  if (!ids.ok) return ids;
  const now = options.now ?? new Date();
  const columns = columnsFor(intent, now);
  if (!columns.ok) return columns;
  return guardUser(() => run(upsertStatement(ids.value.userId, ids.value.ref, columns.value, now)));
}

/** Pass: the title goes to the Passed list. */
export function passTitle(userId: string, ref: TitleId, options: ActionOptions = {}): Promise<Outcome> {
  return cardAction(userId, ref, { status: "passed" }, options);
}

/** Watchlist: the title goes to the Watchlist. */
export function watchlistTitle(userId: string, ref: TitleId, options: ActionOptions = {}): Promise<Outcome> {
  return cardAction(userId, ref, { status: "watchlist" }, options);
}

/** Skip: no list. The title returns to the deck SKIP_DAYS from now (VISION invariant 1). */
export function skipTitle(userId: string, ref: TitleId, options: ActionOptions = {}): Promise<Outcome> {
  return cardAction(userId, ref, { status: "skipped" }, options);
}

/**
 * Seen it: the title goes to the Seen list with this rating (required) and
 * review (optional). The review written is exactly the one passed: leaving it
 * out writes no review, even if the title already had one.
 */
export function markSeen(
  userId: string,
  ref: TitleId,
  input: { rating: number; review?: string | null },
  options: ActionOptions = {},
): Promise<Outcome> {
  return cardAction(userId, ref, { status: "seen", rating: input?.rating, review: input?.review }, options);
}

/** Runs a guarded UPDATE and turns "no row changed" into not_found or wrong_state. */
async function guardedUpdate(
  userId: string,
  ref: TitleId,
  expected: TitleRecord["status"],
  set: SQL,
): Promise<Outcome> {
  const outcome = await run(sql`
    with prev as (
      select * from title_status where ${pk(userId, ref)}
    ), up as (
      update title_status set ${set}
      where ${pk(userId, ref)} and status = ${expected}
      returning *
    )
    select (select row_to_json(prev) from prev) as previous,
           (select row_to_json(up) from up) as current`);
  if (outcome.current) return ok(outcome);
  if (!outcome.previous) return fail({ code: "not_found" });
  return fail({ code: "wrong_state", status: outcome.previous.status, expected: [expected] });
}

/**
 * Edits the rating, the review, or both, on a Seen title, at any time (VISION:
 * Your lists). An absent field stays as it is. A null or blank review clears it.
 */
export async function updateRatingReview(
  userId: string,
  ref: TitleId,
  patch: RatingReviewPatch,
  options: ActionOptions = {},
): Promise<Outcome> {
  const ids = checkIds(userId, ref);
  if (!ids.ok) return ids;
  const planned = planRatingReviewPatch(patch);
  if (!planned.ok) return planned;
  const now = options.now ?? new Date();
  const sets: SQL[] = [];
  if (planned.value.rating !== undefined) sets.push(sql`rating = ${planned.value.rating}`);
  if ("review" in planned.value) sets.push(sql`review = ${planned.value.review ?? null}`);
  sets.push(sql`updated_at = ${now.toISOString()}`);
  return guardedUpdate(ids.value.userId, ids.value.ref, "seen", sql.join(sets, sql`, `));
}

/**
 * A Lists-tab move: Watchlist to Seen (with a rating), or Passed to Watchlist.
 * The title must be on the `from` list now. Otherwise nothing changes and the
 * result says where it is (wrong_state) or that it is on no list (not_found).
 */
export async function moveTitle(
  userId: string,
  ref: TitleId,
  move: MoveRequest,
  options: ActionOptions = {},
): Promise<Outcome> {
  const ids = checkIds(userId, ref);
  if (!ids.ok) return ids;
  const planned = planMove(move);
  if (!planned.ok) return planned;
  const now = options.now ?? new Date();
  const c = planned.value.columns;
  const set = sql`status = ${c.status}, rating = ${c.rating}, review = ${c.review},
    skip_until = ${iso(c.skipUntil)}, updated_at = ${now.toISOString()}`;
  return guardedUpdate(ids.value.userId, ids.value.ref, planned.value.from, set);
}

/**
 * Deletes the row, so the title is on no list and can come back to the deck.
 * Removing a title with no row is not an error: `previous` is null.
 */
export async function removeTitle(userId: string, ref: TitleId): Promise<Outcome> {
  const ids = checkIds(userId, ref);
  if (!ids.ok) return ids;
  const { userId: u, ref: r } = ids.value;
  return ok(
    await run(sql`
      with del as (delete from title_status where ${pk(u, r)} returning *)
      select (select row_to_json(del) from del) as previous, null as current`),
  );
}

/**
 * Undo (VISION invariant 2). Puts the title's row back to `previous` exactly,
 * timestamps included, or deletes the row when `previous` is null. `previous`
 * is the value an action returned, possibly after a trip through JSON. The
 * outcome's own `previous` is the state this replaced, so undo can be redone.
 */
export async function restoreTitleState(
  userId: string,
  ref: TitleId,
  previous: TitleRecord | TitleRecordInput | null,
): Promise<Outcome> {
  const ids = checkIds(userId, ref);
  if (!ids.ok) return ids;
  const { userId: u, ref: r } = ids.value;
  if (previous === null) return removeTitle(u, r);

  const parsed = parseTitleRecord(previous, r);
  if (!parsed.ok) return parsed;
  const p = parsed.value;
  return guardUser(() =>
    run(sql`
      with prev as (
        select * from title_status where ${pk(u, r)}
      ), up as (
        insert into title_status as t
          (user_id, media_type, tmdb_id, status, rating, review, review_visibility,
           skip_until, created_at, updated_at)
        values
          (${u}, ${r.mediaType}, ${r.tmdbId}, ${p.status}, ${p.rating}, ${p.review}, ${p.reviewVisibility},
           ${iso(p.skipUntil)}, ${p.createdAt.toISOString()}, ${p.updatedAt.toISOString()})
        on conflict (user_id, media_type, tmdb_id) do update set
          status = excluded.status,
          rating = excluded.rating,
          review = excluded.review,
          review_visibility = excluded.review_visibility,
          skip_until = excluded.skip_until,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
        returning t.*
      )
      select (select row_to_json(prev) from prev) as previous,
             (select row_to_json(up) from up) as current`),
  );
}
