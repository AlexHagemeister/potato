// Postgres implementations of the IMDb stores, on the imdb_ratings table.

import { inArray } from "drizzle-orm";
import { getDb, withTransaction, type Db } from "@/db/client";
import { imdbRatings } from "@/db/schema";
import type { ImdbRating } from "../types";
import { checkAgainstCurrent, type RatingsLoadTarget, type ReplaceGuard } from "./loader";
import type { RatingsDatasetProbe, RatingsStore } from "./ratings";
import type { ImdbRatingRow } from "./tsv";

/** IDs per lookup query, to keep the parameter list modest. */
const LOOKUP_CHUNK = 1000;

/** Reads ratings over the HTTP driver. */
export class PostgresRatingsStore implements RatingsStore, RatingsDatasetProbe {
  constructor(private readonly db: () => Db = getDb) {}

  /** One indexed row read, not a count. */
  async hasAnyRatings(): Promise<boolean> {
    const rows = await this.db().select({ tconst: imdbRatings.tconst }).from(imdbRatings).limit(1);
    return rows.length > 0;
  }

  async getMany(tconsts: readonly string[]): Promise<Map<string, ImdbRating>> {
    const out = new Map<string, ImdbRating>();
    for (let i = 0; i < tconsts.length; i += LOOKUP_CHUNK) {
      const rows = await this.db()
        .select({ tconst: imdbRatings.tconst, rating: imdbRatings.averageRating, votes: imdbRatings.numVotes })
        .from(imdbRatings)
        .where(inArray(imdbRatings.tconst, tconsts.slice(i, i + LOOKUP_CHUNK)));
      for (const r of rows) out.set(r.tconst, { rating: Number(r.rating), votes: r.votes });
    }
    return out;
  }
}

/** Key for the advisory lock that serializes loads (Vercel Cron can deliver a run twice). */
const LOAD_LOCK_KEY = "potato:imdb_ratings_load";

/**
 * Loads into imdb_ratings atomically. Everything runs in one transaction on a
 * WebSocket connection:
 *   1. an advisory lock, so two overlapping runs take turns;
 *   2. a temp staging table that is dropped at commit (no migration needed);
 *   3. the batches, inserted with unnest arrays;
 *   4. check the row count against the stored count (the shrink guard);
 *   5. delete rows that left the dataset, upsert the rest (unchanged rows are
 *      not rewritten);
 *   6. commit.
 * Readers see the old table until the commit. A throw anywhere (including
 * the loader's row-count guard while batches are still streaming) rolls back.
 */
export function createPostgresRatingsLoadTarget(): RatingsLoadTarget {
  return {
    replaceAll: (batches: AsyncIterable<ImdbRatingRow[]>, guard: ReplaceGuard) =>
      withTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOAD_LOCK_KEY]);
        await client.query(
          `CREATE TEMP TABLE imdb_ratings_staging (
             tconst text PRIMARY KEY,
             average_rating numeric(3, 1) NOT NULL,
             num_votes integer NOT NULL
           ) ON COMMIT DROP`,
        );

        let written = 0;
        for await (const rows of batches) {
          const result = await client.query(
            `INSERT INTO imdb_ratings_staging (tconst, average_rating, num_votes)
             SELECT * FROM unnest($1::text[], $2::numeric[], $3::integer[])
             ON CONFLICT (tconst) DO NOTHING`,
            [rows.map((r) => r.tconst), rows.map((r) => r.averageRating), rows.map((r) => r.numVotes)],
          );
          written += result.rowCount ?? 0;
        }

        // Under the advisory lock, so no other load changes the count between
        // this check and the swap. Only rows at or above this load's vote
        // floor compare, so raising the floor is not mistaken for a shrink.
        const current = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM imdb_ratings WHERE num_votes >= $1",
          [guard.minVotes],
        );
        checkAgainstCurrent(written, current.rows[0].n, guard);

        await client.query(
          `DELETE FROM imdb_ratings r
           WHERE NOT EXISTS (SELECT 1 FROM imdb_ratings_staging s WHERE s.tconst = r.tconst)`,
        );
        await client.query(
          `INSERT INTO imdb_ratings (tconst, average_rating, num_votes)
           SELECT tconst, average_rating, num_votes FROM imdb_ratings_staging
           ON CONFLICT (tconst) DO UPDATE
             SET average_rating = EXCLUDED.average_rating, num_votes = EXCLUDED.num_votes
             WHERE (imdb_ratings.average_rating, imdb_ratings.num_votes)
               IS DISTINCT FROM (EXCLUDED.average_rating, EXCLUDED.num_votes)`,
        );
        return written;
      }),
  };
}
