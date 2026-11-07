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
 *
 * Both guards follow this value, so changing it needs no other edit: the
 * absolute guard counts titles in the file, not rows kept, and the shrink
 * guard compares against stored rows at or above the floor.
 */
export const IMDB_MIN_VOTES = 0;

/** Rows per insert batch. */
export const IMDB_BATCH_SIZE = 10_000;

/**
 * A file with fewer titles than this is treated as broken (a truncated
 * download or a format change) and is not swapped in. It counts every title
 * that parsed, whatever the vote floor keeps, and never a malformed line. The
 * 2026-11-06 file had 1,729,431 titles, and the file only grows.
 */
export const IMDB_MIN_EXPECTED_TITLES = 1_500_000;

/**
 * A load that writes fewer rows than this share of the comparable rows
 * already stored is treated as broken and is not swapped in. The target
 * checks it inside its transaction, against the table it is about to
 * replace, counting only stored rows at or above the vote floor. An empty
 * table (the first load) always passes.
 */
export const IMDB_MIN_FRACTION_OF_CURRENT = 0.9;

/** How long the download may go without delivering data (headers, then each chunk) before the load fails. */
export const IMDB_STALL_TIMEOUT_MS = 30_000;

export interface ReplaceGuard {
  /** Abort unless rows written >= this fraction of the comparable rows currently stored. */
  minFractionOfCurrent: number;
  /** The vote floor of this load. Only stored rows with at least this many votes are compared. */
  minVotes: number;
}

/** Thrown when a guard stops a load. The cron route reports it as a failed run. */
export class ImdbLoadGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImdbLoadGuardError";
  }
}

/** Throws when a load would shrink the table by more than the guard allows. */
export function checkAgainstCurrent(written: number, current: number, guard: ReplaceGuard): void {
  if (written < current * guard.minFractionOfCurrent) {
    throw new ImdbLoadGuardError(
      `IMDb load wrote ${written} rows, under ${guard.minFractionOfCurrent * 100}% of the ${current} stored with at least ${guard.minVotes} votes; not swapping in`,
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
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  url?: string;
  minVotes?: number;
  batchSize?: number;
  minExpectedTitles?: number;
  minFractionOfCurrent?: number;
  stallTimeoutMs?: number;
  now?: () => number;
}

export interface LoadImdbRatingsResult extends ParseStats {
  rowsWritten: number;
  durationMs: number;
}

export async function loadImdbRatings(options: LoadImdbRatingsOptions): Promise<LoadImdbRatingsResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const doFetch = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const minVotes = options.minVotes ?? IMDB_MIN_VOTES;
  const minExpectedTitles = options.minExpectedTitles ?? IMDB_MIN_EXPECTED_TITLES;
  const stallTimeoutMs = options.stallTimeoutMs ?? IMDB_STALL_TIMEOUT_MS;

  const res = await withStallTimeout(stallTimeoutMs, "response headers", (signal) => doFetch(options.url ?? IMDB_RATINGS_URL, { signal }));
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new Error(`IMDb dataset download failed: HTTP ${res.status}`);
  }

  const text = res.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream());
  const stats: ParseStats = { linesRead: 0, rowsKept: 0, belowMinVotes: 0, malformed: 0 };

  async function* checkedBatches(): AsyncGenerator<ImdbRatingRow[]> {
    const lines = splitLines(readStream(text, stallTimeoutMs));
    yield* batch(parseRatings(lines, minVotes, stats), options.batchSize ?? IMDB_BATCH_SIZE);
    // Thrown inside the target's transaction, so a short file never replaces a good table.
    const titles = stats.rowsKept + stats.belowMinVotes;
    if (titles < minExpectedTitles) {
      throw new ImdbLoadGuardError(
        `IMDb file had only ${titles} titles (expected at least ${minExpectedTitles}; ${stats.malformed} malformed lines); not swapping in`,
      );
    }
  }

  try {
    const rowsWritten = await options.target.replaceAll(checkedBatches(), {
      minFractionOfCurrent: options.minFractionOfCurrent ?? IMDB_MIN_FRACTION_OF_CURRENT,
      minVotes,
    });
    return { ...stats, rowsWritten, durationMs: now() - started };
  } catch (err) {
    // If the target failed before pulling a batch (a connection error, say),
    // nothing has read the stream yet, so close the download here. When
    // readStream holds the stream, this rejects harmlessly: it has already
    // cancelled.
    await text.cancel().catch(() => {});
    throw err;
  }
}

/** Runs `start` with an abort signal that fires if it has not settled within `ms`. */
async function withStallTimeout<T>(ms: number, what: string, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`IMDb download stalled: no ${what} within ${ms} ms`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([start(controller.signal), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A web ReadableStream as an async iterable, without relying on the stream's
 * own async iterator typing. If the consumer stops early (a parse error, the
 * row guard, a database error), the stream is cancelled, which closes the
 * download instead of leaving it open until garbage collection. With
 * `stallTimeoutMs`, a read that waits longer than that throws. The wait
 * counts only time spent waiting for data, not time the consumer spends
 * between reads.
 */
export async function* readStream<T>(stream: ReadableStream<T>, stallTimeoutMs?: number): AsyncGenerator<T> {
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } =
        stallTimeoutMs === undefined ? await reader.read() : await withStallTimeout(stallTimeoutMs, "data", () => reader.read());
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
    const comparable = [...this.rows.values()].filter((r) => r.votes >= guard.minVotes).length;
    checkAgainstCurrent(count, comparable, guard);
    this.rows = staged;
    return count;
  }
}
