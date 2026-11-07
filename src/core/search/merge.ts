// Paging rule for search results. Pure (no database), so a screen that shows
// several pages in one list can apply it in the browser.

import { formatTitleKey } from "../title-id";
import type { SearchResult } from "./types";

/**
 * The results shown so far followed by a later page's results. A title can sit
 * on two TMDB pages when its ranking shifts between requests: it keeps its
 * first place, and the later copy is dropped. Titles are matched on the
 * (media type, TMDB ID) pair.
 */
export function mergeSearchPages(shown: readonly SearchResult[], next: readonly SearchResult[]): SearchResult[] {
  const seen = new Set(shown.map((r) => formatTitleKey(r)));
  const out = [...shown];
  for (const r of next) {
    const key = formatTitleKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
