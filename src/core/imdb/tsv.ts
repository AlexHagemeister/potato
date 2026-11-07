// Streaming parser for IMDb's title.ratings.tsv. The file has a header line,
// then one line per title: tconst, averageRating, numVotes, tab-separated.

export interface ImdbRatingRow {
  tconst: string;
  averageRating: number;
  numVotes: number;
}

export const RATINGS_HEADER = "tconst\taverageRating\tnumVotes";

/** Splits a stream of text chunks into lines. Handles lines split across chunks, CRLF, and a last line with no newline. */
export async function* splitLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of chunks) {
    rest += chunk;
    let start = 0;
    let nl: number;
    while ((nl = rest.indexOf("\n", start)) !== -1) {
      yield stripCr(rest.slice(start, nl));
      start = nl + 1;
    }
    rest = rest.slice(start);
  }
  if (rest !== "") yield stripCr(rest);
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** One data line as a row, or null when the line is malformed. */
export function parseRatingsLine(line: string): ImdbRatingRow | null {
  const parts = line.split("\t");
  if (parts.length !== 3) return null;
  const [tconst, ratingText, votesText] = parts;
  if (!/^tt\d+$/.test(tconst)) return null;
  if (!/^\d+(\.\d+)?$/.test(ratingText) || !/^\d+$/.test(votesText)) return null;
  const averageRating = Number(ratingText);
  const numVotes = Number(votesText);
  if (averageRating < 1 || averageRating > 10 || !Number.isSafeInteger(numVotes)) return null;
  return { tconst, averageRating, numVotes };
}

export interface ParseStats {
  linesRead: number;
  rowsKept: number;
  belowMinVotes: number;
  malformed: number;
}

/**
 * Parses lines into rows with at least `minVotes` votes. Throws if the first
 * line is not the expected header, so a changed file format fails loudly
 * instead of loading garbage. `stats` is updated as rows stream through.
 */
export async function* parseRatings(lines: AsyncIterable<string>, minVotes: number, stats: ParseStats): AsyncGenerator<ImdbRatingRow> {
  let first = true;
  for await (const line of lines) {
    if (first) {
      first = false;
      if (line !== RATINGS_HEADER) throw new Error(`Unexpected IMDb ratings header: ${JSON.stringify(line.slice(0, 80))}`);
      continue;
    }
    if (line === "") continue;
    stats.linesRead++;
    const row = parseRatingsLine(line);
    if (!row) {
      stats.malformed++;
      continue;
    }
    if (row.numVotes < minVotes) {
      stats.belowMinVotes++;
      continue;
    }
    stats.rowsKept++;
    yield row;
  }
  if (first) throw new Error("IMDb ratings file is empty");
}

/** Groups items into arrays of at most `size`. */
export async function* batch<T>(items: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let current: T[] = [];
  for await (const item of items) {
    current.push(item);
    if (current.length >= size) {
      yield current;
      current = [];
    }
  }
  if (current.length) yield current;
}
