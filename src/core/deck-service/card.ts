// Builds a card from TMDB details. getDeck and getCard both build cards here,
// so a card opened from Search shows exactly what the deck shows.

import { STREAMING_MONETIZATION } from "../tmdb/client";
import { logoUrl } from "../tmdb/images";
import type { CountryProviders, TitleDetails, WatchProvider } from "../tmdb/types";
import type { ImdbRating } from "../types";
import { JUSTWATCH_ATTRIBUTION } from "./constants";
import type { Card, CardImdb, CardProvider, CardStreaming, CardUserState, StreamingOffer } from "./types";

type OfferKind = keyof Omit<CountryProviders, "link">;

/** TMDB's offer lists, in the order a card names them, with the card's word for each. */
const OFFER_KINDS: readonly [OfferKind, StreamingOffer][] = [
  ["flatrate", "subscription"],
  ["free", "free"],
  ["ads", "ads"],
  ["rent", "rent"],
  ["buy", "buy"],
];

/** The kinds that count as streaming: the TMDB module's list, the same one the deck's "on my services" filter and discover use. */
const STREAMING_KINDS: ReadonlySet<OfferKind> = new Set(STREAMING_MONETIZATION);

/**
 * The card's IMDb state for a title. `ratings` is the lookup result, or
 * "unavailable" when the lookup failed.
 */
export function imdbState(imdbId: string | null, ratings: ReadonlyMap<string, ImdbRating> | "unavailable"): CardImdb {
  if (imdbId === null) return { kind: "none", imdbId: null };
  if (ratings === "unavailable") return { kind: "unavailable", imdbId };
  const r = ratings.get(imdbId);
  return r ? { kind: "rated", imdbId, rating: r.rating, votes: r.votes } : { kind: "none", imdbId };
}

/**
 * Streaming info for one country, with the user's services flagged. Unknown
 * when the details carry no providers (null), never an empty known list.
 */
export function streamingFor(
  details: Pick<TitleDetails, "providersByCountry">,
  country: string,
  userProviderIds: readonly number[],
): CardStreaming {
  if (details.providersByCountry === null) return { kind: "unknown", country, attribution: JUSTWATCH_ATTRIBUTION };
  const listing = details.providersByCountry[country];
  const mine = new Set(userProviderIds);
  const byId = new Map<number, { provider: WatchProvider; offers: StreamingOffer[]; streams: boolean }>();
  for (const [kind, offer] of OFFER_KINDS) {
    const streams = STREAMING_KINDS.has(kind);
    for (const p of listing?.[kind] ?? []) {
      const entry = byId.get(p.id);
      if (!entry) byId.set(p.id, { provider: p, offers: [offer], streams });
      else if (!entry.offers.includes(offer)) {
        entry.offers.push(offer);
        entry.streams ||= streams;
        if (p.displayPriority < entry.provider.displayPriority) entry.provider = p;
      }
    }
  }
  const group = (p: CardProvider) => (p.streams ? (p.isMine ? 0 : 1) : 2);
  const priority = new Map([...byId.values()].map(({ provider }) => [provider.id, provider.displayPriority]));
  const providers = [...byId.values()]
    .map(({ provider, offers, streams }): CardProvider => ({
      id: provider.id,
      name: provider.name,
      logoUrl: logoUrl(provider.logoPath),
      offers,
      streams,
      isMine: mine.has(provider.id),
    }))
    .sort(
      (a, b) =>
        group(a) - group(b) ||
        priority.get(a.id)! - priority.get(b.id)! ||
        a.name.localeCompare(b.name) ||
        a.id - b.id,
    );
  return {
    kind: "known",
    country,
    providers,
    onMyServices: providers.some((p) => p.streams && p.isMine),
    link: listing?.link ?? null,
    attribution: JUSTWATCH_ATTRIBUTION,
  };
}

export interface CardInput {
  details: TitleDetails;
  imdb: CardImdb;
  country: string;
  userProviderIds: readonly number[];
  userState: CardUserState | null;
}

export function buildCard({ details, imdb, country, userProviderIds, userState }: CardInput): Card {
  return {
    mediaType: details.mediaType,
    tmdbId: details.tmdbId,
    posterUrl: details.posterUrl,
    title: details.title,
    year: details.year,
    genres: details.genres.map((g) => ({ ...g })),
    runtimeMinutes: details.mediaType === "movie" ? details.runtimeMinutes : null,
    numberOfSeasons: details.mediaType === "tv" ? details.numberOfSeasons : null,
    imdb,
    synopsis: details.overview,
    streaming: streamingFor(details, country, userProviderIds),
    trailerYouTubeKey: details.trailerYouTubeKey,
    userState,
  };
}
