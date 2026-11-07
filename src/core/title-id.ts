// A title's identity is the pair (media type, TMDB ID). Movie and series IDs
// come from separate TMDB pools, so an ID alone is ambiguous.

export type MediaType = "movie" | "tv";

export interface TitleId {
  mediaType: MediaType;
  tmdbId: number;
}

/** The largest TMDB ID a title can have: tmdb_id is a Postgres integer. */
export const MAX_TMDB_ID = 2_147_483_647;

/**
 * Why a value is not a valid title identity, or null when it is. The one
 * statement of the identity rules: formatTitleKey, parseTitleKey, and the
 * library's typed check all use it.
 */
export function titleIdError(id: unknown): string | null {
  if (typeof id !== "object" || id === null) return "title must be an object";
  const { mediaType, tmdbId } = id as Record<string, unknown>;
  if (mediaType !== "movie" && mediaType !== "tv") return `invalid media type ${JSON.stringify(mediaType)}`;
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0 || tmdbId > MAX_TMDB_ID) {
    return `invalid TMDB ID ${JSON.stringify(tmdbId)}`;
  }
  return null;
}

/** Stable string form of a title identity, for cache keys and URLs: "movie:603". */
export function formatTitleKey(id: TitleId): string {
  // Runtime check too: callers build TitleId from DB rows, URLs, and TMDB payloads.
  const error = titleIdError(id);
  if (error) throw new Error(`formatTitleKey: ${error}`);
  return `${id.mediaType}:${id.tmdbId}`;
}

/** Inverse of formatTitleKey. Returns null for anything that is not a valid key. */
export function parseTitleKey(key: string): TitleId | null {
  const match = /^(movie|tv):([1-9]\d*)$/.exec(key);
  if (!match) return null;
  const id = { mediaType: match[1] as MediaType, tmdbId: Number(match[2]) };
  return titleIdError(id) === null ? id : null;
}
