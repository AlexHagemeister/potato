// Builds a card from TMDB details. getDeck and getCard both build cards here,
// so a card opened from Search shows exactly what the deck shows.

import { logoUrl } from "../tmdb/images";
import type { CountryProviders, TitleDetails, WatchProvider } from "../tmdb/types";
import type { ImdbRating } from "../types";
import { JUSTWATCH_ATTRIBUTION } from "./constants";
import type { Card, CardImdb, CardProvider, CardStreaming, CardUserState, StreamingOffer } from "./types";

/** TMDB's offer lists, in the order a card names them, with the card's word for each. */
const OFFER_KINDS: readonly [keyof Omit<CountryProviders, "link">, StreamingOffer][] = [
  ["flatrate", "subscription"],
  ["free", "free"],
  ["ads", "ads"],
  ["rent", "rent"],
  ["buy", "buy"],
];

const STREAMING_OFFERS: ReadonlySet<StreamingOffer> = new Set(["subscription", "free", "ads"]);

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

/** Streaming info for one country, with the user's services flagged. */
export function streamingFor(
  details: Pick<TitleDetails, "providersByCountry">,
  country: string,
  userProviderIds: readonly number[],
): CardStreaming {
  const listing = details.providersByCountry[country];
  const mine = new Set(userProviderIds);
  const byId = new Map<number, { provider: WatchProvider; offers: StreamingOffer[] }>();
  for (const [kind, offer] of OFFER_KINDS) {
    for (const p of listing?.[kind] ?? []) {
      const entry = byId.get(p.id);
      if (!entry) byId.set(p.id, { provider: p, offers: [offer] });
      else if (!entry.offers.includes(offer)) {
        entry.offers.push(offer);
        if (p.displayPriority < entry.provider.displayPriority) entry.provider = p;
      }
    }
  }
  const group = (p: CardProvider) => (p.streams ? (p.isMine ? 0 : 1) : 2);
  const priority = new Map([...byId.values()].map(({ provider }) => [provider.id, provider.displayPriority]));
  const providers = [...byId.values()]
    .map(({ provider, offers }): CardProvider => ({
      id: provider.id,
      name: provider.name,
      logoUrl: logoUrl(provider.logoPath),
      offers,
      streams: offers.some((o) => STREAMING_OFFERS.has(o)),
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
