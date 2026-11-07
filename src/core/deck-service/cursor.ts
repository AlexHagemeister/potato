// The deck's paging cursor. A deck page reads from several TMDB lists
// ("streams"): one discover list per pool and media type, and one
// recommendations list per "for you" seed. The cursor records where each
// stream stopped, so the next page reads on from there.
//
// The cursor is opaque to callers and arrives from the client, so decoding
// checks everything: a tampered cursor gets a typed error, never extra TMDB
// work (the stream count is capped).

import { tryFormatTitleKey } from "../title-id";
import type { DeckFilters, DiscoveryMode, MediaType, PoolName, TitleId } from "../types";
import { FOR_YOU_SEED_COUNT, MAX_LIST_PAGE } from "./constants";

export type DiscoverPoolName = Exclude<PoolName, "for_you">;

export type StreamSpec =
  | { pool: DiscoverPoolName; mediaType: MediaType }
  | { pool: "for_you"; seed: TitleId };

/** Where a stream stands: the next title is item `offset` of page `page`. Page 0 means exhausted. */
export interface StreamPosition {
  page: number;
  offset: number;
}

export interface CursorState {
  mode: DiscoveryMode;
  filters: string;
  streams: { spec: StreamSpec; position: StreamPosition }[];
}

const CURSOR_VERSION = 1;
/** A TMDB page holds 20 results. Anything far past that is tampering. */
const MAX_OFFSET = 1000;
const DISCOVER_POOLS: readonly DiscoverPoolName[] = ["popular", "deep_cuts", "top_rated"];

export function streamId(spec: StreamSpec): string {
  return spec.pool === "for_you" ? `for_you:${spec.seed.mediaType}:${spec.seed.tmdbId}` : `${spec.pool}:${spec.mediaType}`;
}

function parseStreamId(id: unknown): StreamSpec | null {
  if (typeof id !== "string") return null;
  const parts = id.split(":");
  if (parts.length === 2) {
    const [pool, mediaType] = parts;
    if (!(DISCOVER_POOLS as readonly string[]).includes(pool) || (mediaType !== "movie" && mediaType !== "tv")) return null;
    return { pool: pool as DiscoverPoolName, mediaType };
  }
  if (parts.length === 3 && parts[0] === "for_you" && /^[1-9]\d*$/.test(parts[2])) {
    const seed = { mediaType: parts[1], tmdbId: Number(parts[2]) };
    return tryFormatTitleKey(seed) === null ? null : { pool: "for_you", seed: seed as TitleId };
  }
  return null;
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
    s: state.streams.map(({ spec, position }) => [streamId(spec), position.page, position.offset]),
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
  const { v, m, f, s } = body as Record<string, unknown>;
  if (v !== CURSOR_VERSION || typeof m !== "string" || typeof f !== "string" || !Array.isArray(s)) return "cursor is malformed";
  if (s.length > DISCOVER_POOLS.length * 2 + FOR_YOU_SEED_COUNT) return "cursor names too many streams";
  const streams: CursorState["streams"] = [];
  const ids = new Set<string>();
  let seeds = 0;
  for (const entry of s) {
    if (!Array.isArray(entry) || entry.length !== 3) return "cursor is malformed";
    const [id, page, offset] = entry as unknown[];
    const spec = parseStreamId(id);
    if (!spec || !isWhole(page, MAX_LIST_PAGE) || !isWhole(offset, MAX_OFFSET)) return "cursor is malformed";
    if (ids.has(id as string)) return "cursor repeats a stream";
    ids.add(id as string);
    if (spec.pool === "for_you" && ++seeds > FOR_YOU_SEED_COUNT) return "cursor names too many streams";
    streams.push({ spec, position: { page, offset } });
  }
  return { mode: m as DiscoveryMode, filters: f, streams };
}
