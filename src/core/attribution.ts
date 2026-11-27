// The data credits the providers' terms require (CLAUDE.md architecture rule
// 7), in one place so the UI, the API, and later the MCP all carry the same
// text. These are licence terms: change a string only when its source changes,
// and check the source first. attribution.test.ts pins each one verbatim.
//
// TMDB: an approved logo plus its notice, in a Credits section (the Profile
// tab). JustWatch: TMDB requires crediting JustWatch as the source of the
// watch-provider data, so every place that shows streaming availability
// carries it. IMDb: its terms for the non-commercial datasets require a fixed
// statement acknowledging the source.

// TMDB API Terms of Use, section 3 (https://www.themoviedb.org/api-terms-of-use).
export const TMDB_NOTICE =
  "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";

// IMDb's required statement, verbatim, from "Can I use IMDb data in my software?"
// (https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX).
export const IMDB_NOTICE = "Information courtesy of IMDb (https://www.imdb.com). Used with permission.";

/**
 * The credit every place that shows streaming availability must carry. TMDB's
 * watch-provider data comes from JustWatch, and TMDB revokes API access for
 * non-compliance. It travels in every card payload (CardStreaming.attribution).
 */
export const JUSTWATCH_ATTRIBUTION = {
  text: "Streaming availability from JustWatch",
  url: "https://www.justwatch.com",
} as const;
