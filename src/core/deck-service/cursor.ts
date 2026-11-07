// The deck's paging cursor. A deck page reads from several TMDB lists
// ("streams"): one discover list per pool and media type, and one
// recommendations list per "for you" seed. The cursor records where each
// stream stopped, so the next page reads on from there.
//
// The cursor names no titles. A "for you" stream is named by its seed's rank
// (for_you:0 is the top-rated seed), and the seeds are read again on every
// call. Two fingerprints bind the cursor to its context:
// - `context` covers the user, country, and services. A mismatch means
//   another user's cursor, or settings changed mid-session (the discover
//   lists differ), so the service rejects it.
// - `seeds` covers the user's seed titles. A mismatch means the user rated
//   something that changed the top seeds, so the service restarts the "for
//   you" streams and keeps the rest.
// The fingerprints are hashes, so a cursor shows neither the user's settings
// nor their titles.
//
// The cursor is opaque to callers and arrives from the client, so decoding
// checks everything: a tampered cursor gets a typed error, never extra TMDB
// work (the stream count is capped).

import { createHash } from "node:crypto";
import { DISCOVER_POOLS, type DiscoverPool } from "../tmdb/client";
import { TMDB_MAX_PAGE } from "../tmdb/constants";
import type { DeckFilters, DiscoveryMode, MediaType, TitleId } from "../types";
import { FOR_YOU_SEED_COUNT } from "./constants";

export type StreamSpec =
  | { pool: DiscoverPool; mediaType: MediaType }
  /** `rank` is the seed's place among the user's top-rated seeds, from 0. */
  | { pool: "for_you"; rank: number; seed: TitleId };

/** Where a stream stands: the next title is item `offset` of page `page`. Page 0 means exhausted. */
export interface StreamPosition {
  page: number;
  offset: number;
}

export interface CursorState {
  mode: DiscoveryMode;
  filters: string;
  context: string;
  seeds: string;
  /** Positions by stream ID. */
  positions: Map<string, StreamPosition>;
}

const CURSOR_VERSION = 2;
/** A TMDB page holds 20 results. Anything far past that is tampering. */
const MAX_OFFSET = 1000;
const MAX_STREAMS = DISCOVER_POOLS.length * 2 + FOR_YOU_SEED_COUNT;
const FINGERPRINT = /^[A-Za-z0-9_-]{1,64}$/;

export function streamId(spec: StreamSpec): string {
  return spec.pool === "for_you" ? `for_you:${spec.rank}` : `${spec.pool}:${spec.mediaType}`;
}

function isStreamId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const [pool, rest, extra] = id.split(":");
  if (extra !== undefined) return false;
  if (pool === "for_you") return /^\d$/.test(rest ?? "") && Number(rest) < FOR_YOU_SEED_COUNT;
  return (DISCOVER_POOLS as readonly string[]).includes(pool) && (rest === "movie" || rest === "tv");
}

/** A short, one-way hash of the parts. */
export function fingerprint(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 22);
}

/** A canonical string for a filter set, so a cursor can only continue the deck it came from. */
export function canonicalFilters(f: DeckFilters): string {
  return JSON.stringify({
    t: [...new Set(f.mediaTypes ?? [])].sort(),
    g: [...new Set(f.genreIds ?? [])].sort((a, b) => a - b),
    y: [f.era?.fromYear ?? null, f.era?.toYear ?? null],
    s: f.onMyServices === true,
  });
}

export function encodeCursor(state: CursorState): string {
  const body = {
    v: CURSOR_VERSION,
    m: state.mode,
    f: state.filters,
    c: state.context,
    k: state.seeds,
    s: [...state.positions].map(([id, position]) => [id, position.page, position.offset]),
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

const isWhole = (v: unknown, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** The cursor's state, or an error message. Checks shape only. The caller checks it against the request. */
export function decodeCursor(cursor: unknown): CursorState | string {
  if (typeof cursor !== "string" || cursor === "") return "cursor is malformed";
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return "cursor is malformed";
  }
  if (typeof body !== "object" || body === null) return "cursor is malformed";
  const { v, m, f, c, k, s } = body as Record<string, unknown>;
  if (v !== CURSOR_VERSION || typeof m !== "string" || typeof f !== "string" || !Array.isArray(s)) return "cursor is malformed";
  if (typeof c !== "string" || !FINGERPRINT.test(c) || typeof k !== "string" || !FINGERPRINT.test(k)) return "cursor is malformed";
  if (s.length > MAX_STREAMS) return "cursor names too many streams";
  const positions = new Map<string, StreamPosition>();
  for (const entry of s) {
    if (!Array.isArray(entry) || entry.length !== 3) return "cursor is malformed";
    const [id, page, offset] = entry as unknown[];
    if (!isStreamId(id) || !isWhole(page, TMDB_MAX_PAGE) || !isWhole(offset, MAX_OFFSET)) return "cursor is malformed";
    if (positions.has(id)) return "cursor repeats a stream";
    positions.set(id, { page, offset });
  }
  return { mode: m as DiscoveryMode, filters: f, context: c, seeds: k, positions };
}
