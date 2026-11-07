// Maps title_status rows into TitleRecord. Two sources: Drizzle selects
// (camelCase, Date objects) and the raw write statements, which return rows
// through row_to_json (snake_case, ISO date strings, numeric as a JSON number).

import type { titleStatus } from "@/db/schema";
import type { TitleRecord } from "./types";

type DrizzleRow = typeof titleStatus.$inferSelect;

export function recordFromDrizzle(row: DrizzleRow): TitleRecord {
  return {
    mediaType: row.mediaType,
    tmdbId: row.tmdbId,
    status: row.status,
    rating: row.rating === null ? null : Number(row.rating),
    review: row.review,
    reviewVisibility: row.reviewVisibility,
    skipUntil: row.skipUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A title_status row as row_to_json renders it. Null when the statement found no row. */
export function recordFromJson(json: unknown): TitleRecord | null {
  if (json === null || json === undefined) return null;
  // The neon driver parses json columns, but accept text too in case a driver change stops that.
  const r = (typeof json === "string" ? JSON.parse(json) : json) as Record<string, unknown>;
  const date = (v: unknown) => new Date(v as string);
  return {
    mediaType: r.media_type as TitleRecord["mediaType"],
    tmdbId: Number(r.tmdb_id),
    status: r.status as TitleRecord["status"],
    rating: r.rating === null ? null : Number(r.rating),
    review: (r.review as string | null) ?? null,
    reviewVisibility: r.review_visibility as TitleRecord["reviewVisibility"],
    skipUntil: r.skip_until === null ? null : date(r.skip_until),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}
