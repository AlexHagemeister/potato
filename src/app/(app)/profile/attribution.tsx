// Data credits (CLAUDE.md rule 7, mandatory). TMDB requires its notice and
// an approved logo in an About or Credits section, less prominent than the
// app's own name. TMDB's watch-provider data comes from JustWatch, which TMDB
// requires us to credit.

// TMDB's "alt short" logo from https://www.themoviedb.org/about/logos-attribution.
// Linked from TMDB rather than copied into the repo. If TMDB moves it, the
// image breaks: vendor it into public/ then.
const TMDB_LOGO_URL =
  "https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg";

export const TMDB_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

export function Attribution() {
  return (
    <section aria-labelledby="about-heading" className="mt-10 border-t border-hairline pt-6 text-sm text-muted">
      <h2 id="about-heading" className="mb-1 text-xl font-bold text-foreground">
        Potato
      </h2>
      <p className="mb-5">Decide what to watch, one card at a time.</p>

      <h3 className="mb-3 text-xs font-semibold tracking-wide uppercase">Credits</h3>
      {/* A plain img: next/image refuses SVGs by default, and this needs no resizing. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={TMDB_LOGO_URL} alt="TMDB" width={92} height={12} className="mb-3 h-3 w-auto" />
      <p className="mb-4">{TMDB_NOTICE}</p>
      <p>Streaming availability data from JustWatch.</p>
    </section>
  );
}
