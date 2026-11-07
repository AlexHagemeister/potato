// Reads over a user's library. Each takes the user id explicitly, like the
// actions, so the app, the API, and a future AI connection share them.

import { and, asc, count, desc, eq, inArray, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { MEDIA_TYPES, titleStatus } from "@/db/schema";
import { getUserSettings } from "../settings/user-settings";
import type { Candidate, ListStatus, MediaType, TitleId, TitleStatus, UserTitleState } from "../types";
import { fail, ok, validateUserId, type Result } from "../result";
import { applyListFilters, filtersNeedDetails, pageRows, parseListQuery, withDetails } from "./list";
import { recordFromDrizzle } from "./rows";
import type { DetailsLookupContext, ListOptions, ListPage, TitleRecord } from "./types";
import { validateTitleRef } from "./validate";

/** Every row the user has, in the shape the deck engine reads (only the fields it needs). */
export async function getUserTitleStates(userId: string): Promise<Result<UserTitleState[]>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const rows = await getDb()
    .select({
      mediaType: titleStatus.mediaType,
      tmdbId: titleStatus.tmdbId,
      status: titleStatus.status,
      skipUntil: titleStatus.skipUntil,
    })
    .from(titleStatus)
    .where(eq(titleStatus.userId, u.value));
  return ok(rows.map(toUserTitleState));
}

/**
 * The user's rows for these titles only, in the deck engine's shape. Titles
 * with no row are absent. One query: the deck checks the cards it has queued
 * when Discover becomes active again. The caller validates and caps `refs`.
 */
export async function getTitleStatesFor(userId: string, refs: readonly TitleId[]): Promise<Result<UserTitleState[]>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  // The ID alone is ambiguous (architecture rule 1), so the query matches the
  // pair: one IN list per media type, each on the full primary key.
  const byType = MEDIA_TYPES.flatMap((mediaType) => {
    const ids = [...new Set(refs.filter((r) => r.mediaType === mediaType).map((r) => r.tmdbId))];
    return ids.length > 0 ? [and(eq(titleStatus.mediaType, mediaType), inArray(titleStatus.tmdbId, ids))] : [];
  });
  if (byType.length === 0) return ok([]);
  const rows = await getDb()
    .select({
      mediaType: titleStatus.mediaType,
      tmdbId: titleStatus.tmdbId,
      status: titleStatus.status,
      skipUntil: titleStatus.skipUntil,
    })
    .from(titleStatus)
    .where(and(eq(titleStatus.userId, u.value), or(...byType)));
  return ok(rows.map(toUserTitleState));
}

function toUserTitleState(r: { mediaType: MediaType; tmdbId: number; status: TitleStatus; skipUntil: Date | null }): UserTitleState {
  if (r.status === "skipped") {
    // The schema guarantees skip_until on a skipped row. If it were ever
    // missing, an invalid date keeps the title hidden (the deck's choice).
    return { mediaType: r.mediaType, tmdbId: r.tmdbId, status: "skipped", skipUntil: r.skipUntil ?? "" };
  }
  return { mediaType: r.mediaType, tmdbId: r.tmdbId, status: r.status };
}

/** The user's row for one title, or null when the title is on no list and not skipped. For a card opened from search. */
export async function getTitleState(userId: string, ref: TitleId): Promise<Result<TitleRecord | null>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const r = validateTitleRef(ref);
  if (!r.ok) return r;
  const rows = await getDb()
    .select()
    .from(titleStatus)
    .where(
      and(
        eq(titleStatus.userId, u.value),
        eq(titleStatus.mediaType, r.value.mediaType),
        eq(titleStatus.tmdbId, r.value.tmdbId),
      ),
    )
    .limit(1);
  return ok(rows[0] ? recordFromDrizzle(rows[0]) : null);
}

/** How many titles the user has rated (Seen rows always carry a rating). Gates "for you". */
export async function getRatedCount(userId: string): Promise<Result<number>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const [row] = await getDb()
    .select({ n: count() })
    .from(titleStatus)
    .where(and(eq(titleStatus.userId, u.value), eq(titleStatus.status, "seen")));
  return ok(Number(row?.n ?? 0));
}

