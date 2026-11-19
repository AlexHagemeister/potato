// The similar-titles service: the "You might also like" row on a title's
// card, for the title screen and a future MCP. It reads TMDB's
// recommendations for the title, ranks them against the user's own library
// (./rank.ts), and returns rows ready to show.
//
// The bound on TMDB work per call, most of it served from the shared cache:
// - SIMILAR_REC_PAGES recommendation pages for the viewed title.
// - For each of up to FAVORITE_COUNT liked titles, one recommendations page
//   (the same cache entry the For you deck reads) and one details lookup for
//   its name.
// - One details lookup per shortlisted title, at most DETAILS_CAP.
// Details go through lookupTitles: the 7-day details cache, read in one batch,
// with no streaming refresh, since the row shows no streaming.
// So at most 2 + 2 * 5 + 40 = 52 lookups, plus one IMDb ratings query (and a
// one-row probe of the ratings table when it finds nothing).
//
// Dependencies are injected, so tests run with fakes. index.ts wires the real ones.

import { createVisibilityCheck } from "../deck/build-deck";
import { getRatingsForFilter, type RatingsDatasetProbe, type RatingsStore } from "../imdb/ratings";
import { fail, ok, validateUserId, type Result } from "../result";
import type { TmdbClient } from "../tmdb/client";
import type { TitleSummary } from "../tmdb/types";
import { formatTitleKey, titleIdError, type MediaType } from "../title-id";
import type { ImdbRating, TitleId, UserTitleState } from "../types";
import { FAVORITE_COUNT, FAVORITE_MIN_RATING, SIMILAR_REC_PAGES } from "./constants";
import { finalize, shortlist, type Favorite, type FoundDetails } from "./rank";
import type { SimilarTitle } from "./types";

/** The TMDB calls the service makes. The app passes getTmdb(). */
export type SimilarTmdb = Pick<TmdbClient, "recommendations" | "lookupTitles">;

/** The library reads the service makes. index.ts wires them to the library core. */
export interface SimilarLibrary {
  /** Every row the user has (the deck's hiding rule reads them). */
  getUserTitleStates(userId: string): Promise<Result<UserTitleState[]>>;
  /** Seen titles of these media types rated at least minRating, highest first, at most limit. */
  getTopRatedSeen(userId: string, mediaTypes: readonly MediaType[], limit: number, minRating: number): Promise<Result<TitleId[]>>;
}

export interface SimilarServiceDeps {
  tmdb: SimilarTmdb;
  ratings: RatingsStore & RatingsDatasetProbe;
  library: SimilarLibrary;
  now?: () => Date;
}

export type SimilarService = ReturnType<typeof createSimilarService>;

/** Favorites come from both movies and series, whatever the title on screen is. */
const BOTH: readonly MediaType[] = ["movie", "tv"];

export function createSimilarService(deps: SimilarServiceDeps) {
  const { tmdb, ratings, library } = deps;
  const clock = deps.now ?? (() => new Date());

  /**
   * Titles to show under this title's card, best first, at most SIMILAR_LIMIT.
   * Empty when TMDB has no recommendations for it, or every one is filtered
   * out. Bad input returns a typed error. TMDB failing on the viewed title's
   * first recommendations page throws, so a caller can tell "nothing to
   * suggest" from "TMDB is down". Any other single lookup failing only drops
   * what it would have added.
   */
  async function similarTitles(userId: string, ref: TitleId): Promise<Result<SimilarTitle[]>> {
    const u = validateUserId(userId);
    if (!u.ok) return u;
    const error = titleIdError(ref);
    if (error) return fail({ code: "invalid_title", message: error });
    const viewed: TitleId = { mediaType: ref.mediaType, tmdbId: ref.tmdbId };
    const viewedKey = formatTitleKey(viewed);

    const pages = Array.from({ length: SIMILAR_REC_PAGES }, (_, i) => i + 1);
    const [recPages, states, liked] = await Promise.all([
      Promise.all(
        // Only the first page decides "TMDB is down". A later page failing just leaves fewer candidates.
        pages.map((page) =>
          page === 1 ? tmdb.recommendations(viewed, {}, page) : tmdb.recommendations(viewed, {}, page).catch(() => null),
        ),
      ),
      library.getUserTitleStates(u.value),
      // One extra, since the viewed title may be among them.
      library.getTopRatedSeen(u.value, BOTH, FAVORITE_COUNT + 1, FAVORITE_MIN_RATING),
    ]);
    if (!states.ok) return states;
    if (!liked.ok) return liked;

    const first = recPages[0]!;
    const recommendations: TitleSummary[] = recPages
      .slice(0, Math.max(1, first.totalPages))
      .flatMap((p) => p?.results ?? []);
    if (recommendations.length === 0) return ok([]);

    const favoriteRefs = liked.value.filter((f) => formatTitleKey(f) !== viewedKey).slice(0, FAVORITE_COUNT);
    // Details through lookupTitles, which reads the 7-day details cache and never refreshes streaming
    // availability the row doesn't show. A title it can't read is left out of the map, and drops only itself.
    const [favoriteDetails, favoriteRecs] = await Promise.all([
      tmdb.lookupTitles(favoriteRefs),
      Promise.all(
        favoriteRefs.map((f) =>
          tmdb.recommendations(f, {}, 1).catch((err: unknown) => {
            console.warn(`similar: liked title ${formatTitleKey(f)} failed:`, err);
            return null;
          }),
        ),
      ),
    ]);
    const favorites = favoriteRefs.flatMap((f, i): Favorite[] => {
      const name = favoriteDetails.get(formatTitleKey(f))?.title;
      const recs = favoriteRecs[i];
      return name && recs ? [{ title: name, recommendations: recs.results }] : [];
    });

    const candidates = shortlist({ viewed, recommendations, favorites, visible: createVisibilityCheck(states.value, clock()) });

    const found = await tmdb.lookupTitles(candidates.map((c) => c.summary));
    const details = new Map<string, FoundDetails>();
    for (const [key, d] of found) details.set(key, { imdbId: d.imdbId, collectionId: d.collectionId });

    const imdbIds = [...details.values()].flatMap((d) => (d.imdbId ? [d.imdbId] : []));
    let rated: ReadonlyMap<string, ImdbRating> | "unavailable";
    try {
      // Throws when the ratings table is empty (the first daily load has not landed): then the floor is skipped.
      rated = await getRatingsForFilter(ratings, imdbIds);
    } catch (err) {
      console.warn("similar: IMDb ratings unavailable:", err);
      rated = "unavailable";
    }
    return ok(finalize(candidates, details, rated));
  }

  return { similarTitles };
}
