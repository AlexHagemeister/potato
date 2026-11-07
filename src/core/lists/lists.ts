// What the Lists tab shows: the user's Watchlist, Seen, and Passed lists, one
// row per title, with what a row displays. It joins the library's list query
// with TMDB metadata, the way settings/profile.ts joins settings with TMDB, so
// the library itself never imports the TMDB module (CLAUDE.md rule 4).
//
// The moves themselves (Watchlist to Seen, Passed to Watchlist, rating and
// review edits, undo) are the library's moveTitle, updateRatingReview, and
// restoreTitleState. Callers use those directly.

import { getList } from "../library/queries";
import type { DetailsLookupContext, TitleDetailsLookup, TitleRecord } from "../library/types";
import { ok, type Result } from "../result";
import { formatTitleKey } from "../title-id";
import { getTmdb, posterUrl, type DetailsCore, type TmdbClient } from "../tmdb";
import { LIST_STATUSES, type DeckFilters, type ListStatus, type TitleId } from "../types";

/** Rows per page. Enough to fill several screens, small enough that a cold metadata cache stays quick. */
export const LISTS_PAGE_SIZE = 50;

/** One row of a list, ready to display. */
export interface ListRow extends TitleId {
  status: ListStatus;
  /** Set exactly when status is "seen". */
  rating: number | null;
  /** Only ever set when status is "seen". */
  review: string | null;
  updatedAt: Date;
  /**
   * TMDB metadata. Null when it is unknown: TMDB has no such title, or TMDB is
   * down with nothing cached. The row still shows, since the list is the
   * user's record.
   */
  title: string | null;
  year: number | null;
  /** A thumbnail-size poster URL, or null. */
  posterUrl: string | null;
}

export interface ListRowsPage {
  status: ListStatus;
  rows: ListRow[];
  /** Pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

/**
 * Display metadata for many titles, keyed by formatTitleKey. A missing title
 * is unknown. With a country in the context, each title also carries
 * providerIds for that country (see DetailsLookupContext).
 */
export type TitleInfoLookup = (
  refs: readonly TitleId[],
  context?: DetailsLookupContext,
) => Promise<ReadonlyMap<string, DetailsCore>>;

/**
 * The lists' lookup over a TMDB client. Display metadata comes from the cached
 * details, with no streaming refresh. Only when a filter asks for a country
 * (the "on my services" filter) does it add where each title streams there.
 */
export function createTitleInfoLookup(tmdb: Pick<TmdbClient, "lookupTitles" | "attachProviderIds">): TitleInfoLookup {
  return async (refs, context) => {
    const found = await tmdb.lookupTitles(refs);
    if (!context?.country) return found;
    const withProviders = await tmdb.attachProviderIds([...found.values()], context.country);
    return new Map(withProviders.map((info) => [formatTitleKey(info), info]));
  };
}

const tmdbLookup: TitleInfoLookup = (refs, context) => createTitleInfoLookup(getTmdb())(refs, context);

/** Thumbnail size: rows show posters about 56pt wide, so w185 stays sharp at 3x. */
const ROW_POSTER_SIZE = "w185";

export function toListRow(record: TitleRecord, info: DetailsCore | undefined): ListRow {
  return {
    mediaType: record.mediaType,
    tmdbId: record.tmdbId,
    // getList only returns rows of the list it was asked for, all list statuses.
    status: record.status as ListStatus,
    rating: record.rating,
    review: record.review,
    updatedAt: record.updatedAt,
    title: info?.title ?? null,
    year: info?.year ?? null,
    posterUrl: info ? posterUrl(info.posterPath, ROW_POSTER_SIZE) : null,
  };
}

export interface ListRowsOptions {
  /**
   * The deck's filters (VISION: "The filters that shape the deck also work on
   * each list"). A cursor holds sort values only, so pass the same filters
   * that produced it.
   */
  filters?: DeckFilters;
  /** The `nextCursor` from the previous page. */
  cursor?: string | null;
  /** Where metadata comes from. Defaults to the TMDB module (cached). Tests pass a stand-in. */
  lookup?: TitleInfoLookup;
}

/**
 * One page of a list, newest change first. The library pages and sorts. This
 * adds each row's title, year, and poster.
 */
export async function getListRows(
  userId: string,
  status: ListStatus,
  options: ListRowsOptions = {},
): Promise<Result<ListRowsPage>> {
  const lookup = options.lookup ?? tmdbLookup;
  // getList hands entries the deck's Candidate view of the metadata, which has
  // no poster. Keep the full objects here, keyed the same way.
  const infos = new Map<string, DetailsCore>();
  const lookupDetails: TitleDetailsLookup = async (refs, context) => {
    const found = await lookup(refs, context);
    for (const [key, info] of found) infos.set(key, info);
    return found;
  };
  const page = await getList(userId, status, {
    filters: options.filters,
    cursor: options.cursor,
    limit: LISTS_PAGE_SIZE,
    lookupDetails,
  });
  if (!page.ok) return page;
  return ok({
    status: page.value.status,
    rows: page.value.entries.map((entry) => toListRow(entry, infos.get(formatTitleKey(entry)))),
    nextCursor: page.value.nextCursor,
  });
}

/** The first page of every list, read in parallel, so switching lists needs no request. The filters apply to all three. */
export async function getAllLists(
  userId: string,
  options: Pick<ListRowsOptions, "lookup" | "filters"> = {},
): Promise<Result<Record<ListStatus, ListRowsPage>>> {
  const pages = await Promise.all(LIST_STATUSES.map((status) => getListRows(userId, status, options)));
  const out = {} as Record<ListStatus, ListRowsPage>;
  for (const page of pages) {
    if (!page.ok) return page;
    out[page.value.status] = page.value;
  }
  return ok(out);
}
