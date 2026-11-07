// IMDb ratings lookups (CLAUDE.md architecture rule 4: the only code for
// IMDb ratings). Ratings come from IMDb's non-commercial dataset, loaded daily
// into Postgres by ./loader.ts.

import { formatTitleKey } from "../title-id";
import type { ImdbRating, TitleId } from "../types";

/** Reads ratings by IMDb ID (tconst). The Postgres implementation reads the imdb_ratings table. */
export interface RatingsStore {
  /** Ratings for the given IDs. IDs with no row are absent from the map. */
  getMany(tconsts: readonly string[]): Promise<Map<string, ImdbRating>>;
}

/**
 * Whether the ratings table holds any rows. Empty means the daily load has
 * not landed yet (a fresh database, or a load that never succeeded), so a
 * missing rating says nothing about IMDb. Cards must not read that as "no rating".
 */
export interface RatingsDatasetProbe {
  hasAnyRatings(): Promise<boolean>;
}

const TCONST = /^tt\d+$/;

/** Batch lookup. Ignores duplicates and anything that is not an IMDb title ID. */
export async function getRatings(store: RatingsStore, imdbIds: readonly string[]): Promise<Map<string, ImdbRating>> {
  const unique = [...new Set(imdbIds.filter((id) => TCONST.test(id)))];
  if (unique.length === 0) return new Map();
  return store.getMany(unique);
}

/**
 * Batch lookup for a caller that filters on the rating, where a missing
 * rating drops the title. A missing row only means "IMDb has no rating" once
 * the dataset is known to be loaded, so when the lookup finds nothing this
 * asks the store whether it holds any rows, and throws if it holds none (the
 * first daily load has not landed). A failed lookup throws as well. Either
 * way the caller shows a failure, never a list emptied on IMDb's behalf.
 */
export async function getRatingsForFilter(
  store: RatingsStore & RatingsDatasetProbe,
  imdbIds: readonly string[],
): Promise<Map<string, ImdbRating>> {
  const found = await getRatings(store, imdbIds);
  if (found.size === 0 && imdbIds.some((id) => TCONST.test(id)) && !(await store.hasAnyRatings())) {
    throw new Error("IMDb ratings are not loaded yet, so a minimum IMDb rating can't be applied");
  }
  return found;
}

/**
 * Returns copies of the titles with `imdb` set from the ratings store.
 * `imdbIds` maps formatTitleKey(title) to its IMDb ID, as the TMDB client's
 * resolveImdbIds returns it. A title with no IMDb ID or no dataset row keeps
 * `imdb` absent. `read` picks the lookup: getRatings by default, or
 * getRatingsForFilter where a filter judges the rating, so an unloaded table
 * throws instead of reading as "no title is rated".
 */
export async function attachImdbRatings<T extends TitleId & { imdb?: ImdbRating }, S extends RatingsStore>(
  store: S,
  candidates: readonly T[],
  imdbIds: ReadonlyMap<string, string | null>,
  read: (store: S, imdbIds: readonly string[]) => Promise<ReadonlyMap<string, ImdbRating>> = getRatings,
): Promise<T[]> {
  const idFor = (c: T) => imdbIds.get(formatTitleKey(c)) ?? null;
  const ratings = await read(
    store,
    candidates.map(idFor).filter((id): id is string => id !== null),
  );
  return candidates.map((c) => {
    const id = idFor(c);
    const rating = id === null ? undefined : ratings.get(id);
    const copy = { ...c };
    if (rating) copy.imdb = { rating: rating.rating, votes: rating.votes };
    else delete copy.imdb;
    return copy;
  });
}

/** A process-local store, for tests and scripts. */
export class MemoryRatingsStore implements RatingsStore, RatingsDatasetProbe {
  constructor(readonly rows = new Map<string, ImdbRating>()) {}

  async hasAnyRatings(): Promise<boolean> {
    return this.rows.size > 0;
  }

  async getMany(tconsts: readonly string[]): Promise<Map<string, ImdbRating>> {
    const out = new Map<string, ImdbRating>();
    for (const id of tconsts) {
      const row = this.rows.get(id);
      if (row) out.set(id, { ...row });
    }
    return out;
  }
}
