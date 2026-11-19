"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { SimilarTitle } from "@/core/similar/types";
import { formatTitleKey } from "@/core/title-id";
import type { TitleId } from "@/core/types";
import type { SimilarResponse } from "@/app/api/similar/route";
import { Poster } from "../../../_components/poster";
import { getChangeVersion, getServerChangeVersion, subscribeTitleChanges, titlesChangedSince } from "../../../library-changes";

// "You might also like" under a title's card: titles core ranks from TMDB's
// recommendations and the user's own lists (core/similar). It loads after the
// card is up, so it never slows the card, and it shows nothing while loading,
// when there is nothing to suggest, or when the lookup fails: it is a bonus,
// never in the way. Each title opens its own card, with the four buttons.

const POSTER_WIDTH = 112;

/** A row as read, with the change version it was read at (library-changes). */
type Read = { key: string; version: number; titles: SimilarTitle[] };

/**
 * The rows read on this page, by title key, newest last. Back, or a reload that starts the screen over, shows the
 * row read last at once instead of blanking it while it reads again. A few are plenty: they serve Back.
 */
const reads = new Map<string, Read>();
const MAX_READS = 20;

function remember(read: Read) {
  reads.delete(read.key);
  reads.set(read.key, read);
  if (reads.size > MAX_READS) reads.delete(reads.keys().next().value as string);
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
  const key = formatTitleKey({ mediaType, tmdbId });
  // Moves each time a title card's write lands, here or on a screen opened from here: the row then reads again.
  const version = useSyncExternalStore(subscribeTitleChanges, getChangeVersion, getServerChangeVersion);
  // The row read last for this title, so a remount shows it while it reads again. Keyed by title, so a row never
  // shows another card's suggestions.
  const [loaded, setLoaded] = useState<Read | null>(() => reads.get(key) ?? null);

  useEffect(() => {
    const controller = new AbortController();
    const at = getChangeVersion();
    void fetchSimilar({ mediaType, tmdbId }, controller.signal).then((titles) => {
      if (controller.signal.aborted) return;
      const read = { key: formatTitleKey({ mediaType, tmdbId }), version: at, titles };
      remember(read);
      setLoaded(read);
    });
    return () => controller.abort();
  }, [mediaType, tmdbId, version]);

  const fromHere = loaded?.key === key ? loaded : (reads.get(key) ?? null);
  if (!fromHere) return null;
  // Until the row has read again, leave out any title sorted since it read: it may now be on a list, and a title on
  // a list never shows here (VISION invariant 3). If the log can't say which, show nothing until the read lands.
  const changed = titlesChangedSince(fromHere.version);
  if (changed === null) return null;
  const titles = fromHere.titles.filter((t) => !changed.has(formatTitleKey(t)));
  if (titles.length === 0) return null;
  return (
    <section data-slot="similar" aria-labelledby="similar-heading" className="mt-8">
      <h2 id="similar-heading" className="mb-3 text-lg font-semibold">
        You might also like
      </h2>
      <ul className="-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
        {titles.map((t) => (
          <li key={formatTitleKey(t)} className="shrink-0 snap-start" style={{ width: POSTER_WIDTH }}>
            <Link href={`/title/${t.mediaType}/${t.tmdbId}`} prefetch={false} data-title-key={formatTitleKey(t)} className="block">
              <Poster url={t.posterUrl} title={`${t.title} poster`} width={POSTER_WIDTH} />
              <span className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{t.title}</span>
              <span className="mt-0.5 block text-xs text-muted">
                {[t.year, t.mediaType === "movie" ? "Movie" : "Series", t.imdbRating !== null ? `IMDb ${t.imdbRating.toFixed(1)}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {t.reason && <span className="mt-1 line-clamp-2 text-xs leading-snug text-accent">{t.reason}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
