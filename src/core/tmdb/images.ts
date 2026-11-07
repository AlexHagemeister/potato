// TMDB image URLs. Sizes are the ones /configuration lists for each image kind.

import { TMDB_IMAGE_BASE } from "./constants";

export type PosterSize = "w92" | "w154" | "w185" | "w342" | "w500" | "w780" | "original";
export type LogoSize = "w45" | "w92" | "w154" | "w185" | "w300" | "w500" | "original";

/** Thumbnail size for a row of titles (Lists, Search): rows show posters about 56pt wide, so w185 stays sharp at 3x. */
export const ROW_POSTER_SIZE: PosterSize = "w185";

/** Card-size poster by default. Null in, null out, so callers can pass TMDB's nullable path straight through. */
export function posterUrl(path: string | null | undefined, size: PosterSize = "w500"): string | null {
  return imageUrl(path, size);
}

/** Streaming-service logos and the like. */
export function logoUrl(path: string | null | undefined, size: LogoSize = "w92"): string | null {
  return imageUrl(path, size);
}

function imageUrl(path: string | null | undefined, size: string): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}${size}${path.startsWith("/") ? path : `/${path}`}`;
}
