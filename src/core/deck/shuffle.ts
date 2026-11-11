// The deck's shuffle. A deck is dealt in a fresh order each time (so the same
// mode and filters do not give the same run of cards each time), yet the engine
// stays a pure function: the randomness is a seed the caller passes in, and
// everything here is computed from it. The same seed gives the same order.
//
// No node:crypto: the deck engine is also bundled for the browser.

/** A shuffle seed: 1 to 32 URL-safe characters. A new deck takes its caller's seed or one the deck service makes, and the cursor carries it. */
export const SHUFFLE_SEED = /^[A-Za-z0-9_-]{1,32}$/;

export function isShuffleSeed(value: unknown): value is string {
  return typeof value === "string" && SHUFFLE_SEED.test(value);
}

/** cyrb53: a small, well-mixed 53-bit string hash. Not cryptographic, which a shuffle does not need. */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A number strictly between 0 and 1 for this seed and key, the same every
 * time. Different seeds give unrelated numbers for the same key.
 */
export function seededUnit(seed: string, key: string): number {
  // The separator keeps ("ab", "c") and ("a", "bc") apart. A seed never holds one (SHUFFLE_SEED).
  // The hash's top 52 bits plus a half: a double holds every such value exactly, so the result is never 0 or 1.
  return (Math.floor(hash53(`${seed}|${key}`) / 2) + 0.5) / 2 ** 52;
}

/**
 * The items in a shuffled order that depends only on the seed and each item's
 * key, never on the order they arrived in. Returns a new array.
 */
export function seededShuffle<T>(items: readonly T[], seed: string, keyOf: (item: T) => string): T[] {
  return items
    .map((item) => {
      const key = keyOf(item);
      return { item, key, unit: seededUnit(seed, key) };
    })
    .sort((a, b) => a.unit - b.unit || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ item }) => item);
}

/**
 * The numbers 1 to `count` in a seeded order that leans toward the front:
 * number n is drawn with weight n to the power of minus `frontBias`, without
 * replacement (Efraimidis and Spirakis's weighted shuffle). A bias of 0 is an
 * even shuffle. A larger one keeps low numbers nearer the start. `scope` keeps
 * two lists shuffled with one seed apart.
 */
export function seededFrontWeightedOrder(count: number, seed: string, scope: string, frontBias: number): number[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`seededFrontWeightedOrder: bad count ${count}`);
  if (!Number.isFinite(frontBias) || frontBias < 0) throw new RangeError(`seededFrontWeightedOrder: bad frontBias ${frontBias}`);
  return Array.from({ length: count }, (_, i) => i + 1)
    // A draw's key is unit^(1/weight), and the largest key goes first. With weight n^-bias, 1/weight is n^bias.
    .map((n) => ({ n, key: seededUnit(seed, `${scope}|${n}`) ** (n ** frontBias) }))
    .sort((a, b) => b.key - a.key || a.n - b.n)
    .map(({ n }) => n);
}
