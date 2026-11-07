import { describe, expect, test } from "bun:test";
import { batch, parseRatings, parseRatingsLine, RATINGS_HEADER, splitLines, type ParseStats } from "./tsv";

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const freshStats = (): ParseStats => ({ linesRead: 0, rowsKept: 0, belowMinVotes: 0, malformed: 0 });

describe("splitLines", () => {
  test("joins a line split across chunk boundaries", async () => {
    expect(await collect(splitLines(from(["tt01\t5.", "7\t20", "26\ntt02\t6.1\t9\n"])))).toEqual(["tt01\t5.7\t2026", "tt02\t6.1\t9"]);
  });

  test("yields a last line with no trailing newline", async () => {
    expect(await collect(splitLines(from(["a\nb\n", "c"])))).toEqual(["a", "b", "c"]);
  });

  test("strips CR from CRLF line ends, even when the CR and LF land in different chunks", async () => {
    expect(await collect(splitLines(from(["a\r", "\nb\r\n"])))).toEqual(["a", "b"]);
  });

  test("many lines in one chunk, and empty chunks", async () => {
    expect(await collect(splitLines(from(["", "1\n2\n3\n", ""])))).toEqual(["1", "2", "3"]);
  });
});

describe("parseRatingsLine", () => {
  test("parses a valid line", () => {
    expect(parseRatingsLine("tt0133093\t8.7\t2207468")).toEqual({ tconst: "tt0133093", averageRating: 8.7, numVotes: 2207468 });
    expect(parseRatingsLine("tt0000001\t10\t5")).toEqual({ tconst: "tt0000001", averageRating: 10, numVotes: 5 });
  });

  test("rejects malformed lines", () => {
    for (const line of ["", "tt1\t5.0", "nm1\t5.0\t3", "tt1\tabc\t3", "tt1\t5.0\t3.5", "tt1\t11\t3", "tt1\t0.5\t3", "tt1\t5\t3\textra"]) {
      expect(parseRatingsLine(line)).toBeNull();
    }
  });
});

describe("parseRatings", () => {
  test("skips the header, filters by votes, and counts what it saw", async () => {
    const stats = freshStats();
    const rows = await collect(
      parseRatings(from([RATINGS_HEADER, "tt1\t7.0\t150", "tt2\t9.9\t99", "garbage", "tt3\t6.5\t100", ""]), 100, stats),
    );
    expect(rows.map((r) => r.tconst)).toEqual(["tt1", "tt3"]);
    expect(stats).toEqual({ linesRead: 4, rowsKept: 2, belowMinVotes: 1, malformed: 1 });
  });

  test("throws on an unexpected header", async () => {
    await expect(collect(parseRatings(from(["id\trating\tvotes", "tt1\t7\t200"]), 100, freshStats()))).rejects.toThrow("header");
  });

  test("throws on an empty file", async () => {
    await expect(collect(parseRatings(from([]), 100, freshStats()))).rejects.toThrow("empty");
  });
});

test("batch groups items and flushes the remainder", async () => {
  expect(await collect(batch(from([1, 2, 3, 4, 5]), 2))).toEqual([[1, 2], [3, 4], [5]]);
  expect(await collect(batch(from([]), 2))).toEqual([]);
});
