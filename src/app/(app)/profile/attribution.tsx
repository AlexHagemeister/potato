import { IMDB_NOTICE, JUSTWATCH_ATTRIBUTION, TMDB_NOTICE } from "@/core/attribution";

// Data credits (CLAUDE.md rule 7), kept to what the terms require and no
// more. The wording lives in src/core/attribution.ts, so the cards, the API,
// and this section read the same text. TMDB: an approved logo, less prominent
// than the app's own mark, plus its notice, in a Credits section. JustWatch:
// TMDB requires crediting JustWatch as the source of the watch-provider data.
// IMDb: its terms for the non-commercial datasets require a fixed statement
// acknowledging the source. They name no placement, so it sits here with the
// other credits.

// TMDB's "blue short" logo from https://www.themoviedb.org/about/logos-attribution,
// copied unmodified into public/ so the credit can't break if TMDB moves it.
const TMDB_LOGO_URL = "/tmdb-logo.svg";

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
      <p>{JUSTWATCH_ATTRIBUTION.text}</p>
      <p>{IMDB_NOTICE}</p>
    </footer>
  );
}
