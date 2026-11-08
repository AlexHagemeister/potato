// The writes behind the four card buttons and the Lists tab (CLAUDE.md rules
// 2 and 3, VISION invariants 2, 3, and 7). Each function takes the user id
// explicitly: the app layer resolves the session, so the UI, the API, and a
// future AI connection all call the same code.
//
// Each write is a single SQL statement (built by withPrevious). Its first CTE
// reads the row as it was and the next one writes, and both see the same
// snapshot, so the previous state comes back atomically with no transaction
// (the Neon HTTP driver has none). The read takes no row lock: a lock taken in
// the same statement as the write depends on which CTE the planner runs
// first. Two writes on the same user's same title at the same instant (a
// double tap on two devices) can hand the later one a stale `previous`. Undo
// is safe against that, and against any later change: restoreTitleState is a
// compare-and-set that refuses to touch a row that is no longer the action's
// `current`.
//
// Timestamps come from the caller's clock (`now`), at millisecond precision,
// so a state read back into JavaScript matches the stored value exactly. That
// is what lets undo compare updated_at.

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { FOREIGN_KEY_VIOLATION, pgErrorCode } from "../pg-error";
import { fail, ok, validateUserId, type Result } from "../result";
import type { TitleId, TitleStatus } from "../types";
import { recordFromJson } from "./rows";
import {
  cardWriteFrom,
  cardWriteRefused,
  columnsFor,
  planMove,
  planRatingReviewPatch,
  type CardIntent,
  type StatusColumns,
} from "./transitions";
import type { ActionOptions, ActionOutcome, MoveRequest, RatingReviewPatch, SortOptions, TitleRecord, UndoInput } from "./types";
import { parseTitleRecord, validateTitleRef } from "./validate";

type Outcome = Result<ActionOutcome>;

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function pk(userId: string, ref: TitleId): SQL {
  return sql`user_id = ${userId} and media_type = ${ref.mediaType} and tmdb_id = ${ref.tmdbId}`;
}

/**
 * Runs one write as a single statement that also returns the row as it was.
 * `write` is an insert, update, or delete on this title's row, ending in
 * `returning *`. Returns the row before (`before`) and what the write
 * returned (`written`, null when it touched no row).
 */
async function withPrevious(
  userId: string,
  ref: TitleId,
  write: SQL,
): Promise<{ before: TitleRecord | null; written: TitleRecord | null }> {
  const result = await getDb().execute(sql`
    with prev as (
      select * from title_status where ${pk(userId, ref)}
    ), up as (
      ${write}
    )
    select (select row_to_json(prev) from prev) as previous,
           (select row_to_json(up) from up) as current`);
  const row = (result.rows[0] ?? {}) as { previous?: unknown; current?: unknown };
  return { before: recordFromJson(row.previous), written: recordFromJson(row.current) };
}

/** Turns a foreign-key violation on user_id into a typed error. Anything else is rethrown. */
async function guardUser(write: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) return fail({ code: "unknown_user" });
    throw error;
  }
}

function checkIds(userId: unknown, ref: unknown): Result<{ userId: string; ref: TitleId }> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const r = validateTitleRef(ref);
  if (!r.ok) return r;
  return ok({ userId: u.value, ref: r.value });
}

/** The typed error for a guarded write that changed nothing: the row is gone, or somewhere else. */
function conflict(before: TitleRecord | null, expected: TitleRecord["status"][]): Outcome {
  if (!before) return fail({ code: "not_found" });
  return fail({ code: "wrong_state", status: before.status, expected });
}

/**
 * One upsert under the composite primary key. A title has one row per user,
 * so writing a status moves the title off whatever list it was on (VISION
 * invariant 3). created_at keeps the first time the user acted on the title.
 *
 * It changes an existing row only while the row's status is in `allowed`
 * (cardWriteFrom). Otherwise it writes nothing and returns no row. The
 * condition sits in ON CONFLICT DO UPDATE, which Postgres checks against the
 * row it has locked, so it holds even against a write landing at the same
 * instant.
 */
