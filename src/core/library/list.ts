// Pure list logic: option checks, filtering, sorting, and cursor paging.
//
// A list is one user's rows in one status, which stays small (hundreds, maybe
// a few thousand). So the database layer loads the whole list and this module
// filters, sorts, and pages it in memory. Filters on genre, era, and services
// need TMDB metadata, which the database does not hold, and filtering after a
// database page would leave pages short. Loading the whole list avoids both.

import { matchesFilters } from "../deck/build-deck";
import { formatTitleKey } from "../title-id";
import { LIST_STATUSES, type Candidate, type DeckFilters, type ListStatus } from "../types";
import { fail, ok, type LibraryResult } from "./errors";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_SORT,
  LIST_SORTS,
  MAX_LIST_LIMIT,
  type ListEntry,
  type ListOptions,
  type ListSort,
  type TitleRecord,
} from "./types";

export interface ParsedListQuery {
  status: ListStatus;
  filters: DeckFilters;
  sort: ListSort;
  cursor: CursorKey | null;
  limit: number;
}

/** The sort values of the last entry on a page. The next page starts strictly after it. */
export interface CursorKey {
  sort: ListSort;
  values: (number | string)[];
}

const bad = (message: string) => fail<never>({ code: "invalid_list_query", message });

export function parseListQuery(status: unknown, options: ListOptions = {}): LibraryResult<ParsedListQuery> {
  if (!(LIST_STATUSES as readonly unknown[]).includes(status)) {
    return bad(`status must be one of ${LIST_STATUSES.join(", ")}`);
  }
  const listStatus = status as ListStatus;

  const sort = options.sort ?? DEFAULT_LIST_SORT;
  if (!(LIST_SORTS as readonly unknown[]).includes(sort)) return bad(`unknown sort ${JSON.stringify(sort)}`);
  if (sort.startsWith("rating_") && listStatus !== "seen") return bad("rating sorts apply to the seen list only");

  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    return bad(`limit must be a whole number from 1 to ${MAX_LIST_LIMIT}`);
  }

  let cursor: CursorKey | null = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    cursor = decodeCursor(options.cursor);
    if (!cursor) return bad("cursor is malformed");
    if (cursor.sort !== sort) return bad("cursor belongs to a different sort");
  }

  const filters = options.filters ?? {};
  if (typeof filters !== "object" || filters === null) return bad("filters must be an object");

  return ok({ status: listStatus, filters, sort, cursor, limit });
}

/** True when a filter needs TMDB metadata. Media type alone does not: the row has it. */
export function filtersNeedDetails(filters: DeckFilters): boolean {
  return Boolean(
    filters.genreIds?.length ||
      typeof filters.era?.fromYear === "number" ||
      typeof filters.era?.toYear === "number" ||
      filters.onMyServices,
  );
}

/**
 * Keeps the rows that pass the filters. With metadata-dependent filters, a row
 * whose details are unknown fails them, the same way the deck treats unknown
 * metadata (matchesFilters).
 */
export function applyListFilters(
  rows: readonly TitleRecord[],
  filters: DeckFilters,
  details: ReadonlyMap<string, Candidate> | null,
  userProviderIds: readonly number[],
): TitleRecord[] {
  if (!filtersNeedDetails(filters)) {
    const types = filters.mediaTypes;
    return types?.length ? rows.filter((r) => types.includes(r.mediaType)) : [...rows];
  }
  if (!details) throw new Error("applyListFilters: these filters need details");
  return rows.filter((r) => {
    const d = details.get(formatTitleKey(r));
    // Judge the row's own identity, never a lookup that answered for another title.
    return d !== undefined && matchesFilters({ ...d, mediaType: r.mediaType, tmdbId: r.tmdbId }, filters, userProviderIds);
  });
}

/** The values a row sorts by, ending in its identity so the order is total. */
export function sortKey(row: TitleRecord, sort: ListSort): (number | string)[] {
  const identity = [row.mediaType, row.tmdbId];
  switch (sort) {
    case "updated_desc":
    case "updated_asc":
      return [row.updatedAt.getTime(), ...identity];
    case "created_desc":
    case "created_asc":
      return [row.createdAt.getTime(), ...identity];
    case "rating_desc":
    case "rating_asc":
      // Ties on rating show the most recently changed first, in both directions.
      return [row.rating ?? 0, -row.updatedAt.getTime(), ...identity];
  }
}

/** Compares two sort keys. The first value follows the sort direction. The rest always ascend. */
export function compareKeys(a: readonly (number | string)[], b: readonly (number | string)[], sort: ListSort): number {
  const descending = sort.endsWith("_desc");
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    let c = 0;
    if (typeof x === "number" && typeof y === "number") c = x - y;
    else c = String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
    if (c !== 0) return i === 0 && descending ? -c : c;
  }
  return 0;
}

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify([key.sort, ...key.values]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: unknown): CursorKey | null {
  if (typeof cursor !== "string" || cursor === "") return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length < 2) return null;
    const [sort, ...values] = parsed as unknown[];
    if (!(LIST_SORTS as readonly unknown[]).includes(sort)) return null;
    // Must match sortKey's length for this sort.
    const expectedValues = (sort as string).startsWith("rating_") ? 4 : 3;
    if (values.length !== expectedValues) return null;
    if (!values.every((v) => (typeof v === "number" && Number.isFinite(v)) || typeof v === "string")) return null;
    return { sort: sort as ListSort, values: values as (number | string)[] };
  } catch {
    return null;
  }
}

/**
 * Sorts the rows and returns one page, starting strictly after the cursor.
 * The cursor holds sort values, not an offset, so a row added or removed
 * between pages neither repeats nor skips the rows around it.
 */
export function pageRows(
  rows: readonly TitleRecord[],
  sort: ListSort,
  cursor: CursorKey | null,
  limit: number,
): { rows: TitleRecord[]; nextCursor: string | null } {
  const keyed = rows.map((row) => ({ row, key: sortKey(row, sort) }));
  keyed.sort((a, b) => compareKeys(a.key, b.key, sort));
  const start = cursor ? keyed.findIndex((k) => compareKeys(k.key, cursor.values, sort) > 0) : 0;
  if (start === -1) return { rows: [], nextCursor: null };
  const page = keyed.slice(start, start + limit);
  const hasMore = start + limit < keyed.length;
  const last = page[page.length - 1];
  return {
    rows: page.map((k) => k.row),
    nextCursor: hasMore && last ? encodeCursor({ sort, values: last.key }) : null,
  };
}

/** Attaches looked-up details to each entry that has them. */
export function withDetails(rows: readonly TitleRecord[], details: ReadonlyMap<string, Candidate> | null): ListEntry[] {
  if (!details) return rows.map((r) => ({ ...r }));
  return rows.map((r) => {
    const d = details.get(formatTitleKey(r));
    return d ? { ...r, details: d } : { ...r };
  });
}
