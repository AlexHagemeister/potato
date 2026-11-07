"use client";

import { useState } from "react";

/**
 * The trailer, inside the card. It shows YouTube's thumbnail until tapped,
 * so a card never loads a video player it doesn't play. Tapped, it loads
 * YouTube's privacy-enhanced player inline (playsinline keeps iOS from
 * jumping straight to fullscreen). The player's own button goes fullscreen.
 */
export function Trailer({ youTubeKey, title }: { youTubeKey: string; title: string }) {
  const [playing, setPlaying] = useState(false);
  const key = encodeURIComponent(youTubeKey);

  return (
    <div className="relative aspect-video overflow-hidden rounded-2xl bg-surface">
      {playing ? (
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${key}?autoplay=1&playsinline=1&rel=0&modestbranding=1`}
          title={`${title} trailer`}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 size-full border-0"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`Play the ${title} trailer`}
          className="absolute inset-0 block size-full"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- YouTube's fixed-size thumbnail */}
          <img
            src={`https://i.ytimg.com/vi/${key}/hqdefault.jpg`}
            alt=""
            loading="lazy"
            className="size-full object-cover opacity-80"
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-black/60 backdrop-blur">
              <svg viewBox="0 0 24 24" className="ml-1 size-8 text-white" aria-hidden>
                <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
              </svg>
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
