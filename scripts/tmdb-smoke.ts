// Live smoke test of the TMDB module: fetches one movie and one series from
// the real API and prints what a card would show. Uses an in-memory cache and
// touches no database.
//
// Run: bun run scripts/tmdb-smoke.ts   (needs TMDB_API_READ_TOKEN, which Bun loads from .env.local)

import { MemoryCacheStore } from "../src/core/cache/cache-store";
import { createTmdbClientFromEnv, type TitleDetails } from "../src/core/tmdb";

const COUNTRY = "US";

function describeTitle(d: TitleDetails): string {
  const providers = d.providersByCountry[COUNTRY];
  const names = (list: { name: string }[] | undefined) => (list?.length ? list.map((p) => p.name).join(", ") : "none");
  return [
    `${d.title} (${d.year ?? "?"}) [${d.mediaType}:${d.tmdbId}]`,
    `  genres: ${d.genres.map((g) => g.name).join(", ")}`,
    d.mediaType === "movie" ? `  runtime: ${d.runtimeMinutes ?? "?"} min` : `  seasons: ${d.numberOfSeasons ?? "?"}`,
    `  imdbId: ${d.imdbId ?? "none"}`,
    `  trailer: ${d.trailerYouTubeKey ? `https://www.youtube.com/watch?v=${d.trailerYouTubeKey}` : "none"}`,
    `  poster: ${d.posterUrl ?? "none"}`,
    `  synopsis: ${d.overview.slice(0, 100)}${d.overview.length > 100 ? "..." : ""}`,
    `  ${COUNTRY} subscription: ${names(providers?.flatrate)}`,
    `  ${COUNTRY} rent: ${names(providers?.rent)}`,
    `  ${COUNTRY} buy: ${names(providers?.buy)}`,
    `  countries with data: ${Object.keys(d.providersByCountry).length}`,
  ].join("\n");
}

async function main() {
  const tmdb = createTmdbClientFromEnv(new MemoryCacheStore());
  const started = Date.now();

  for (const [mediaType, tmdbId] of [
    ["movie", 603],
    ["tv", 1396],
  ] as const) {
    const d = await tmdb.getTitleDetails(mediaType, tmdbId);
    if (!d) throw new Error(`${mediaType}:${tmdbId} not found`);
    console.log(describeTitle(d));
  }

  const missing = await tmdb.getTitleDetails("movie", 999_999_999);
  console.log(`404 check (movie:999999999): ${missing === null ? "null, as expected" : "UNEXPECTED RESULT"}`);

  const popular = await tmdb.discover("popular", { mediaType: "tv", providerIds: [8], watchRegion: COUNTRY });
  console.log(`discover popular tv on provider 8 in ${COUNTRY}: ${popular.results.length} results, first: ${popular.results[0]?.title}`);

  const search = await tmdb.searchTitles("severance");
  console.log(`search "severance": ${search.results.slice(0, 3).map((t) => `${t.title} [${t.mediaType}]`).join("; ")}`);

  console.log(`done in ${Date.now() - started} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
