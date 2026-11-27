import { ChoiceIcon, choiceTone } from "./choice-icon";
import { CHOICES, EXAMPLE_CARD } from "./copy";

/**
 * A drawn poster: a dusk sky, a low sun, and two ridges over water. Pure SVG,
 * so the page ships no poster image and needs no network call. Nothing here is
 * anyone's artwork.
 */
export function DrawnPoster({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 300" preserveAspectRatio="xMidYMid slice" aria-hidden className={className}>
      <defs>
        <linearGradient id="landing-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#14163a" />
          <stop offset="0.45" stopColor="#4b2a6b" />
          <stop offset="0.78" stopColor="#c8566a" />
          <stop offset="1" stopColor="#f3a25a" />
        </linearGradient>
        <radialGradient id="landing-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f5c451" stopOpacity="0.55" />
          <stop offset="1" stopColor="#f5c451" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="landing-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2a1838" />
          <stop offset="1" stopColor="#0b0b0c" />
        </linearGradient>
      </defs>
      <rect width="200" height="300" fill="url(#landing-sky)" />
      <g fill="#fff">
        <circle cx="28" cy="34" r="1" opacity="0.8" />
        <circle cx="62" cy="18" r="0.8" opacity="0.6" />
        <circle cx="150" cy="40" r="1.1" opacity="0.7" />
        <circle cx="176" cy="22" r="0.7" opacity="0.5" />
        <circle cx="112" cy="58" r="0.8" opacity="0.5" />
        <circle cx="40" cy="80" r="0.7" opacity="0.4" />
        <circle cx="168" cy="92" r="0.8" opacity="0.4" />
      </g>
      <circle cx="100" cy="184" r="72" fill="url(#landing-glow)" />
      <circle cx="100" cy="184" r="30" fill="#f5c451" />
      <path d="M0 192 L30 170 L58 186 L84 200 L116 200 L146 178 L174 190 L200 176 L200 214 L0 214 Z" fill="#3a1f4f" />
      <path d="M0 212 L34 200 L76 210 L124 204 L164 212 L200 202 L200 222 L0 222 Z" fill="#24142f" />
      <rect y="220" width="200" height="80" fill="url(#landing-sea)" />
      <g fill="#f5c451">
        <rect x="80" y="228" width="40" height="2" rx="1" opacity="0.55" />
        <rect x="88" y="238" width="24" height="2" rx="1" opacity="0.4" />
        <rect x="94" y="248" width="12" height="2" rx="1" opacity="0.25" />
      </g>
      <text
        x="100"
        y="282"
        textAnchor="middle"
        fill="#ededed"
        fontSize="13"
        fontWeight="700"
        letterSpacing="4"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      >
        {EXAMPLE_CARD.title.toUpperCase()}
      </text>
    </svg>
  );
}

/**
 * A card as the deck shows it, in miniature, with two more cards stacked
 * behind it. The classes follow the deck's card (src/app/(app)/_deck/card-view.tsx)
 * and buttons (deck-buttons.tsx). Static and not interactive: the buttons
 * here are pictures of buttons, so sign-in stays the page's only control.
 */
export function ExampleCard() {
  const card = EXAMPLE_CARD;
  return (
    <figure aria-label="An example card" className="relative mx-auto w-[min(14rem,64vw)] md:w-[17rem]">
      {/* The deck behind the card. */}
      <div aria-hidden className="absolute inset-0 translate-x-3 translate-y-2 rotate-[5deg] rounded-[1.75rem] bg-surface-raised/60 ring-1 ring-hairline" />
      <div aria-hidden className="absolute inset-0 -translate-x-2 translate-y-1 -rotate-[3deg] rounded-[1.75rem] bg-surface-raised ring-1 ring-hairline" />

      <div className="relative rounded-[1.75rem] bg-surface p-2.5 shadow-2xl shadow-black/60 ring-1 ring-hairline">
        <div className="relative overflow-hidden rounded-2xl">
          <DrawnPoster className="block aspect-[2/3] w-full" />
          <span className="absolute top-2.5 left-2.5 rounded-full bg-black/55 px-2.5 py-1 text-[0.6875rem] font-semibold tracking-wide text-foreground uppercase backdrop-blur-sm">
            {card.badge}
          </span>
        </div>

        <div className="px-1.5 pt-3.5 pb-1">
          <p className="text-lg leading-tight font-bold tracking-tight">{card.title}</p>
          <p className="mt-0.5 text-sm text-muted">{card.meta}</p>
          <p className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
            {card.genres.map((g) => (
              <span key={g} className="rounded-full bg-surface-raised px-2.5 py-1">
                {g}
              </span>
            ))}
            <span className="px-1 text-muted">{card.length}</span>
          </p>
          {/* Where the real card shows the IMDb rating, styled like it
              (_deck/card-view.tsx ImdbRating), but a plain star: the score is invented. */}
          <p className="mt-3 flex items-center gap-2.5" aria-label={`Example rating ${card.rating}`}>
            <span aria-hidden className="rounded-md bg-accent px-1.5 py-0.5 text-sm leading-none font-black text-black">
              ★
            </span>
            <span aria-hidden className="text-2xl leading-none font-bold tabular-nums">
              {card.rating}
            </span>
          </p>
          <p className="mt-3 text-[0.8125rem] leading-snug text-foreground/80">{card.synopsis}</p>
        </div>

        <div aria-hidden className="mt-2 grid grid-cols-4 gap-1.5">
          {CHOICES.map((c) => (
            <span
              key={c.kind}
              className={`flex h-10 items-center justify-center rounded-xl bg-surface-raised ${choiceTone(c.kind)}`}
            >
              <ChoiceIcon kind={c.kind} size={18} />
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}
