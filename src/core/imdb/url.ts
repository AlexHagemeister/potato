// A title's page on IMDb. Kept apart from the module index so client code can
// import it without pulling in the Postgres ratings store.

const IMDB_ID = /^tt\d+$/;

/**
 * The IMDb page for a title, or null when there is no usable IMDb ID. The ID
 * is checked again here (TMDB normalization already checks it) so nothing but
 * "tt" plus digits ever reaches a link.
 */
export function imdbTitleUrl(imdbId: string | null | undefined): string | null {
  if (!imdbId || !IMDB_ID.test(imdbId)) return null;
  return `https://www.imdb.com/title/${imdbId}/`;
}
