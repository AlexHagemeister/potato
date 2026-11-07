// Shapes the search service hands to the UI, the API, and a future MCP. A
// title is always the pair (media type, TMDB ID) (CLAUDE.md architecture rule 1).

import type { TitleId, TitleStatus } from "../types";

/** One title in a list of search results, ready to show as a row. Opening it shows the full card (getCard). */
export interface SearchResult extends TitleId {
  title: string;
  /** Release year (movie) or first air year (series). Null when TMDB has no date. */
  year: number | null;
  /** Thumbnail poster URL, or null when TMDB has no poster. */
  posterUrl: string | null;
  /** TMDB's synopsis. Empty when TMDB has none. */
  overview: string;
  /**
   * Where the title stands for this user, so a row can show it is already on
   * a list. "skipped" only while the skip lasts: once the title is back in
   * the deck, it is null, like a title the user never touched.
   */
  status: TitleStatus | null;
}

/** One page of search results, in TMDB's relevance order. */
export interface SearchPage {
  /** The query as searched: trimmed, inner whitespace collapsed. */
  query: string;
  results: SearchResult[];
  page: number;
  /** 0 when nothing matched. A page past it is empty. */
  totalPages: number;
}