/**
 * The user's highest-rated Seen titles of these media types, at most `limit`.
 * Ties on rating go to the most recently changed, then by identity: the order
 * of the Seen list's rating_desc sort. Reads only the identities, so the deck
 * can call it on every page. Seeds "for you".
 */
export async function getTopRatedSeen(userId: string, mediaTypes: readonly MediaType[], limit: number): Promise<Result<TitleId[]>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  if (mediaTypes.length === 0 || !Number.isSafeInteger(limit) || limit <= 0) return ok([]);
  const rows = await getDb()
    .select({ mediaType: titleStatus.mediaType, tmdbId: titleStatus.tmdbId })
    .from(titleStatus)
    .where(and(eq(titleStatus.userId, u.value), eq(titleStatus.status, "seen"), inArray(titleStatus.mediaType, [...mediaTypes])))
    .orderBy(desc(titleStatus.rating), desc(titleStatus.updatedAt), asc(titleStatus.mediaType), asc(titleStatus.tmdbId))
    .limit(limit);
  return ok(rows.map(({ mediaType, tmdbId }) => ({ mediaType, tmdbId })));
}

/**
 * One page of a list (Watchlist, Passed, or Seen), with each row's timestamps,
 * rating, and review. Filters are the deck's own (matchesFilters). Genre, era,
 * and "on my services" need TMDB metadata, so they need `lookupDetails`, which
 * the app layer wires to the TMDB module. "On my services" passes the user's
 * country to the lookup, so it can say where each title streams there, and a
 * user with no services gets an empty page with no lookup. The lookup runs once per call, over
 * the whole list when a filter needs it, or over the page's titles otherwise.
 * With a metadata filter, each page looks up the whole list again. That relies
 * on the TMDB module's cache to keep repeat lookups cheap.
 */
export async function getList(
  userId: string,
  status: ListStatus,
  options: ListOptions | null = {},
): Promise<Result<ListPage>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const query = parseListQuery(status, options);
  if (!query.ok) return query;
  const { filters, sort, cursor, limit } = query.value;
  const lookup = options?.lookupDetails;
  const needsDetails = filtersNeedDetails(filters);
  if (needsDetails && !lookup) return fail({ code: "details_lookup_required" });

  const rows = (
    await getDb()
      .select()
      .from(titleStatus)
      .where(and(eq(titleStatus.userId, u.value), eq(titleStatus.status, query.value.status)))
  ).map(recordFromDrizzle);

  let details: ReadonlyMap<string, Candidate> | null = null;
  let providerIds: number[] = [];
  if (needsDetails && lookup) {
    // "On my services" needs the user's services, and the lookup needs their
    // country to know where each title streams, so settings come first.
    let context: DetailsLookupContext | undefined;
    if (filters.onMyServices) {
      const settings = await getUserSettings(u.value);
      if (!settings.ok) return settings;
      providerIds = settings.value.providerIds;
      // No services: nothing can match, so skip the lookup (the deck does the same).
      if (providerIds.length === 0) return ok({ status: query.value.status, entries: [], nextCursor: null });
      context = { country: settings.value.country };
    }
    // A minimum IMDb rating needs each title's rating from IMDb's dataset.
    if (typeof filters.minImdbRating === "number") context = { ...context, imdbRatings: true };
    details = await lookup(
      rows.map(({ mediaType, tmdbId }) => ({ mediaType, tmdbId })),
      context,
    );
  }

  const page = pageRows(applyListFilters(rows, filters, details, providerIds), sort, cursor, limit);
  if (!details && lookup && page.rows.length > 0) {
    details = await lookup(page.rows.map(({ mediaType, tmdbId }) => ({ mediaType, tmdbId })));
  }
  return ok({ status: query.value.status, entries: withDetails(page.rows, details), nextCursor: page.nextCursor });
}
