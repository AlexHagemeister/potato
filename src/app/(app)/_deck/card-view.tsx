"use client";

import type { Card, CardImdb, CardProvider, StreamingOffer } from "@/core/deck-service/types";
import { formatTitleKey } from "@/core/title-id";
import { Trailer } from "./trailer";

// One card, top to bottom in VISION's order: poster; title, year, and type;
// genres and runtime or seasons; the IMDb rating; the synopsis; where to
// stream it; the trailer. Presentation only: every field comes from core.

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function lengthLine(card: Card): string | null {
  if (card.mediaType === "movie") return card.runtimeMinutes ? formatRuntime(card.runtimeMinutes) : null;
  if (!card.numberOfSeasons) return null;
  return `${card.numberOfSeasons} ${card.numberOfSeasons === 1 ? "season" : "seasons"}`;
}

const OFFER_WORDS: Record<StreamingOffer, string> = {
  subscription: "Subscription",
  free: "Free",
  ads: "Free with ads",
  rent: "Rent",
  buy: "Buy",
};

/** The IMDb rating, large (VISION invariant 5). "Not loaded" is a neutral dash, never "no rating". */
function ImdbRating({ imdb }: { imdb: CardImdb }) {
  return (
    <div className="flex items-center gap-3" data-imdb={imdb.kind}>
      <span className="rounded-md bg-accent px-1.5 py-0.5 text-sm font-black tracking-tight text-black">IMDb</span>
      {imdb.kind === "rated" && (
        <p className="flex items-baseline gap-2">
          <span className="text-3xl font-bold tabular-nums">{imdb.rating.toFixed(1)}</span>
          <span className="text-sm text-muted">{compact.format(imdb.votes)} votes</span>
        </p>
      )}
      {imdb.kind === "none" && <p className="text-lg text-muted">No rating</p>}
      {imdb.kind === "unavailable" && (
        <p className="text-3xl font-bold text-muted" aria-label="IMDb rating not available right now">
          –
        </p>
      )}
    </div>
  );
}

function ProviderLogo({ provider }: { provider: CardProvider }) {
  return provider.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- TMDB serves logos at fixed sizes
    <img src={provider.logoUrl} alt="" width={40} height={40} loading="lazy" className="size-10 shrink-0 rounded-lg" />
  ) : (
    <span aria-hidden className="size-10 shrink-0 rounded-lg bg-surface-raised" />
  );
}

/**
 * Where to stream it in the user's country, the user's own services first and
 * marked. When availability is unknown (the lookup failed), it says so rather
 * than "not streaming" (issue 30).
 */
function Streaming({ streaming }: { streaming: Card["streaming"] }) {
  const providers = streaming.kind === "known" ? streaming.providers : [];
  const streams = providers.filter((p) => p.streams);
  const rentOrBuy = providers.filter((p) => !p.streams);
  const country = countryName(streaming.country);

  return (
    <section aria-labelledby="where-to-watch">
      <h3 id="where-to-watch" className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">
        Where to watch in {country}
      </h3>
      {streaming.kind === "unknown" && (
        <p className="text-muted" data-availability="unknown">
          Streaming info isn&apos;t available right now.
        </p>
      )}
      {streaming.kind === "known" && providers.length === 0 && (
        <p className="text-muted">Not streaming in {country} right now.</p>
      )}

      {streams.length > 0 && (
        <ul className="space-y-2">
          {streams.map((p) => (
            <li
              key={p.id}
              data-mine={p.isMine || undefined}
              className={`flex items-center gap-3 rounded-xl p-2 ${p.isMine ? "bg-accent/15 ring-1 ring-accent/60" : "bg-surface"}`}
            >
              <ProviderLogo provider={p} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block text-sm text-muted">{p.offers.map((o) => OFFER_WORDS[o]).join(" · ")}</span>
              </span>
              {p.isMine && <span className="shrink-0 pr-1 text-xs font-semibold text-accent">Your service</span>}
            </li>
          ))}
        </ul>
      )}

      {rentOrBuy.length > 0 && (
        <div className={streams.length > 0 ? "mt-4" : ""}>
          <p className="mb-2 text-sm text-muted">Rent or buy</p>
          <ul className="flex flex-wrap gap-2">
            {rentOrBuy.map((p) => (
              <li key={p.id} title={p.name}>
                <ProviderLogo provider={p} />
                <span className="sr-only">
                  {p.name}: {p.offers.map((o) => OFFER_WORDS[o]).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Required next to every display of streaming data (CLAUDE.md rule 7). */}
      <p className="mt-3 text-xs text-muted">
        <a href={streaming.attribution.url} target="_blank" rel="noopener noreferrer">
          {streaming.attribution.text}
        </a>
      </p>
    </section>
  );
}

export function CardView({ card }: { card: Card }) {
  const length = lengthLine(card);
  const type = card.mediaType === "movie" ? "Movie" : "Series";

  return (
    <article aria-label={card.title} data-title-key={formatTitleKey(card)} className="pb-4">
      {card.posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- TMDB serves posters at fixed sizes
        <img
          src={card.posterUrl}
          alt={`${card.title} poster`}
          width={500}
          height={750}
          decoding="async"
          className="mx-auto block aspect-[2/3] h-[min(52svh,calc((100vw-2rem)*1.5))] w-auto rounded-2xl bg-surface object-cover shadow-lg"
        />
      ) : (
        <div className="mx-auto flex aspect-[2/3] h-[min(52svh,calc((100vw-2rem)*1.5))] items-center justify-center rounded-2xl bg-surface p-6 text-center text-xl font-semibold text-muted">
          {card.title}
        </div>
      )}

      <header className="mt-5">
        <h2 className="text-2xl leading-tight font-bold tracking-tight">{card.title}</h2>
        <p className="mt-1 text-muted">{[card.year, type].filter(Boolean).join(" · ")}</p>
      </header>

      {(card.genres.length > 0 || length) && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
          {card.genres.map((g) => (
            <span key={g.id} className="rounded-full bg-surface px-2.5 py-1">
              {g.name}
            </span>
          ))}
          {length && <span className="px-1 text-muted">{length}</span>}
        </p>
      )}

      <div className="mt-4">
        <ImdbRating imdb={card.imdb} />
      </div>

      {card.synopsis && <p className="mt-4 leading-relaxed text-foreground/90">{card.synopsis}</p>}

      <div className="mt-6">
        <Streaming streaming={card.streaming} />
      </div>

      {card.trailerYouTubeKey && (
        <section aria-label="Trailer" className="mt-6">
          <h3 className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">Trailer</h3>
          <Trailer key={card.trailerYouTubeKey} youTubeKey={card.trailerYouTubeKey} title={card.title} />
        </section>
      )}
    </article>
  );
}
