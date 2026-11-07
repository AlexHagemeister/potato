// Data credits (CLAUDE.md rule 7), kept to what the terms require and no
// more. TMDB: an approved logo, less prominent than the app's own mark, plus
// its notice, in a Credits section. JustWatch: TMDB requires crediting
// JustWatch as the source of the watch-provider data.

// TMDB's "blue short" logo from https://www.themoviedb.org/about/logos-attribution,
// copied unmodified into public/ so the credit can't break if TMDB moves it.
const TMDB_LOGO_URL = "/tmdb-logo.svg";

export const TMDB_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

export function Attribution() {
  return (
    <footer aria-label="Credits" className="mt-12 space-y-2 text-xs leading-snug text-muted">
      {/* A plain img: next/image refuses SVGs by default, and this needs no resizing. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={TMDB_LOGO_URL} alt="TMDB" width={77} height={10} className="h-2.5 w-auto" />
      <p>{TMDB_NOTICE}</p>
      <p>Streaming data from JustWatch.</p>
    </footer>
  );
}
