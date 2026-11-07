// IMDb ratings lookups (CLAUDE.md architecture rule 4: the only code for
// IMDb ratings). Ratings come from IMDb's non-commercial dataset, loaded daily
// into Postgres by ./loader.ts.

import { formatTitleKey } from "../title-id";
import type { Candidate, ImdbRating } from "../types";

/** Reads ratings by IMDb ID (tconst). The Postgres implementation reads the imdb_ratings table. */
export interface RatingsStore {
  /** Ratings for the given IDs. IDs with no row are absent from the map. */
  getMany(tconsts: readonly string[]): Promise<Map<string, ImdbRating>>;
}

const TCONST = /^tt\d+$/;

/** Batch lookup. Ignores duplicates and anything that is not an IMDb title ID. */
export async function getRatings(store: RatingsStore, imdbIds: readonly string[]): Promise<Map<string, ImdbRating>> {
  const unique = [...new Set(imdbIds.filter((id) => TCONST.test(id)))];
  if (unique.length === 0) return new Map();
  return store.getMany(unique);
}

/**
 * Returns copies of the candidates with `imdb` set from the ratings store.
 * `imdbIds` maps formatTitleKey(candidate) to its IMDb ID, as the TMDB
 * client's resolveImdbIds returns it. A candidate with no IMDb ID or no
 * dataset row keeps `imdb` absent, which the deck engine reads as "use TMDB".
 */
export async function attachImdbRatings<T extends Candidate>(
  store: RatingsStore,
  candidates: readonly T[],
  imdbIds: ReadonlyMap<string, string | null>,
): Promise<T[]> {
  const idFor = (c: T) => imdbIds.get(formatTitleKey(c)) ?? null;
  const ratings = await getRatings(
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
export class MemoryRatingsStore implements RatingsStore {
  constructor(readonly rows = new Map<string, ImdbRating>()) {}

  async getMany(tconsts: readonly string[]): Promise<Map<string, ImdbRating>> {
    const out = new Map<string, ImdbRating>();
    for (const id of tconsts) {
      const row = this.rows.get(id);
      if (row) out.set(id, { ...row });
    }
    return out;
  }
}
