// Shapes the deck service hands to the UI, the API, and a future MCP. A title
// is always the pair (media type, TMDB ID) (CLAUDE.md architecture rule 1).

import type { Genre } from "../tmdb/types";
import type { DeckFilters, DiscoveryMode, MediaType, PoolName, TitleId, TitleStatus } from "../types";
import type { JUSTWATCH_ATTRIBUTION } from "./constants";

/**
 * The IMDb rating on a card (VISION invariant 5). Three states, so the UI
 * never shows "no rating" when the lookup only failed:
 * - rated: IMDb's dataset has a rating for the title.
 * - none: TMDB maps the title to no IMDb ID (imdbId null), or IMDb's dataset
 *   has no rating for that ID. This is the only state that means "no rating".
 * - unavailable: the ratings lookup failed, or the ratings dataset has not
 *   been loaded yet (an empty table). Show nothing, not "no rating".
 */
export type CardImdb =
  | { kind: "rated"; imdbId: string; rating: number; votes: number }
  | { kind: "none"; imdbId: string | null }
  | { kind: "unavailable"; imdbId: string | null };

/** How a service offers a title. "subscription" is TMDB's "flatrate". */
export type StreamingOffer = "subscription" | "free" | "ads" | "rent" | "buy";

export interface CardProvider {
  /** TMDB watch provider ID, the same IDs the user's settings hold. */
  id: number;
  name: string;
  logoUrl: string | null;
  /** Every way this service offers the title, in the order above. */
  offers: StreamingOffer[];
  /** Streams it by subscription, free, or with ads (not rent or buy only). */
  streams: boolean;
  /** One of the user's own services. */
  isMine: boolean;
}

/**
 * Where to watch a title in the user's country. Data from JustWatch, via TMDB.
 * Two states, so the UI never says "not streaming" when the lookup only
 * failed (issue 30):
 * - known: TMDB answered. `providers` is empty when the title streams nowhere
 *   in the country. This is the only state that means "not streaming".
 * - unknown: the providers lookup failed and nothing was cached. Say that
 *   availability is unknown, not that it streams nowhere.
 */
export type CardStreaming = KnownStreaming | UnknownStreaming;

interface StreamingBase {
  /** The user's country (ISO 3166-1 alpha-2), from their settings. */
  country: string;
  /** Must be shown next to this streaming info, in either state (CLAUDE.md architecture rule 7). */
  attribution: typeof JUSTWATCH_ATTRIBUTION;
}

export interface KnownStreaming extends StreamingBase {
  kind: "known";
  /**
   * One entry per service. Order: the user's services that stream it, then
   * other services that stream it, then rent or buy only. Within each group,
   * TMDB's display order. Empty when TMDB lists nothing for the country.
   */
  providers: CardProvider[];
  /** True when at least one of the user's services streams the title. */
  onMyServices: boolean;
  /** TMDB's watch page for the title in this country, or null. */
  link: string | null;
}

export interface UnknownStreaming extends StreamingBase {
  kind: "unknown";
}

/** The user's current row for the title, or null on the card when there is none. */
export interface CardUserState {
  status: TitleStatus;
  /** Set when status is "seen". */
  rating: number | null;
  review: string | null;
  /** Set when status is "skipped": when the title returns to the deck. */
  skipUntil: Date | null;
}

/** Everything a card shows (VISION: The deck), in the order it shows it. */
export interface Card extends TitleId {
  posterUrl: string | null;
  title: string;
  /** Release year (movie) or first air year (series). */
  year: number | null;
  genres: Genre[];
  /** Movies only. Null when TMDB has none. */
  runtimeMinutes: number | null;
  /** Series only. Null when TMDB has none. */
  numberOfSeasons: number | null;
  imdb: CardImdb;
  synopsis: string;
  streaming: CardStreaming;
  /** YouTube video key of the best trailer, or null. */
  trailerYouTubeKey: string | null;
  userState: CardUserState | null;
}

/** A card dealt by the deck, tagged with the pool it came from. */
export type DeckPageCard = Card & { source: PoolName };

export interface DeckRequest {
  /** Defaults to "blend". */
  mode?: DiscoveryMode;
  filters?: DeckFilters;
  /**
   * The `nextCursor` of the previous page, with the same mode and filters.
   * Omit for the first page. A cursor is bound to the user, their country,
   * and their services: after a settings change it is rejected, so start again
   * without one.
   */
  cursor?: string | null;
}

/**
 * One page of the deck.
 *
 * `cards` can be short, or even empty, while `nextCursor` is non-null: the
 * engine drops titles after the service has paid to look them up (top rated
 * and deep cuts gate on IMDb votes, "on my services" on availability). Keep
 * calling with `nextCursor` until enough cards are queued or it is null.
 * Every call moves the cursor forward. A title can come back on a later page
 * from another pool, so drop cards whose (mediaType, tmdbId) is already queued.
 *
 * "locked": "for you" needs more ratings first.
 * "no_seeds": "for you" is unlocked, but the user has rated no title of the
 * filtered media types, so there is nothing to recommend from. This is not an
 * empty, finished deck: rating a title of that type, or widening the filter,
 * fills it.
 */
export type DeckPage =
  | { kind: "cards"; cards: DeckPageCard[]; nextCursor: string | null }
  | { kind: "locked"; mode: "for_you"; ratedCount: number; required: number; remaining: number }
  | { kind: "no_seeds"; mode: "for_you"; mediaTypes: MediaType[] };

/** Counts from one getDeck call, for the smoke test and tuning. */
export interface DeckStats {
  /** Discover and recommendations calls (cache hits included). */
  listLookups: number;
  /** Details calls (cache hits included). */
  detailLookups: number;
  /** Per pool: titles taken from TMDB lists, titles with details, and cards the engine dealt. */
  pools: Partial<Record<PoolName, { taken: number; enriched: number; dealt: number }>>;
}
