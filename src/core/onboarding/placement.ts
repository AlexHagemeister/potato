// Where an onboarding hint's label goes (issue 139), from measurements alone: no browser code, so it has tests.
// The label must never cover the card's title or its IMDb rating (VISION invariant 5), the deck's controls, its
// Undo toast or error notice, or the four buttons. It prefers the spot just above the buttons, where it can point at
// one. Otherwise it takes the highest clear spot over the poster, and if there is none it hides until the next
// scroll or resize, leaving the ring on the button.

/** A rectangle on screen, in CSS pixels from the viewport's top left. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type LabelSpot =
  /** Just above the buttons, with a pointer to the button. */
  | { kind: "above_row" }
  /** Over the poster, its top this far from the viewport's top. */
  | { kind: "at"; top: number }
  /** No clear spot: only the ring shows. */
  | { kind: "hidden" };

export interface SpotInput {
  /** The top of the four-button row. */
  rowTop: number;
  /** The highest the label's top may go (below the top safe area). */
  minTop: number;
  /** The label's height. */
  height: number;
  /** The label's left and right edges. */
  left: number;
  right: number;
  /** What the label must stay clear of. */
  keepClear: readonly Box[];
  /** Where the label is now, so it stays put while that spot is still clear. */
  current: LabelSpot | null;
}

/** The clear space kept between the label and anything it must not cover. */
export const SPOT_GAP = 6;
/** The above-row label's pointer reaches this far into the row's top padding. */
export const POINTER_OVERLAP = 2;
const STEP = 4;

/** The label's top in the above-row spot. */
export function aboveRowTop(input: Pick<SpotInput, "rowTop" | "height">): number {
  return input.rowTop - input.height + POINTER_OVERLAP;
}

function clearAt(top: number, input: SpotInput): boolean {
  const bottom = top + input.height;
  return input.keepClear.every(
    (r) =>
      r.right <= input.left ||
      r.left >= input.right ||
      r.bottom <= top - SPOT_GAP ||
      r.top >= bottom + SPOT_GAP,
  );
}

/** The highest top an over-the-poster label may have and still sit clear above the buttons. */
function lowestAtTop(input: SpotInput): number {
  return input.rowTop - SPOT_GAP - input.height;
}

export function chooseLabelSpot(input: SpotInput): LabelSpot {
  const above = aboveRowTop(input);
  if (above >= input.minTop && clearAt(above, input)) return { kind: "above_row" };
  const lowest = lowestAtTop(input);
  const current = input.current;
  if (current?.kind === "at" && current.top >= input.minTop && current.top <= lowest && clearAt(current.top, input)) {
    return current;
  }
  for (let top = input.minTop; top <= lowest; top += STEP) {
    if (clearAt(top, input)) return { kind: "at", top: Math.round(top) };
  }
  return { kind: "hidden" };
}

/** True when the label at `spot` covers none of `keepClear`. For tests and the walk's checks. */
export function spotIsClear(spot: LabelSpot, input: SpotInput): boolean {
  if (spot.kind === "hidden") return true;
  return clearAt(spot.kind === "above_row" ? aboveRowTop(input) : spot.top, input);
}
