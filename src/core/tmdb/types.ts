// Normalized TMDB shapes. Everything outside src/core/tmdb sees these, never
// raw TMDB payloads.

import type { Candidate, MediaType } from "../types";

/** A title as it appears in a list of results (discover, recommendations, search). It is a deck Candidate plus display fields. */
export interface TitleSummary extends Candidate {
  posterPath: string | null;
  overview: string;
}

export interface Genre {
  id: number;
  name: string;
}

export interface WatchProvider {
  id: number;
  name: string;
  logoPath: string | null;
  /** TMDB's display order within a country (lower first). */
  displayPriority: number;
}

/** Where a title can be watched in one country. Each list is empty when TMDB lists none. */
export interface CountryProviders {
  /** TMDB's watch page for the title in this country. JustWatch supplies the data behind it. */
  link: string | null;
  /** Included with a subscription. */
  flatrate: WatchProvider[];
  /** Free to stream. */
  free: WatchProvider[];
  /** Free with ads. */
  ads: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
}

/** Watch providers keyed by ISO 3166-1 country code ("US"). Data from JustWatch, via TMDB. */
export type ProvidersByCountry = Record<string, CountryProviders>;

/** Everything a card shows about one title. */
export interface TitleDetails extends TitleSummary {
  genres: Genre[];
  /** Movie runtime in minutes. Null for series, or when TMDB has none. */
  runtimeMinutes: number | null;
  /** Series season count. Null for movies. */
  numberOfSeasons: number | null;
  /** Full poster URL at card size, or null when TMDB has no poster. */
  posterUrl: string | null;
  /** IMDb ID ("tt0133093"), or null when TMDB has no mapping. */
  imdbId: string | null;
  /** YouTube video key of the best trailer, or null when there is none. */
  trailerYouTubeKey: string | null;
  /**
   * Where the title streams, by country. Null when availability is unknown:
   * the providers lookup failed and nothing was cached. A known title that
   * streams nowhere is `{}`, or has no entry for the country.
   */
  providersByCountry: ProvidersByCountry | null;
}

/** A provider in a country's list of available services, for the settings screen. */
export interface ProviderListEntry extends WatchProvider {
  /** Which media types TMDB lists this provider for. */
  mediaTypes: MediaType[];
}

/** A country TMDB has streaming data for (JustWatch's coverage). */
export interface WatchRegion {
  /** ISO 3166-1 alpha-2 code ("US"). */
  code: string;
  /** English name ("United States"). */
  name: string;
}

/** Filters for one discover query. TMDB discover runs per media type, so there is one media type, not a list. */
export interface DiscoverFilters {
  mediaType: MediaType;
  /** Matches a title in any of these genres. Genre IDs differ between movies and series. */
  genreIds?: number[];
  /** Inclusive year bounds on release year (movie) or first air year (series). */
  era?: { fromYear?: number; toYear?: number };
  /** Only titles streaming (subscription, free, or with ads) on at least one of these services in `watchRegion`. */
  providerIds?: number[];
  /** ISO 3166-1 country code. Required when providerIds is set. */
  watchRegion?: string;
}

export interface ResultPage<T> {
  results: T[];
  page: number;
  totalPages: number;
}
