// Turns raw TMDB payloads into the normalized shapes in ./types. Raw payloads
// are read defensively: a missing or odd field becomes a null or an empty
// list, never a crash.

import type { MediaType } from "../types";
import { posterUrl } from "./images";
import type {
  CountryProviders,
  Genre,
  ProvidersByCountry,
  TitleDetails,
  TitleSummary,
  WatchProvider,
} from "./types";

// Raw shapes, only the fields we read. Every field is optional because TMDB
// omits fields freely.

export interface RawTitle {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  genres?: { id?: number; name?: string }[];
  popularity?: number;
  vote_average?: number;
  vote_count?: number;
  poster_path?: string | null;
  overview?: string;
  adult?: boolean;
  runtime?: number | null;
  number_of_seasons?: number | null;
  imdb_id?: string | null;
  external_ids?: { imdb_id?: string | null };
  videos?: { results?: RawVideo[] };
  "watch/providers"?: RawWatchProviders;
}

export interface RawVideo {
  key?: string;
  site?: string;
  type?: string;
  official?: boolean;
  iso_639_1?: string;
  published_at?: string;
  size?: number;
}

export interface RawWatchProviders {
  results?: Record<string, RawCountryProviders>;
}

interface RawCountryProviders {
  link?: string;
  flatrate?: RawProvider[];
  free?: RawProvider[];
  ads?: RawProvider[];
  rent?: RawProvider[];
  buy?: RawProvider[];
}

export interface RawProvider {
  provider_id?: number;
  provider_name?: string;
  logo_path?: string | null;
  display_priority?: number;
  display_priorities?: Record<string, number>;
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Year from a "YYYY-MM-DD" date, or null. */
export function yearOf(date: string | undefined): number | null {
  const m = /^(\d{4})/.exec(date ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * A list result (discover, recommendations, search) as a TitleSummary, or
 * null when it is not a usable movie or series (wrong media type, adult, no ID).
 */
export function normalizeSummary(raw: RawTitle, mediaType: MediaType): TitleSummary | null {
  if (!isPositiveInt(raw.id) || raw.adult === true) return null;
  const title = str(mediaType === "movie" ? raw.title : raw.name) ?? str(raw.title) ?? str(raw.name);
  if (!title) return null;
  return {
    mediaType,
    tmdbId: raw.id,
    title,
    year: yearOf(mediaType === "movie" ? raw.release_date : raw.first_air_date),
    genreIds: (raw.genre_ids ?? raw.genres?.map((g) => g.id) ?? []).filter(isPositiveInt),
    popularity: num(raw.popularity),
    tmdbVoteAverage: num(raw.vote_average),
    tmdbVoteCount: num(raw.vote_count),
    posterPath: str(raw.poster_path),
    overview: raw.overview ?? "",
  };
}

/** Details without providers: what is cached for 7 days. */
export type DetailsCore = Omit<TitleDetails, "providersByCountry">;

export function normalizeDetailsCore(raw: RawTitle, mediaType: MediaType): DetailsCore | null {
  const summary = normalizeSummary(raw, mediaType);
  if (!summary) return null;
  const genres: Genre[] = (raw.genres ?? [])
    .filter((g): g is { id: number; name: string } => isPositiveInt(g.id) && typeof g.name === "string")
    .map((g) => ({ id: g.id, name: g.name }));
  const imdbId = str(raw.external_ids?.imdb_id) ?? str(raw.imdb_id);
  return {
    ...summary,
    genreIds: genres.length ? genres.map((g) => g.id) : summary.genreIds,
    genres,
    runtimeMinutes: mediaType === "movie" && isPositiveInt(raw.runtime) ? raw.runtime : null,
    numberOfSeasons: mediaType === "tv" && isPositiveInt(raw.number_of_seasons) ? raw.number_of_seasons : null,
    posterUrl: posterUrl(summary.posterPath),
    imdbId: imdbId && /^tt\d+$/.test(imdbId) ? imdbId : null,
    trailerYouTubeKey: pickTrailer(raw.videos?.results ?? []),
  };
}

const TYPE_RANK: Record<string, number> = { Trailer: 0, Teaser: 1 };

/**
 * The best YouTube trailer's key, or null. Only YouTube trailers and teasers
 * qualify (featurettes and clips are not trailers). Order: trailer before
 * teaser, official before unofficial, English before other languages, then
 * the earliest published, which is usually the original trailer rather than
 * a re-release spot.
 */
export function pickTrailer(videos: readonly RawVideo[]): string | null {
  const eligible = videos.filter(
    (v) => v.site === "YouTube" && typeof v.key === "string" && v.key !== "" && v.type !== undefined && v.type in TYPE_RANK,
  );
  if (eligible.length === 0) return null;
  const published = (v: RawVideo) => {
    const t = Date.parse(v.published_at ?? "");
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const sorted = [...eligible].sort(
    (a, b) =>
      TYPE_RANK[a.type!] - TYPE_RANK[b.type!] ||
      Number(b.official === true) - Number(a.official === true) ||
      Number(b.iso_639_1 === "en") - Number(a.iso_639_1 === "en") ||
      published(a) - published(b),
  );
  return sorted[0].key!;
}

function normalizeProvider(raw: RawProvider, country?: string): WatchProvider | null {
  if (!isPositiveInt(raw.provider_id) || !str(raw.provider_name)) return null;
  const priority = country !== undefined ? raw.display_priorities?.[country] : undefined;
  return {
    id: raw.provider_id,
    name: raw.provider_name!,
    logoPath: str(raw.logo_path),
    displayPriority: num(priority ?? raw.display_priority, Number.MAX_SAFE_INTEGER),
  };
}

function providerList(raw: RawProvider[] | undefined): WatchProvider[] {
  return (raw ?? [])
    .map((p) => normalizeProvider(p))
    .filter((p): p is WatchProvider => p !== null)
    .sort((a, b) => a.displayPriority - b.displayPriority);
}

/** A title's watch/providers payload, all countries. */
export function normalizeProviders(raw: RawWatchProviders | undefined): ProvidersByCountry {
  const out: ProvidersByCountry = {};
  for (const [country, value] of Object.entries(raw?.results ?? {})) {
    if (!/^[A-Z]{2}$/.test(country)) continue;
    const entry: CountryProviders = {
      link: str(value.link),
      flatrate: providerList(value.flatrate),
      free: providerList(value.free),
      ads: providerList(value.ads),
      rent: providerList(value.rent),
      buy: providerList(value.buy),
    };
    out[country] = entry;
  }
  return out;
}

/** One entry from /watch/providers/{movie|tv}, with its priority in `country`. */
export function normalizeListProvider(raw: RawProvider, country: string): WatchProvider | null {
  return normalizeProvider(raw, country);
}