function upsertWrite(userId: string, ref: TitleId, c: StatusColumns, now: Date, allowed: readonly TitleStatus[]): SQL {
  const statuses = sql.join(
    allowed.map((s) => sql`${s}`),
    sql`, `,
  );
  const guard = sql`where t.status in (${statuses})`;
  return sql`
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
    ${guard}
    returning t.*`;
}

async function cardAction(userId: unknown, ref: unknown, intent: CardIntent, options: SortOptions): Promise<Outcome> {
  const ids = checkIds(userId, ref);
  if (!ids.ok) return ids;
  const now = options.now ?? new Date();
  const columns = columnsFor(intent, now);
  if (!columns.ok) return columns;
  // Strictly true: anything else a caller sends keeps the guard.
  const allowed = cardWriteFrom(columns.value.status, options.seenShown === true);
  const { userId: u, ref: r } = ids.value;
  return guardUser(async () => {
    const { before, written } = await withPrevious(u, r, upsertWrite(u, r, columns.value, now, allowed));
    // No row back means the guard refused the row it locked, which can only be a Seen row.
    if (!written) return fail(cardWriteRefused(allowed));
    return ok({ previous: before, current: written });
  });
}

/**
 * Pass: the title goes to the Passed list. On a Seen title it refuses with
 * wrong_state unless `options.seenShown` says the caller showed the title as
 * Seen (cardWriteFrom, issue 74). Watchlist and Skip work the same way.
 */
export function passTitle(userId: string, ref: TitleId, options: SortOptions = {}): Promise<Outcome> {
  return cardAction(userId, ref, { status: "passed" }, options);
}

/** Watchlist: the title goes to the Watchlist. A Seen title needs `seenShown`, as for passTitle. */
export function watchlistTitle(userId: string, ref: TitleId, options: SortOptions = {}): Promise<Outcome> {
  return cardAction(userId, ref, { status: "watchlist" }, options);
}

/**
 * Skip: no list. The title returns to the deck SKIP_DAYS from now (VISION
 * invariant 1). A Seen title needs `seenShown`, as for passTitle.
 */
export function skipTitle(userId: string, ref: TitleId, options: SortOptions = {}): Promise<Outcome> {
  return cardAction(userId, ref, { status: "skipped" }, options);
}

/**
 * Seen it: the title goes to the Seen list with this rating (required) and an
 * optional review (left out, null, or blank means none). It moves a title
 * that is on no list or on another list (cardWriteFrom). A title already
 * Seen is left exactly as it is and the result is wrong_state, because its
 * review may have been written elsewhere (another device, the AI connection)
 * and the caller has not shown it. To change a Seen title's rating or
 * review, use updateRatingReview.
 */
export function markSeen(
  userId: string,
  ref: TitleId,
  input: { rating: number; review?: string | null },
  options: ActionOptions = {},
): Promise<Outcome> {
  return cardAction(userId, ref, { status: "seen", rating: input?.rating, review: input?.review }, options);
}

