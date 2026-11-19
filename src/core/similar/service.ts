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
// - One details lookup per shortlisted title, at most DETAILS_CAP, run
//   TMDB_FANOUT_CONCURRENCY at a time.
// So at most 2 + 2 * 5 + 40 = 52 lookups, plus one IMDb ratings query (and a
// one-row probe of the ratings table when it finds nothing).
//
// Dependencies are injected, so tests run with fakes. index.ts wires the real ones.

import { mapWithConcurrency } from "../concurrency";
import { createVisibilityCheck } from "../deck/build-deck";
import { getRatingsForFilter, type RatingsDatasetProbe, type RatingsStore } from "../imdb/ratings";
import { fail, ok, validateUserId, type Result } from "../result";
import type { TmdbClient } from "../tmdb/client";
import { TMDB_FANOUT_CONCURRENCY } from "../tmdb/constants";
import type { TitleSummary } from "../tmdb/types";
import { formatTitleKey, titleIdError } from "../title-id";
import type { ImdbRating, TitleId, UserTitleState } from "../types";
import { DETAILS_CAP, FAVORITE_COUNT, FAVORITE_MIN_RATING, SIMILAR_REC_PAGES } from "./constants";
import { finalize, shortlist, type Favorite, type FoundDetails } from "./rank";
import type { SimilarTitle } from "./types";

/** The TMDB calls the service makes. The app passes getTmdb(). */
export type SimilarTmdb = Pick<TmdbClient, "recommendations" | "getTitleDetails">;

/** The library reads the service makes. index.ts wires them to the library core. */
export interface SimilarLibrary {
  /** Every row the user has (the deck's hiding rule reads them). */
  getUserTitleStates(userId: string): Promise<Result<UserTitleState[]>>;
  /** Seen titles rated at least minRating, highest first, at most limit. */
  getFavoriteSeen(userId: string, minRating: number, limit: number): Promise<Result<(TitleId & { rating: number })[]>>;
}

export interface SimilarServiceDeps {
  tmdb: SimilarTmdb;
  ratings: RatingsStore & RatingsDatasetProbe;
  library: SimilarLibrary;
  now?: () => Date;
}

export type SimilarService = ReturnType<typeof createSimilarService>;

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
      library.getFavoriteSeen(u.value, FAVORITE_MIN_RATING, FAVORITE_COUNT + 1),
    ]);
    if (!states.ok) return states;
    if (!liked.ok) return liked;

    const first = recPages[0]!;
    const recommendations: TitleSummary[] = recPages
      .slice(0, Math.max(1, first.totalPages))
      .flatMap((p) => p?.results ?? []);
    if (recommendations.length === 0) return ok([]);

    const favoriteRefs = liked.value.filter((f) => formatTitleKey(f) !== viewedKey).slice(0, FAVORITE_COUNT);
    const favorites = (
      await Promise.all(
        favoriteRefs.map(async (f): Promise<Favorite | null> => {
          try {
            const [details, recs] = await Promise.all([tmdb.getTitleDetails(f.mediaType, f.tmdbId), tmdb.recommendations(f, {}, 1)]);
            return details ? { title: details.title, recommendations: recs.results } : null;
          } catch (err) {
            console.warn(`similar: liked title ${formatTitleKey(f)} failed:`, err);
            return null;
          }
        }),
      )
    ).filter((f): f is Favorite => f !== null);

    const candidates = shortlist({ viewed, recommendations, favorites, visible: createVisibilityCheck(states.value, clock()) });

    const details = new Map<string, FoundDetails>();
    await mapWithConcurrency(candidates.slice(0, DETAILS_CAP), TMDB_FANOUT_CONCURRENCY, async ({ summary }) => {
      try {
        const d = await tmdb.getTitleDetails(summary.mediaType, summary.tmdbId);
        if (d) details.set(formatTitleKey(summary), { imdbId: d.imdbId, collectionId: d.collectionId });
      } catch (err) {
        console.warn(`similar: details for ${formatTitleKey(summary)} failed:`, err);
      }
    });

    const imdbIds = [...details.values()].flatMap((d) => (d.imdbId ? [d.imdbId] : []));
    let found: ReadonlyMap<string, ImdbRating> | "unavailable";
    try {
      // Throws when the ratings table is empty (the first daily load has not landed): then the floor is skipped.
      found = await getRatingsForFilter(ratings, imdbIds);
    } catch (err) {
      console.warn("similar: IMDb ratings unavailable:", err);
      found = "unavailable";
    }
    return ok(finalize(candidates, details, found));
  }

  return { similarTitles };
}
