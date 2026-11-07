/** A poster thumbnail at 2:3, with a quiet placeholder when there is no image. */
export function Poster({ url, title, width }: { url: string | null; title: string; width: number }) {
  const height = Math.round(width * 1.5);
  if (!url) {
    return (
      <span
        aria-hidden
        style={{ width, height }}
        className="flex shrink-0 items-center justify-center rounded-md bg-surface-raised text-muted"
      >
        <svg width={width / 2.5} height={width / 2.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 15 5-5 4 4 3-3 6 6" />
        </svg>
      </span>
    );
  }
  return (
    // TMDB serves fixed sizes already, so next/image adds nothing (and the Hobby plan caps optimization).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={title}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      style={{ width, height }}
      className="shrink-0 rounded-md bg-surface-raised object-cover"
    />
  );
}
