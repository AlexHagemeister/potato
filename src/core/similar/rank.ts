// The ranking behind the similar-titles row. Pure functions, no I/O: the
// service fetches, these decide. Two steps, because the second needs a
// details lookup per title and the first keeps that number bounded.
//
// 1. shortlist: TMDB's recommendations for the title being viewed, minus
//    titles the deck would hide (on a list, or skipped until later: VISION
//    invariant 3) and filler TMDB's own numbers rule out, scored by closeness plus agreement from
//    the titles the user liked. Capped at DETAILS_CAP.
// 2. finalize: the IMDb floor and a small quality boost, one title per
//    franchise, capped at SIMILAR_LIMIT.

import { posterUrl, ROW_POSTER_SIZE } from "../tmdb/images";
import type { TitleSummary } from "../tmdb/types";
import { formatTitleKey } from "../title-id";
import type { ImdbRating, TitleId } from "../types";
import {
  AGREEMENT_WEIGHT,
  DETAILS_CAP,
  IMDB_FLOOR,
  IMDB_MIN_VOTES,
  IMDB_TOP,
  MAX_AGREEMENT,
  MIN_TMDB_AVERAGE,
  MIN_TMDB_VOTES,
  QUALITY_WEIGHT,
  SIMILAR_LIMIT,
} from "./constants";
import type { SimilarTitle } from "./types";

/** A title the user liked, with TMDB's recommendations for it. */
export interface Favorite {
  title: string;
  recommendations: readonly TitleSummary[];
}

export interface ShortlistInput {
  /** The title being viewed. Never recommended to itself. */
  viewed: TitleId;
  /** TMDB's recommendations for it, in TMDB's order (closest first). Pages may overlap. */
  recommendations: readonly TitleSummary[];
  /** The titles the user liked, strongest first, not including the viewed title. */
  favorites: readonly Favorite[];
  /** The deck's own rule: false for a title on a list or skipped until later. */
  visible: (t: TitleId) => boolean;
}

export interface Shortlisted {
  summary: TitleSummary;
  score: number;
  because: string[];
}

export function shortlist(input: ShortlistInput): Shortlisted[] {
  const viewedKey = formatTitleKey(input.viewed);
  const seen = new Set<string>();
  const recs = input.recommendations.filter((t) => {
    const key = formatTitleKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const favoriteKeys = input.favorites.map((f) => new Set(f.recommendations.map(formatTitleKey)));

  const out: (Shortlisted & { index: number })[] = [];
  recs.forEach((t, index) => {
    const key = formatTitleKey(t);
    if (key === viewedKey || !input.visible(t) || t.tmdbVoteCount < MIN_TMDB_VOTES || t.tmdbVoteAverage < MIN_TMDB_AVERAGE) return;
    const because = input.favorites.filter((_, i) => favoriteKeys[i].has(key)).map((f) => f.title);
    const closeness = 1 - index / recs.length;
    out.push({ summary: t, score: closeness + AGREEMENT_WEIGHT * Math.min(because.length, MAX_AGREEMENT), because, index });
  });
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out.slice(0, DETAILS_CAP).map(({ summary, score, because }) => ({ summary, score, because }));
}

/** What a details lookup found for a title. Undefined in the map: the lookup failed, or TMDB doesn't know the title. */
export interface FoundDetails {
  imdbId: string | null;
  /** Undefined on details cached before the field existed: unknown, so never collapsed. */
  collectionId?: number | null;
}

export function finalize(
  shortlisted: readonly Shortlisted[],
  details: ReadonlyMap<string, FoundDetails>,
  /** IMDb ratings by IMDb ID, or "unavailable" when they can't be trusted: the floor is skipped, never applied to nothing. */
  ratings: ReadonlyMap<string, ImdbRating> | "unavailable",
): SimilarTitle[] {
  const scored: { item: Shortlisted; score: number; imdbRating: number | null; collectionId: number | null }[] = [];
  for (const item of shortlisted) {
    const d = details.get(formatTitleKey(item.summary));
    if (!d) continue;
    let score = item.score;
    let imdbRating: number | null = null;
    if (ratings !== "unavailable") {
      const r = d.imdbId ? ratings.get(d.imdbId) : undefined;
      if (!r || r.rating < IMDB_FLOOR || r.votes < IMDB_MIN_VOTES) continue;
      imdbRating = r.rating;
      score += QUALITY_WEIGHT * Math.min(1, (r.rating - IMDB_FLOOR) / (IMDB_TOP - IMDB_FLOOR));
    }
    scored.push({ item, score, imdbRating, collectionId: d.collectionId ?? null });
  }
  // A stable sort: equal scores keep the shortlist's order.
  scored.sort((a, b) => b.score - a.score);

  const franchises = new Set<number>();
  const out: SimilarTitle[] = [];
  for (const { item, imdbRating, collectionId } of scored) {
    if (collectionId !== null) {
      if (franchises.has(collectionId)) continue;
      franchises.add(collectionId);
    }
    const t = item.summary;
    out.push({
      mediaType: t.mediaType,
      tmdbId: t.tmdbId,
      title: t.title,
      year: t.year,
      posterUrl: posterUrl(t.posterPath, ROW_POSTER_SIZE),
      imdbRating,
      because: item.because,
    });
    if (out.length === SIMILAR_LIMIT) break;
  }
  return out;
}
