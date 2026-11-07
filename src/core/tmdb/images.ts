// TMDB image URLs. Sizes are the ones /configuration lists for each image kind.

import { TMDB_IMAGE_BASE } from "./constants";

export type PosterSize = "w92" | "w154" | "w185" | "w342" | "w500" | "w780" | "original";
export type LogoSize = "w45" | "w92" | "w154" | "w185" | "w300" | "w500" | "original";

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
