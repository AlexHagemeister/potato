"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { SimilarTitle } from "@/core/similar/types";
import { formatTitleKey } from "@/core/title-id";
import type { TitleId } from "@/core/types";
import type { SimilarResponse } from "@/app/api/similar/route";
import { Poster } from "../../../_components/poster";

// "You might also like" under a title's card: titles core ranks from TMDB's
// recommendations and the user's own lists (core/similar). It loads after the
// card is up, so it never slows the card, and it shows nothing while loading,
// when there is nothing to suggest, or when the lookup fails: it is a bonus,
// never in the way. Each title opens its own card, with the four buttons.

const POSTER_WIDTH = 112;

/** "Because you liked Arrival", or "Because you liked Arrival and Dune". */
function reason(because: readonly string[]): string | null {
  if (because.length === 0) return null;
  return `Because you liked ${because.slice(0, 2).join(" and ")}`;
}

async function fetchSimilar(ref: TitleId, signal: AbortSignal): Promise<SimilarTitle[]> {
  try {
    const res = await fetch(`/api/similar?${new URLSearchParams({ title: formatTitleKey(ref) })}`, { cache: "no-store", signal });
    const body = (await res.json()) as SimilarResponse;
    return body.ok ? body.titles : [];
  } catch {
    return [];
  }
}

export function SimilarRow({ mediaType, tmdbId }: TitleId) {
  // The titles, with the title they were fetched for, so a row never shows another card's suggestions.
  const [loaded, setLoaded] = useState<{ key: string; titles: SimilarTitle[] } | null>(null);
  const key = formatTitleKey({ mediaType, tmdbId });

  useEffect(() => {
    const controller = new AbortController();
    void fetchSimilar({ mediaType, tmdbId }, controller.signal).then((titles) => {
      if (!controller.signal.aborted) setLoaded({ key: formatTitleKey({ mediaType, tmdbId }), titles });
    });
    return () => controller.abort();
  }, [mediaType, tmdbId]);

  if (!loaded || loaded.key !== key || loaded.titles.length === 0) return null;
  return (
    <section data-slot="similar" aria-labelledby="similar-heading" className="mt-8">
      <h2 id="similar-heading" className="mb-3 text-lg font-semibold">
        You might also like
      </h2>
      <ul className="-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
        {loaded.titles.map((t) => {
          const why = reason(t.because);
          return (
            <li key={formatTitleKey(t)} className="shrink-0 snap-start" style={{ width: POSTER_WIDTH }}>
              <Link href={`/title/${t.mediaType}/${t.tmdbId}`} prefetch={false} data-title-key={formatTitleKey(t)} className="block">
                <Poster url={t.posterUrl} title={`${t.title} poster`} width={POSTER_WIDTH} />
                <span className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{t.title}</span>
                <span className="mt-0.5 block text-xs text-muted">
                  {[t.year, t.mediaType === "movie" ? "Movie" : "Series", t.imdbRating !== null ? `IMDb ${t.imdbRating.toFixed(1)}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {why && <span className="mt-1 line-clamp-2 text-xs leading-snug text-accent">{why}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
