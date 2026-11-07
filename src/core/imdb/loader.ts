// The daily IMDb ratings load. Streams IMDb's title.ratings.tsv.gz,
// decompresses and parses it as it arrives (the file never sits in memory
// whole), keeps titles with enough votes, and hands batches to a load target
// that swaps them in atomically.
//
// Dataset terms: IMDb's datasets are for personal and non-commercial use only
// (https://developer.imdb.com/non-commercial-datasets/). See VISION.md,
// Constraints.

import { batch, parseRatings, splitLines, type ImdbRatingRow, type ParseStats } from "./tsv";

export const IMDB_RATINGS_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";

/**
 * Titles with fewer votes than this are not loaded. Below it a rating is
 * noise, and the deck's own vote thresholds start far higher (1,000 IMDb
 * votes for a deep cut). It also keeps the table to a fraction of the file.
 */
export const IMDB_MIN_VOTES = 100;

/** Rows per insert batch. */
export const IMDB_BATCH_SIZE = 10_000;

/**
 * A load that keeps fewer rows than this is treated as broken (a truncated
 * download or a format change) and is not swapped in. The full file keeps
 * several hundred thousand rows at the 100-vote threshold.
 */
export const IMDB_MIN_EXPECTED_ROWS = 100_000;

/** Where a load writes. The Postgres target fills a staging table and swaps it in within one transaction. */
export interface RatingsLoadTarget {
  /**
   * Writes every batch, then replaces the stored ratings with exactly these
   * rows in one atomic step. If iterating `batches` throws, the stored
   * ratings stay as they were. Resolves to the number of rows written.
   */
  replaceAll(batches: AsyncIterable<ImdbRatingRow[]>): Promise<number>;
}

export interface LoadImdbRatingsOptions {
  target: RatingsLoadTarget;
  fetch?: (url: string) => Promise<Response>;
  url?: string;
  minVotes?: number;
  batchSize?: number;
  minExpectedRows?: number;
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

  const rowsWritten = await options.target.replaceAll(checkedBatches());
  return { ...stats, rowsWritten, durationMs: now() - started };
}

/** A web ReadableStream as an async iterable, without relying on the stream's own async iterator typing. */
export async function* readStream<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** A load target that keeps rows in memory. For tests, and for dry runs that only count. */
export class MemoryLoadTarget implements RatingsLoadTarget {
  rows = new Map<string, { rating: number; votes: number }>();

  constructor(private readonly keepRows = true) {}

  async replaceAll(batches: AsyncIterable<ImdbRatingRow[]>): Promise<number> {
    const staged = new Map<string, { rating: number; votes: number }>();
    let count = 0;
    for await (const rows of batches) {
      for (const r of rows) {
        count++;
        if (this.keepRows) staged.set(r.tconst, { rating: r.averageRating, votes: r.numVotes });
      }
    }
    this.rows = staged;
    return count;
  }
}
