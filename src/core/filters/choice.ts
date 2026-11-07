// What the filter control holds, and how it becomes the deck's filters.
//
// The control speaks in user terms: a type (movies, series, or both), named
// genres, an era preset, and "on my services". Core turns that into the
// engine's DeckFilters (TMDB genre IDs and year bounds), so the Discover deck,
// the Lists tab, and a future AI connection all read one choice the same way
// (CLAUDE.md rule 3). Pure and browser-safe: the client control imports it.

import type { DeckFilters, MediaType } from "../types";

/** Movies, series, or both. */
export const TYPE_CHOICES = ["all", "movie", "tv"] as const;
export type TypeChoice = (typeof TYPE_CHOICES)[number];

export const TYPE_LABELS: Record<TypeChoice, string> = { all: "All", movie: "Movies", tv: "Series" };

/**
 * A user-facing genre and the TMDB genre IDs behind it, per media type. TMDB
 * keeps separate genre lists for movies and series (fetched from
 * /genre/movie/list and /genre/tv/list), and some series genres merge two
 * movie genres: series "Sci-Fi & Fantasy" (10765) backs both Sci-Fi and
 * Fantasy here. An empty list means the genre does not exist for that type.
 */
export interface GenreGroup {
  key: string;
  label: string;
  movie: readonly number[];
  tv: readonly number[];
}

/**
 * The genres the control offers, alphabetical. Left out: TV Movie (a format,
 * not a genre), and the series-only News, Soap, and Talk.
 */
export const GENRE_GROUPS: readonly GenreGroup[] = [
  { key: "action", label: "Action & Adventure", movie: [28, 12], tv: [10759] },
  { key: "animation", label: "Animation", movie: [16], tv: [16] },
  { key: "comedy", label: "Comedy", movie: [35], tv: [35] },
  { key: "crime", label: "Crime", movie: [80], tv: [80] },
  { key: "documentary", label: "Documentary", movie: [99], tv: [99] },
  { key: "drama", label: "Drama", movie: [18], tv: [18] },
  { key: "family", label: "Family & Kids", movie: [10751], tv: [10751, 10762] },
  { key: "fantasy", label: "Fantasy", movie: [14], tv: [10765] },
  { key: "history", label: "History", movie: [36], tv: [] },
  { key: "horror", label: "Horror", movie: [27], tv: [] },
  { key: "music", label: "Music", movie: [10402], tv: [] },
  { key: "mystery", label: "Mystery", movie: [9648], tv: [9648] },
  { key: "reality", label: "Reality", movie: [], tv: [10764] },
  { key: "romance", label: "Romance", movie: [10749], tv: [] },
  { key: "scifi", label: "Sci-Fi", movie: [878], tv: [10765] },
  { key: "thriller", label: "Thriller", movie: [53], tv: [] },
  { key: "war", label: "War", movie: [10752], tv: [10768] },
  { key: "western", label: "Western", movie: [37], tv: [37] },
];

const GENRES_BY_KEY: ReadonlyMap<string, GenreGroup> = new Map(GENRE_GROUPS.map((g) => [g.key, g]));

/** Era presets. Each resolves to year bounds against the current year, so a saved "recent" stays recent. */
export const ERA_CHOICES = ["any", "recent", "last10", "y1990_2009", "before1990"] as const;
export type EraChoice = (typeof ERA_CHOICES)[number];

export const ERA_LABELS: Record<EraChoice, string> = {
  any: "Any year",
  recent: "Recent",
  last10: "Last 10 years",
  y1990_2009: "1990–2009",
  before1990: "Before 1990",
};

/** The control's state. Plain JSON, so it crosses the server action boundary and the URL as is. */
export interface FilterChoice {
  type: TypeChoice;
  /** GenreGroup keys. A title in any of them matches (the engine's any-of rule). */
  genres: string[];
  era: EraChoice;
  onMyServices: boolean;
}

/** No filter. Treat as read-only: normalizeFilterChoice returns fresh copies. */
export const DEFAULT_FILTER_CHOICE: Readonly<FilterChoice> = { type: "all", genres: [], era: "any", onMyServices: false };

function mediaTypesOf(type: TypeChoice): MediaType[] {
  return type === "all" ? ["movie", "tv"] : [type];
}

/** The genres that exist for this type choice, in display order. */
export function genresFor(type: TypeChoice): GenreGroup[] {
  const types = mediaTypesOf(type);
  return GENRE_GROUPS.filter((g) => types.some((t) => g[t].length > 0));
}

/**
 * The year bounds of an era preset, against the current UTC year. "Recent" is
 * this year and last. "Last 10 years" counts this year as one of the ten.
 */
