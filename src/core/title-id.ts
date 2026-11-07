// A title's identity is the pair (media type, TMDB ID). Movie and series IDs
// come from separate TMDB pools, so an ID alone is ambiguous.

export type MediaType = "movie" | "tv";

export interface TitleId {
  mediaType: MediaType;
  tmdbId: number;
}

/** Stable string form of a title identity, for cache keys and URLs: "movie:603". */
export function formatTitleKey(id: TitleId): string {
  if (!Number.isSafeInteger(id.tmdbId) || id.tmdbId <= 0) {
    throw new Error(`Invalid TMDB ID: ${id.tmdbId}`);
  }
  return `${id.mediaType}:${id.tmdbId}`;
}

/** Inverse of formatTitleKey. Returns null for anything that is not a valid key. */
export function parseTitleKey(key: string): TitleId | null {
  const match = /^(movie|tv):([1-9]\d*)$/.exec(key);
  if (!match) return null;
  const tmdbId = Number(match[2]);
  if (!Number.isSafeInteger(tmdbId)) return null;
  return { mediaType: match[1] as MediaType, tmdbId };
}
