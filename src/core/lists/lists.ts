// What the Lists tab shows: the user's Watchlist, Seen, and Passed lists, one
// row per title, with what a row displays. It joins the library's list query
// with TMDB metadata, the way settings/profile.ts joins settings with TMDB, so
// the library itself never imports the TMDB module (CLAUDE.md rule 4).
//
// The moves themselves (Watchlist to Seen, Passed to Watchlist, rating and
// review edits, undo) are the library's moveTitle, updateRatingReview, and
// restoreTitleState. Callers use those directly.

import { getRatingsForFilter, type RatingsDatasetProbe, type RatingsStore } from "../imdb/ratings";
import { PostgresRatingsStore } from "../imdb/postgres";
import { getList } from "../library/queries";
import type { DetailsLookupContext, TitleDetailsLookup, TitleRecord } from "../library/types";
import { ok, type Result } from "../result";
import { formatTitleKey } from "../title-id";
import { getTmdb, posterUrl, ROW_POSTER_SIZE, type DetailsCore, type TmdbClient } from "../tmdb";
import { LIST_STATUSES, type DeckFilters, type ImdbRating, type ListStatus, type TitleId } from "../types";

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

let ratingsStore: PostgresRatingsStore | undefined;
/** The app's IMDb ratings store, created on first use (no database access at import time). */
const appRatings = () => (ratingsStore ??= new PostgresRatingsStore());

/** A title's display metadata, plus its IMDb rating when the lookup was asked for it. */
export type TitleInfo = DetailsCore & { imdb?: ImdbRating };

/**
 * Display metadata for many titles, keyed by formatTitleKey. A missing title
 * is unknown. With a country in the context, each title also carries
 * providerIds for that country, and with imdbRatings, its IMDb rating (see
 * DetailsLookupContext).
 */
export type TitleInfoLookup = (
  refs: readonly TitleId[],
  context?: DetailsLookupContext,
) => Promise<ReadonlyMap<string, TitleInfo>>;

/**
 * The lists' lookup over a TMDB client and the IMDb ratings store. Display
 * metadata comes from the cached details, with no streaming refresh. Only when
 * a filter asks for a country (the "on my services" filter) does it add where
 * each title streams there. Only when a filter asks for IMDb ratings (a
 * minimum IMDb rating) does it read them, through the IMDb module (CLAUDE.md
 * rule 4). It throws when the ratings can't be read, so the list shows a
 * failure instead of emptying under the filter.
 */
export function createTitleInfoLookup(
  tmdb: Pick<TmdbClient, "lookupTitles" | "attachProviderIds">,
  ratings: () => RatingsStore & RatingsDatasetProbe = appRatings,
): TitleInfoLookup {
  return async (refs, context) => {
    let infos: TitleInfo[] = [...(await tmdb.lookupTitles(refs)).values()];
    if (context?.country) infos = await tmdb.attachProviderIds(infos, context.country);
    if (context?.imdbRatings) {
      const ids = infos.map((i) => i.imdbId).filter((id): id is string => id !== null);
      const found = await getRatingsForFilter(ratings(), ids);
      infos = infos.map((i) => {
        const r = i.imdbId === null ? undefined : found.get(i.imdbId);
        return r ? { ...i, imdb: { rating: r.rating, votes: r.votes } } : i;
      });
    }
    return new Map(infos.map((info) => [formatTitleKey(info), info]));
  };
}

const tmdbLookup: TitleInfoLookup = (refs, context) => createTitleInfoLookup(getTmdb())(refs, context);

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
