// Data credits (CLAUDE.md rule 7), kept to what the terms require and no
// more. TMDB: an approved logo, less prominent than the app's own mark, plus
// its notice, in a Credits section. JustWatch: TMDB requires crediting
// JustWatch as the source of the watch-provider data. IMDb: its non-commercial
// dataset terms require a fixed statement wherever the ratings are used.

// TMDB's "blue short" logo from https://www.themoviedb.org/about/logos-attribution,
// copied unmodified into public/ so the credit can't break if TMDB moves it.
const TMDB_LOGO_URL = "/tmdb-logo.svg";

// TMDB API Terms of Use, section 3 (https://www.themoviedb.org/api-terms-of-use).
export const TMDB_NOTICE =
  "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";

// IMDb's required statement, verbatim, from "Can I use IMDb data in my software?"
// (https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX).
export const IMDB_NOTICE = "Information courtesy of IMDb (https://www.imdb.com). Used with permission.";

export function Attribution() {
  return (
    <footer aria-labelledby="credits-heading" className="mt-12 space-y-2 px-1 text-xs leading-snug text-muted">
      {/* Visible on purpose: TMDB's FAQ places attribution in a "Credits" type section. */}
      <h2 id="credits-heading" className="font-semibold tracking-wide uppercase">
        Credits
      </h2>
      {/* A plain img: next/image refuses SVGs by default, and this needs no resizing. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={TMDB_LOGO_URL} alt="TMDB" width={77} height={10} className="h-2.5 w-auto" />
      <p>{TMDB_NOTICE}</p>
      <p>Streaming data from JustWatch.</p>
      <p>{IMDB_NOTICE}</p>
    </footer>
  );
}
