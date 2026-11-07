// Data credits (CLAUDE.md rule 7), kept to what the terms require and no
// more. TMDB: an approved logo, less prominent than the app's own mark, plus
// its notice, in a Credits section. JustWatch: TMDB requires crediting
// JustWatch as the source of the watch-provider data.

// TMDB's "alt short" logo from https://www.themoviedb.org/about/logos-attribution,
// unmodified. Linked from TMDB rather than copied into the repo. If TMDB moves
// it, the image breaks: vendor it into public/ then.
const TMDB_LOGO_URL =
  "https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg";

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