/** Runs an UPDATE guarded on the row's status and turns "no row changed" into not_found or wrong_state. */
async function guardedUpdate(userId: string, ref: TitleId, expected: TitleRecord["status"], set: SQL): Promise<Outcome> {
  const { before, written } = await withPrevious(
    userId,
    ref,
    sql`update title_status set ${set} where ${pk(userId, ref)} and status = ${expected} returning *`,
  );
  return written ? ok({ previous: before, current: written }) : conflict(before, [expected]);
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
 * This is how undo takes back the first action on a title. Removing a title
 * with no row is not an error: `previous` is null.
 */
export async function removeTitle(userId: string, ref: TitleId): Promise<Outcome> {
  const ids = checkIds(userId, ref);
  if (!ids.ok) return ids;
  const { userId: u, ref: r } = ids.value;
  const { written: deleted } = await withPrevious(u, r, sql`delete from title_status where ${pk(u, r)} returning *`);
  return ok({ previous: deleted, current: null });
}

/** Parses one side of an undo input. Null stays null. */
function parseSide(input: unknown, ref: TitleId): Result<TitleRecord | null> {
  return input === null ? ok(null) : parseTitleRecord(input, ref);
}

/**
 * Undo (VISION invariant 2). Takes the outcome an action returned (possibly
 * after a trip through JSON) and puts the row back to its `previous`,
 * timestamps included, or deletes it when `previous` is null.
 *
 * It is a compare-and-set: it changes the row only while the row is still the
 * outcome's `current` (same status and updated_at, or still absent when
 * `current` is null). If the title changed since (another device, a later
 * edit, the AI connection), nothing changes and the result is wrong_state
 * (the row is somewhere else) or not_found (the row is gone). So a stale undo
 * never discards a newer change.
 *
 * The result is itself an outcome, so passing it back redoes the action.
 */
export async function restoreTitleState(userId: string, ref: TitleId, undo: UndoInput): Promise<Outcome> {
  const ids = checkIds(userId, ref);
  if (!ids.ok) return ids;
  const { userId: u, ref: r } = ids.value;
  if (typeof undo !== "object" || undo === null || !("previous" in undo) || !("current" in undo)) {
    return fail({ code: "invalid_snapshot", message: "undo needs the action's previous and current states" });
  }
  const parsedPrevious = parseSide(undo.previous, r);
  if (!parsedPrevious.ok) return parsedPrevious;
  const parsedCurrent = parseSide(undo.current, r);
  if (!parsedCurrent.ok) return parsedCurrent;
  const p = parsedPrevious.value;
  const c = parsedCurrent.value;

  // The action made no change (removing a title that had no row): nothing to undo.
  if (!p && !c) return ok({ previous: null, current: null });

  // Only the row the action left behind may be changed.
  const isCurrent = c ? sql`status = ${c.status} and updated_at = ${c.updatedAt.toISOString()}` : null;

  return guardUser(async () => {
    if (!p && c && isCurrent) {
      // The action created the row: delete it, if it is still that row.
      const { before, written } = await withPrevious(
        u,
        r,
        sql`delete from title_status where ${pk(u, r)} and ${isCurrent} returning *`,
      );
      return written ? ok({ previous: written, current: null }) : conflict(before, [c.status]);
    }

    if (p && !c) {
      // The action removed the row: put it back, if nothing has taken its place.
      const { before, written } = await withPrevious(
        u,
        r,
        sql`insert into title_status
              (user_id, media_type, tmdb_id, status, rating, review, review_visibility,
               skip_until, created_at, updated_at)
            values
              (${u}, ${r.mediaType}, ${r.tmdbId}, ${p.status}, ${p.rating}, ${p.review}, ${p.reviewVisibility},
               ${iso(p.skipUntil)}, ${p.createdAt.toISOString()}, ${p.updatedAt.toISOString()})
            on conflict (user_id, media_type, tmdb_id) do nothing
            returning *`,
      );
      return written ? ok({ previous: null, current: written }) : conflict(before, []);
    }

    // The action changed the row: set every column back, if it is still that row.
    const prior = p!;
    const { before, written } = await withPrevious(
      u,
      r,
      sql`update title_status set
            status = ${prior.status},
            rating = ${prior.rating},
            review = ${prior.review},
            review_visibility = ${prior.reviewVisibility},
            skip_until = ${iso(prior.skipUntil)},
            created_at = ${prior.createdAt.toISOString()},
            updated_at = ${prior.updatedAt.toISOString()}
          where ${pk(u, r)} and ${isCurrent}
          returning *`,
    );
    return written ? ok({ previous: before, current: written }) : conflict(before, [c!.status]);
  });
}
