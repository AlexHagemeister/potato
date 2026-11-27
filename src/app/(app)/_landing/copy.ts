// The landing page's words, in one place so the page, the link preview image
// (src/app/opengraph-image.tsx), and the tests read the same text. Taken from VISION.md's own sentences where
// they fit ("What Potato is", "The deck", "Your lists"). Plain and short: no
// pricing, no sign-up pitch.

export const TAGLINE = "Decide what to watch, one card at a time.";

export const LEAD = "Potato shows you a movie or series as a card. Make a quick call, and the next card appears.";

export type ChoiceKind = "pass" | "skip" | "watchlist" | "seen";

/** The four card buttons, in the deck's order, with a few words on each. */
export const CHOICES: readonly { kind: ChoiceKind; label: string; words: string }[] = [
  { kind: "pass", label: "Pass", words: "You don't want to watch it." },
  { kind: "skip", label: "Skip", words: "Not ready to decide. It comes back later." },
  { kind: "watchlist", label: "Watchlist", words: "You want to watch it." },
  { kind: "seen", label: "Seen it", words: "You've watched it. Rate it, and review it if you like." },
];

export const CHOICES_HEADING = "One tap per card";

export const BUILDS_HEADING = "What builds up";

/** What the calls build over time (VISION "What Potato is", "Your lists"). */
export const BUILDS: readonly { label: string; words: string }[] = [
  { label: "Watchlist", words: "Everything you want to watch." },
  { label: "Seen", words: "What you've watched, with your ratings and reviews." },
  { label: "Passed", words: "What you said no to, in case you change your mind." },
];

export const BUILDS_FOOTNOTE = "Every choice can be undone, and your lists follow you across devices.";

/**
 * The example card. Made up on purpose: a drawn poster and an invented title,
 * so nothing on it comes from TMDB or IMDb. Its synopsis says what a real card
 * adds, instead of showing a rating that no one gave.
 */
export const EXAMPLE_CARD = {
  badge: "Example",
  title: "Saltlight",
  meta: "2024 · Series",
  genres: ["Sci-fi", "Drama"],
  length: "2 seasons",
  synopsis: "Real cards show the IMDb rating, where it's streaming in your country, and the trailer.",
} as const;
