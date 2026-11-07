// The daily IMDb ratings load. Streams IMDb's title.ratings.tsv.gz,
// decompresses and parses it as it arrives (the file never sits in memory
// whole), keeps titles at or above the vote floor (zero, so all of them), and
// hands batches to a load target that swaps them in atomically.
//
// Dataset terms: IMDb's datasets are for personal and non-commercial use only
// (https://developer.imdb.com/non-commercial-datasets/). See VISION.md,
// Constraints.

import { batch, parseRatings, splitLines, type ImdbRatingRow, type ParseStats } from "./tsv";

export const IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";

/**
 * Titles with fewer votes than this are not loaded. Zero loads every title in
 * the file, because the card shows the IMDb rating (VISION invariant 5) and
 * any search result opens a card, however obscure the title. The deck's own
 * vote thresholds still decide what the deck deals.
 */
export const IMDB_MIN_VOTES = 0;

/** Rows per insert batch. */
export const IMDB_BATCH_SIZE = 10_000;

/**
 * A load that keeps fewer rows than this is treated as broken (a truncated
 * download or a format change) and is not swapped in. The 2026-11-06 file
 * had 1,729,431 titles, and the file only grows. The relative guard
 * (IMDB_MIN_FRACTION_OF_CURRENT) catches smaller drops once the table is full.
 */
export const IMDB_MIN_EXPECTED_ROWS = 1_500_000;

/**
 * A load that writes fewer rows than this share of the rows already stored is
 * treated as broken and is not swapped in. A healthy daily file changes by a
 * fraction of a percent, so a 10% drop means a partial file, not real churn.
 * The target checks it inside its transaction, against the count it is about
 * to replace. An empty table (the first load) always passes.
 */
export const IMDB_MIN_FRACTION_OF_CURRENT = 0.9;

export interface ReplaceGuard {
  /** Abort unless rows written >= this fraction of the rows currently stored. */
  minFractionOfCurrent: number;
}

/** Throws when a load would shrink the table by more than the guard allows. */
export function checkAgainstCurrent(written: number, current: number, guard: ReplaceGuard): void {
  if (written < current * guard.minFractionOfCurrent) {
    throw new Error(
      `IMDb load wrote ${written} rows, under ${guard.minFractionOfCurrent * 100}% of the ${current} stored; not swapping in`,
    );
  }
}

/** Where a load writes. The Postgres target fills a staging table and swaps it in within one transaction. */
export interface RatingsLoadTarget {
  /**
   * Writes every batch, checks the count against `guard`, then replaces the
   * stored ratings with exactly these rows in one atomic step. If iterating
   * `batches` throws, or the guard fails, the stored ratings stay as they
   * were. Resolves to the number of rows written.
   */
  replaceAll(batches: AsyncIterable<ImdbRatingRow[]>, guard: ReplaceGuard): Promise<number>;
}

export interface LoadImdbRatingsOptions {
  target: RatingsLoadTarget;
  fetch?: (url: string) => Promise<Response>;
  url?: string;
  minVotes?: number;
  batchSize?: number;
  minExpectedRows?: number;
  minFractionOfCurrent?: number;
  now?: () => number;
}

export interface LoadImdbRatingsResult extends ParseStats {
  rowsWritten: number;
  durationMs: number;
}

export async function loadImdbRatings(options: LoadImdbRatingsOptions): Promise<LoadImdbRatingsResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const doFetch = options.fetch ?? ((url: string) => fetch(url));
  const minVotes = options.minVotes ?? IMDB_MIN_VOTES;
  const minExpectedRows = options.minExpectedRows ?? IMDB_MIN_EXPECTED_ROWS;

  const res = await doFetch(options.url ?? IMDB_RATINGS_URL);
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`IMDb dataset download failed: HTTP ${res.status}`);
  }

  const text = res.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream());
  const stats: ParseStats = { linesRead: 0, rowsKept: 0, belowMinVotes: 0, malformed: 0 };

  async function* checkedBatches(): AsyncGenerator<ImdbRatingRow[]> {
    yield* batch(parseRatings(splitLines(readStream(text)), minVotes, stats), options.batchSize ?? IMDB_BATCH_SIZE);
    // Thrown inside the target's transaction, so a short file never replaces a good table.
    if (stats.rowsKept < minExpectedRows) {
      throw new Error(`IMDb load kept only ${stats.rowsKept} rows (expected at least ${minExpectedRows}); not swapping in`);
    }
  }

  const rowsWritten = await options.target.replaceAll(checkedBatches(), {
    minFractionOfCurrent: options.minFractionOfCurrent ?? IMDB_MIN_FRACTION_OF_CURRENT,
  });
  return { ...stats, rowsWritten, durationMs: now() - started };
}

/**
 * A web ReadableStream as an async iterable, without relying on the stream's
 * own async iterator typing. If the consumer stops early (a parse error, the
 * row guard, a database error), the stream is cancelled, which closes the
 * download instead of leaving it open until garbage collection.
 */
export async function* readStream<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A load target that keeps rows in memory. For tests, and for dry runs that only count. */
export class MemoryLoadTarget implements RatingsLoadTarget {
  rows = new Map<string, { rating: number; votes: number }>();

  constructor(private readonly keepRows = true) {}

  async replaceAll(batches: AsyncIterable<ImdbRatingRow[]>, guard: ReplaceGuard): Promise<number> {
    const staged = new Map<string, { rating: number; votes: number }>();
    let count = 0;
    for await (const rows of batches) {
      for (const r of rows) {
        count++;
        if (this.keepRows) staged.set(r.tconst, { rating: r.averageRating, votes: r.numVotes });
      }
    }
    checkAgainstCurrent(count, this.rows.size, guard);
    this.rows = staged;
    return count;
  }
}