export function eraBounds(era: EraChoice, now: Date): { fromYear: number | null; toYear: number | null } | null {
  const year = now.getUTCFullYear();
  switch (era) {
    case "any":
      return null;
    case "recent":
      return { fromYear: year - 1, toYear: null };
    case "last10":
      return { fromYear: year - 9, toYear: null };
    case "y1990_2009":
      return { fromYear: 1990, toYear: 2009 };
    case "before1990":
      return { fromYear: null, toYear: 1989 };
  }
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

/**
 * A clean choice from untrusted input (a server action argument, a parsed
 * URL). Lenient: an unknown type or era falls back to the default, and an
 * unknown genre, a duplicate, or a genre that does not exist for the chosen
 * type is dropped. Genres come back in display order, so equal choices
 * compare equal.
 */
export function normalizeFilterChoice(input: unknown): FilterChoice {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ...DEFAULT_FILTER_CHOICE, genres: [] };
  const raw = input as Record<string, unknown>;
  const type = isOneOf(TYPE_CHOICES, raw.type) ? raw.type : DEFAULT_FILTER_CHOICE.type;
  const wanted = new Set(Array.isArray(raw.genres) ? raw.genres : []);
  const genres = genresFor(type)
    .filter((g) => wanted.has(g.key))
    .map((g) => g.key);
  const era = isOneOf(ERA_CHOICES, raw.era) ? raw.era : DEFAULT_FILTER_CHOICE.era;
  return { type, genres, era, onMyServices: raw.onMyServices === true };
}

/**
 * The engine's filters for a choice. Each chosen genre contributes its TMDB IDs
 * for the chosen types only, so a series filter never carries movie IDs.
 * `now` sets the current year for era presets (no clock in core).
 */
export function toDeckFilters(choice: FilterChoice, now: Date): DeckFilters {
  const clean = normalizeFilterChoice(choice);
  const filters: DeckFilters = {};
  const types = mediaTypesOf(clean.type);
  if (clean.type !== "all") filters.mediaTypes = types;
  const ids = new Set<number>();
  for (const key of clean.genres) {
    const group = GENRES_BY_KEY.get(key);
    if (group) for (const t of types) for (const id of group[t]) ids.add(id);
  }
  if (ids.size > 0) filters.genreIds = [...ids].sort((a, b) => a - b);
  const era = eraBounds(clean.era, now);
  if (era) filters.era = era;
  if (clean.onMyServices) filters.onMyServices = true;
  return filters;
}

/** True when the choice filters nothing. */
export function isDefaultFilterChoice(choice: FilterChoice): boolean {
  const c = normalizeFilterChoice(choice);
  return c.type === "all" && c.genres.length === 0 && c.era === "any" && !c.onMyServices;
}

/** Short labels for what the choice filters, in control order: type, genres, era, services. Empty for no filter. */
export function describeFilterChoice(choice: FilterChoice): string[] {
  const c = normalizeFilterChoice(choice);
  const parts: string[] = [];
  if (c.type !== "all") parts.push(TYPE_LABELS[c.type]);
  for (const key of c.genres) parts.push(GENRES_BY_KEY.get(key)!.label);
  if (c.era !== "any") parts.push(ERA_LABELS[c.era]);
  if (c.onMyServices) parts.push("My services");
  return parts;
}

/** The query parameter names. Short, since they show in the address bar. */
const PARAM = { type: "type", genres: "genre", era: "era", onMyServices: "mine" } as const;

/** The query parameters for a choice, defaults left out. Genres join with commas. */
export function filterChoiceToParams(choice: FilterChoice): Record<string, string> {
  const c = normalizeFilterChoice(choice);
  const out: Record<string, string> = {};
  if (c.type !== "all") out[PARAM.type] = c.type;
  if (c.genres.length) out[PARAM.genres] = c.genres.join(",");
  if (c.era !== "any") out[PARAM.era] = c.era;
  if (c.onMyServices) out[PARAM.onMyServices] = "1";
  return out;
}

/** A query value as Next's searchParams or URLSearchParams give it. */
type ParamValue = string | string[] | null | undefined;

const first = (v: ParamValue): string | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined));

/**
 * A choice from query parameters. Accepts a Next.js searchParams object or a
 * URLSearchParams. Anything unknown falls back to the default (normalizeFilterChoice).
 */
export function filterChoiceFromParams(params: URLSearchParams | Record<string, ParamValue>): FilterChoice {
  const get = (name: string): string | undefined =>
    params instanceof URLSearchParams ? (params.get(name) ?? undefined) : first(params[name]);
  return normalizeFilterChoice({
    type: get(PARAM.type),
    genres: (get(PARAM.genres) ?? "").split(",").filter(Boolean),
    era: get(PARAM.era),
    onMyServices: get(PARAM.onMyServices) === "1",
  });
}

/** The names filterChoiceToParams may write, so a caller can clear them before writing new ones. */
export const FILTER_PARAM_NAMES: readonly string[] = Object.values(PARAM);
