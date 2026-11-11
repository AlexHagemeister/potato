// The deck's paging cursor. A deck page reads from several TMDB lists
// ("streams"): one discover list per pool and media type, and one
// recommendations list per "for you" seed. The cursor records where each
// stream stopped, so the next page reads on from there.
//
// It also carries the deck's shuffle seed. A new deck (a call without a
// cursor) takes the caller's seed or else a new one from the service, and the seed sets the order every
// stream reads its pages in and the order the engine deals each page. Carrying
// it keeps one deck consistent from page to page. A stream's position counts
// steps through its page order, not TMDB page numbers (see Stream in
// service.ts). In a deck with no seed the two are the same.
//
// The cursor names no titles. A "for you" stream is named by a hash of the
// user and its seed title (for_you:<hash>), and the seeds are read again on
// every call. So a seed title keeps its stream's place when the seed titles
// reorder, a new seed title starts at its stream's first step, and a dropped
// one's place is ignored.
// A `context` fingerprint binds the cursor to the user and, when "on my
// services" is on, to their country and services (the discover lists depend
// on them only then). A mismatch means another user's cursor, or settings
// that changed the lists mid-session, so the service rejects it.
// Both are hashes, so a cursor shows neither the user's settings nor their
// titles.
//
// The cursor is opaque to callers and arrives from the client, so decoding
// checks everything: a tampered cursor gets a typed error, never extra TMDB
// work (the stream count is capped).

import { createHash } from "node:crypto";
import { isShuffleSeed } from "../deck/shuffle";
import { DISCOVER_POOLS, type DiscoverPool } from "../tmdb/client";
import { TMDB_MAX_PAGE } from "../tmdb/constants";
import type { DeckFilters, DiscoveryMode, MediaType, TitleId } from "../types";
import { FOR_YOU_SEED_COUNT } from "./constants";

export type StreamSpec =
  | { pool: DiscoverPool; mediaType: MediaType }
  /** `seedHash` names the stream in the cursor without naming the title (see seedStreamHash). */
  | { pool: "for_you"; seedHash: string; seed: TitleId };

/**
 * Where a stream stands: the next title is item `offset` of the page at step
 * `page` of the stream's page order. Step n is TMDB page n in a deck with no
 * shuffle seed. Page 0 means exhausted.
 */
export interface StreamPosition {
  page: number;
  offset: number;
}

export interface CursorState {
  mode: DiscoveryMode;
  filters: string;
  context: string;
  /** The deck's shuffle seed, or null for a deck dealt in ranked order. */
  shuffleSeed: string | null;
  /** Positions by stream ID. */
  positions: Map<string, StreamPosition>;
}

const CURSOR_VERSION = 3;
/** A TMDB page holds 20 results. Anything far past that is tampering. */
const MAX_OFFSET = 1000;
const MAX_STREAMS = DISCOVER_POOLS.length * 2 + FOR_YOU_SEED_COUNT;
const FINGERPRINT = /^[A-Za-z0-9_-]{1,64}$/;
const SEED_HASH_LENGTH = 12;
const SEED_HASH = new RegExp(`^[A-Za-z0-9_-]{${SEED_HASH_LENGTH}}$`);

export function streamId(spec: StreamSpec): string {
  return spec.pool === "for_you" ? `for_you:${spec.seedHash}` : `${spec.pool}:${spec.mediaType}`;
}

function isStreamId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const [pool, rest, extra] = id.split(":");
  if (extra !== undefined || rest === undefined) return false;
  if (pool === "for_you") return SEED_HASH.test(rest);
  return (DISCOVER_POOLS as readonly string[]).includes(pool) && (rest === "movie" || rest === "tv");
}

/** A short, one-way hash of the parts. */
export function fingerprint(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 22);
}

/** The cursor's name for a seed's stream: a hash of the user and the seed, so the cursor shows no title. */
export function seedStreamHash(userId: string, seed: TitleId): string {
  return fingerprint([userId, seed.mediaType, seed.tmdbId]).slice(0, SEED_HASH_LENGTH);
}

/** A canonical string for a filter set, so a cursor can only continue the deck it came from. */
export function canonicalFilters(f: DeckFilters): string {
  return JSON.stringify({
    t: [...new Set(f.mediaTypes ?? [])].sort(),
    g: [...new Set(f.genreIds ?? [])].sort((a, b) => a - b),
    y: [f.era?.fromYear ?? null, f.era?.toYear ?? null],
    s: f.onMyServices === true,
    // Only when set, so cursors from before this filter existed still continue their deck.
    ...(typeof f.minImdbRating === "number" ? { r: f.minImdbRating } : {}),
  });
}

export function encodeCursor(state: CursorState): string {
  const body = {
    v: CURSOR_VERSION,
    m: state.mode,
    f: state.filters,
    c: state.context,
    // Only when set, so a cursor from before the shuffle still continues its (ranked) deck.
    ...(state.shuffleSeed !== null ? { r: state.shuffleSeed } : {}),
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
  const { v, m, f, c, r, s } = body as Record<string, unknown>;
  if (v !== CURSOR_VERSION || typeof m !== "string" || typeof f !== "string" || !Array.isArray(s)) return "cursor is malformed";
  if (typeof c !== "string" || !FINGERPRINT.test(c)) return "cursor is malformed";
  if (r !== undefined && !isShuffleSeed(r)) return "cursor is malformed";
  if (s.length > MAX_STREAMS) return "cursor names too many streams";
  const positions = new Map<string, StreamPosition>();
  for (const entry of s) {
    if (!Array.isArray(entry) || entry.length !== 3) return "cursor is malformed";
    const [id, page, offset] = entry as unknown[];
    if (!isStreamId(id) || !isWhole(page, TMDB_MAX_PAGE) || !isWhole(offset, MAX_OFFSET)) return "cursor is malformed";
    if (positions.has(id)) return "cursor repeats a stream";
    positions.set(id, { page, offset });
  }
  return { mode: m as DiscoveryMode, filters: f, context: c, shuffleSeed: r ?? null, positions };
}
