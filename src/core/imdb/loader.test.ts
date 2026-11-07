import { describe, expect, test } from "bun:test";
import { loadImdbRatings, MemoryLoadTarget, readStream } from "./loader";
import { RATINGS_HEADER } from "./tsv";

/** Gzips text with the platform's CompressionStream, split into small chunks so parsing crosses chunk boundaries. */
async function gzip(text: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const source = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  for await (const part of readStream(source)) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function chunkedBody(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

const tsv = (rows: string[]) => [RATINGS_HEADER, ...rows].join("\n");

async function fetchOf(text: string, status = 200) {
  const bytes = await gzip(text);
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    return new Response(chunkedBody(bytes, 7), { status });
  };
  return { fetch: fetchFn, urls };
}

describe("loadImdbRatings", () => {
  test("streams, decompresses, filters by votes, and swaps in the result", async () => {
    const { fetch, urls } = await fetchOf(tsv(["tt0133093\t8.7\t2207468", "tt0000001\t5.7\t99", "tt0000002\t6.0\t100", "bad line"]));
    const target = new MemoryLoadTarget();
    const result = await loadImdbRatings({ target, fetch, minExpectedRows: 1, batchSize: 1 });
    expect(urls).toEqual(["https://datasets.imdbws.com/title.ratings.tsv.gz"]);
    expect(Object.fromEntries(target.rows)).toEqual({
      tt0133093: { rating: 8.7, votes: 2207468 },
      tt0000002: { rating: 6.0, votes: 100 },
    });
    expect(result).toMatchObject({ linesRead: 4, rowsKept: 2, belowMinVotes: 1, malformed: 1, rowsWritten: 2 });
  });

  test("a load with too few rows throws and leaves the stored ratings unchanged", async () => {
    const target = new MemoryLoadTarget();
    target.rows.set("tt9", { rating: 7, votes: 500 });
    const { fetch } = await fetchOf(tsv(["tt1\t7.0\t150"]));
    await expect(loadImdbRatings({ target, fetch, minExpectedRows: 2 })).rejects.toThrow("kept only 1 rows");
    expect(Object.fromEntries(target.rows)).toEqual({ tt9: { rating: 7, votes: 500 } });
  });

  test("an unexpected header throws before anything is swapped in", async () => {
    const target = new MemoryLoadTarget();
    target.rows.set("tt9", { rating: 7, votes: 500 });
    const { fetch } = await fetchOf("a\tb\tc\ntt1\t7.0\t150\n");
    await expect(loadImdbRatings({ target, fetch, minExpectedRows: 0 })).rejects.toThrow("header");
    expect(target.rows.size).toBe(1);
  });

  test("an HTTP failure throws", async () => {
    const { fetch } = await fetchOf("", 503);
    await expect(loadImdbRatings({ target: new MemoryLoadTarget(), fetch })).rejects.toThrow("HTTP 503");
  });

  test("a corrupt gzip body throws", async () => {
    const fetch = async () => new Response(new Uint8Array([1, 2, 3, 4, 5]));
    await expect(loadImdbRatings({ target: new MemoryLoadTarget(), fetch, minExpectedRows: 0 })).rejects.toThrow();
  });
});
