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
    const result = await loadImdbRatings({ target, fetch, minVotes: 100, minExpectedTitles: 1, batchSize: 1 });
    expect(urls).toEqual(["https://datasets.imdbws.com/title.ratings.tsv.gz"]);
    expect(Object.fromEntries(target.rows)).toEqual({
      tt0133093: { rating: 8.7, votes: 2207468 },
      tt0000002: { rating: 6.0, votes: 100 },
    });
    expect(result).toMatchObject({ linesRead: 4, rowsKept: 2, belowMinVotes: 1, malformed: 1, rowsWritten: 2 });
  });

  test("by default every title is kept, however few its votes", async () => {
    const { fetch } = await fetchOf(tsv(["tt0000001\t5.7\t5", "tt0000002\t6.0\t0"]));
    const target = new MemoryLoadTarget();
    const result = await loadImdbRatings({ target, fetch, minExpectedTitles: 0 });
    expect(result).toMatchObject({ rowsKept: 2, belowMinVotes: 0 });
    expect(target.rows.size).toBe(2);
  });

  test("a load with too few rows throws and leaves the stored ratings unchanged", async () => {
    const target = new MemoryLoadTarget();
    target.rows.set("tt9", { rating: 7, votes: 500 });
    const { fetch } = await fetchOf(tsv(["tt1\t7.0\t150"]));
    await expect(loadImdbRatings({ target, fetch, minExpectedTitles: 2 })).rejects.toThrow("had only 1 titles");
    expect(Object.fromEntries(target.rows)).toEqual({ tt9: { rating: 7, votes: 500 } });
  });

  test("a load under 90% of the stored rows throws and leaves the stored ratings unchanged", async () => {
    const target = new MemoryLoadTarget();
    for (let i = 0; i < 10; i++) target.rows.set(`tt${i}`, { rating: 7, votes: 500 });
    const eight = Array.from({ length: 8 }, (_, i) => `tt${i}\t7.0\t500`);
    const { fetch } = await fetchOf(tsv(eight));
    await expect(loadImdbRatings({ target, fetch, minExpectedTitles: 0 })).rejects.toThrow("under 90% of the 10 stored");
    expect(target.rows.size).toBe(10);

    const nine = await fetchOf(tsv([...eight, "tt8\t7.0\t500"]));
    await loadImdbRatings({ target, fetch: nine.fetch, minExpectedTitles: 0 });
    expect(target.rows.size).toBe(9);
  });

  test("an empty table always passes the shrink guard (the first load)", async () => {
    const target = new MemoryLoadTarget();
    const { fetch } = await fetchOf(tsv(["tt1\t7.0\t500"]));
    expect((await loadImdbRatings({ target, fetch, minExpectedTitles: 0 })).rowsWritten).toBe(1);
  });

  test("an unexpected header throws before anything is swapped in", async () => {
    const target = new MemoryLoadTarget();
    target.rows.set("tt9", { rating: 7, votes: 500 });
    const { fetch } = await fetchOf("a\tb\tc\ntt1\t7.0\t150\n");
    await expect(loadImdbRatings({ target, fetch, minExpectedTitles: 0 })).rejects.toThrow("header");
    expect(target.rows.size).toBe(1);
  });

  test("an HTTP failure throws", async () => {
    const { fetch } = await fetchOf("", 503);
    await expect(loadImdbRatings({ target: new MemoryLoadTarget(), fetch })).rejects.toThrow("HTTP 503");
  });

  test("a failed load cancels the download body", async () => {
    // A body that delivers a bad header, then stays open like a slow download.
    const bytes = await gzip("a\tb\tc\ntt1\t7.0\t150\n");
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 8)); // all but the gzip trailer
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = async () => new Response(body);
    await expect(loadImdbRatings({ target: new MemoryLoadTarget(), fetch, minExpectedTitles: 0 })).rejects.toThrow("header");
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
  });

  test("the absolute guard counts titles in the file, so a vote floor does not trip it", async () => {
    const { fetch } = await fetchOf(tsv(["tt1\t7.0\t5", "tt2\t7.0\t500", "tt3\t7.0\t8"]));
    const target = new MemoryLoadTarget();
    const result = await loadImdbRatings({ target, fetch, minVotes: 100, minExpectedTitles: 3 });
    expect(result).toMatchObject({ linesRead: 3, rowsKept: 1 });
  });

  test("raising the vote floor is not mistaken for a shrink", async () => {
    const target = new MemoryLoadTarget();
    for (let i = 0; i < 10; i++) target.rows.set(`tt${i}`, { rating: 7, votes: i < 2 ? 500 : 5 });
    const { fetch } = await fetchOf(tsv(["tt0\t7.0\t500", "tt1\t7.0\t500", ...Array.from({ length: 8 }, (_, i) => `tt${i + 2}\t7.0\t5`)]));
    await loadImdbRatings({ target, fetch, minVotes: 100, minExpectedTitles: 0 });
    expect([...target.rows.keys()]).toEqual(["tt0", "tt1"]);
  });

  test("a target that fails before reading a batch still closes the download", async () => {
    const bytes = await gzip(tsv(["tt1\t7.0\t150"]));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const failing = {
      replaceAll: async () => {
        throw new Error("connect failed");
      },
    };
    await expect(loadImdbRatings({ target: failing, fetch: async () => new Response(body) })).rejects.toThrow("connect failed");
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
  });

  test("a download that stalls mid-body fails instead of hanging", async () => {
    const bytes = await gzip(tsv(["tt1\t7.0\t150"]));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10)); // then nothing, ever
      },
    });
    const target = new MemoryLoadTarget();
    target.rows.set("tt9", { rating: 7, votes: 500 });
    await expect(
      loadImdbRatings({ target, fetch: async () => new Response(body), stallTimeoutMs: 20, minExpectedTitles: 0 }),
    ).rejects.toThrow("stalled");
    expect(target.rows.size).toBe(1);
  });

  test("a server that never sends headers fails, and the request is aborted", async () => {
    let aborted = false;
    const fetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal!.reason);
        });
      });
    await expect(loadImdbRatings({ target: new MemoryLoadTarget(), fetch, stallTimeoutMs: 20 })).rejects.toThrow("no response headers");
    expect(aborted).toBe(true);
  });

  test("a corrupt gzip body throws", async () => {
    const fetch = async () => new Response(new Uint8Array([1, 2, 3, 4, 5]));
    await expect(loadImdbRatings({ target: new MemoryLoadTarget(), fetch, minExpectedTitles: 0 })).rejects.toThrow();
  });
});

describe("readStream", () => {
  test("cancels the source when the consumer stops early, so the download closes", async () => {
    let cancelled = false;
    const source = new ReadableStream<number>({
      pull(controller) {
        controller.enqueue(1);
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const value of readStream(source)) {
      expect(value).toBe(1);
      break;
    }
    expect(cancelled).toBe(true);
  });

  test("does not cancel a stream that finished", async () => {
    let cancelled = false;
    const source = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: number[] = [];
    for await (const value of readStream(source)) seen.push(value);
    expect(seen).toEqual([1]);
    expect(cancelled).toBe(false);
  });
});
