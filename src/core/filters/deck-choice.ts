// What the Discover controls hold: the discovery mode and the filter choice.
// The mode decides the order titles come in, the filters which titles can
// appear (VISION "Shaping the deck"). Pure and browser-safe, like choice.ts:
// the Discover screen, the deck API route, and a future AI connection read
// one choice the same way (CLAUDE.md rule 3).

import { DISCOVERY_MODES, type DiscoveryMode } from "../types";
import { DEFAULT_FILTER_CHOICE, filterChoiceFromParams, filterChoiceToParams, normalizeFilterChoice, type FilterChoice } from "./choice";

export const MODE_LABELS: Record<DiscoveryMode, string> = {
  blend: "Blend",
  popular: "Popular",
  deep_cuts: "Deep cuts",
  top_rated: "Top rated",
  for_you: "For you",
};

/** One line under each mode in the picker. */
export const MODE_NOTES: Record<DiscoveryMode, string> = {
  blend: "A mix of all of these",
  popular: "What people are watching now",
  deep_cuts: "Good titles fewer people know",
  top_rated: "The highest rated of all time",
  for_you: "Based on your own ratings",
};

/** The default mode (VISION: the default is a blend). */
export const DEFAULT_MODE: DiscoveryMode = "blend";

export interface DeckChoice {
  mode: DiscoveryMode;
  filters: FilterChoice;
}

export const DEFAULT_DECK_CHOICE: Readonly<DeckChoice> = { mode: DEFAULT_MODE, filters: DEFAULT_FILTER_CHOICE };

/** The query parameter for the mode. The filters use choice.ts's names. */
const MODE_PARAM = "mode";

export function isDiscoveryMode(value: unknown): value is DiscoveryMode {
  return typeof value === "string" && (DISCOVERY_MODES as readonly string[]).includes(value);
}

/** A clean choice from anything (saved state, say). Unknown values fall back to the default. */
export function normalizeDeckChoice(input: unknown): DeckChoice {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    mode: isDiscoveryMode(raw.mode) ? raw.mode : DEFAULT_MODE,
    filters: normalizeFilterChoice(raw.filters),
  };
}

/** Query parameters for the choice. Defaults are left out. */
export function deckChoiceToParams(choice: DeckChoice): Record<string, string> {
  const c = normalizeDeckChoice(choice);
  return { ...(c.mode === DEFAULT_MODE ? {} : { [MODE_PARAM]: c.mode }), ...filterChoiceToParams(c.filters) };
}

/**
 * The filter choice from query parameters, and the mode exactly as given
 * (null when absent). The mode stays raw so the deck service can refuse an
 * unknown one instead of silently dealing the blend.
 */
export function deckChoiceFromParams(params: URLSearchParams): { mode: string | null; filters: FilterChoice } {
  return { mode: params.get(MODE_PARAM) || null, filters: filterChoiceFromParams(params) };
}

/** One comparable string per choice: equal choices give equal keys, whatever order the genres were tapped in. */
export function deckChoiceKey(choice: DeckChoice): string {
  return new URLSearchParams(Object.entries(deckChoiceToParams(choice)).sort(([a], [b]) => a.localeCompare(b))).toString();
}
