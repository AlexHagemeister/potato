// Shapes the similar-titles service hands to the UI, the API, and a future MCP.
// A title is always the pair (media type, TMDB ID) (CLAUDE.md architecture rule 1).

import type { TitleId } from "../types";

/** One title in the "You might also like" row. Opening it shows the full card (getCard). */
export interface SimilarTitle extends TitleId {
  title: string;
  /** Release year (movie) or first air year (series). Null when TMDB has no date. */
  year: number | null;
  /** Thumbnail poster URL, or null when TMDB has no poster. */
  posterUrl: string | null;
  /** IMDb's rating, or null when the ratings could not be read. A title IMDb has not rated never makes the row. */
  imdbRating: number | null;
  /**
   * The titles the user liked that also lead here, by name, strongest first.
   * Empty when only the title being viewed does.
   */
  because: string[];
  /** The line to show under the title, worded from `because` ("Because you liked Arrival"). Null when `because` is empty. */
  reason: string | null;
}
