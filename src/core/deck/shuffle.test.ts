import { describe, expect, test } from "bun:test";
import { isShuffleSeed, seededFrontWeightedOrder, seededShuffle, seededUnit } from "./shuffle";

const seeds = (n: number) => Array.from({ length: n }, (_, i) => `seed-${i}`);

describe("seededUnit", () => {
  test("is strictly between 0 and 1, and the same every time", () => {
    for (const seed of seeds(200)) {
      const u = seededUnit(seed, "movie:603");
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      expect(seededUnit(seed, "movie:603")).toBe(u);
    }
  });

  test("changes with the seed and with the key, and keeps seed and key apart", () => {
    expect(seededUnit("a", "movie:1")).not.toBe(seededUnit("b", "movie:1"));
    expect(seededUnit("a", "movie:1")).not.toBe(seededUnit("a", "movie:2"));
    expect(seededUnit("ab", "c")).not.toBe(seededUnit("a", "bc"));
  });

  test("spreads evenly: the mean over many keys is near a half", () => {
    const n = 5000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += seededUnit("spread", `movie:${i}`);
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
  });
});

describe("isShuffleSeed", () => {
  test("takes 1 to 32 URL-safe characters and nothing else", () => {
    for (const good of ["a", "Ab3_-", "x".repeat(32)]) expect(isShuffleSeed(good)).toBe(true);
    for (const bad of ["", "x".repeat(33), "a|b", "a b", "é", 7, null, undefined, {}]) expect(isShuffleSeed(bad)).toBe(false);
  });
});

describe("seededShuffle", () => {
  const items = Array.from({ length: 30 }, (_, i) => `movie:${i + 1}`);
  const same = (a: string) => a;

  test("keeps every item exactly once and never touches its input", () => {
    const frozen = Object.freeze([...items]);
    const out = seededShuffle(frozen, "s1", same);
    expect([...out].sort()).toEqual([...items].sort());
    expect(out).not.toEqual(items);
  });

  test("the same seed gives the same order, whatever order the items arrived in", () => {
    const out = seededShuffle(items, "s1", same);
    expect(seededShuffle(items, "s1", same)).toEqual(out);
    expect(seededShuffle([...items].reverse(), "s1", same)).toEqual(out);
  });

  test("a new seed is a new order", () => {
    const orders = new Set(seeds(50).map((seed) => seededShuffle(items, seed, same).join(",")));
    expect(orders.size).toBe(50);
  });

  test("every item gets its turn at the front", () => {
    const first = new Set(seeds(600).map((seed) => seededShuffle(items, seed, same)[0]));
    expect(first.size).toBe(items.length);
  });
});

describe("seededFrontWeightedOrder", () => {
  test("is the numbers 1 to count, each once, the same for the same seed and scope", () => {
    const order = seededFrontWeightedOrder(15, "s1", "pages|popular:movie", 0.5);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(seededFrontWeightedOrder(15, "s1", "pages|popular:movie", 0.5)).toEqual(order);
    expect(seededFrontWeightedOrder(0, "s1", "x", 0.5)).toEqual([]);
  });

  test("differs by seed and by scope", () => {
    const base = seededFrontWeightedOrder(15, "s1", "pages|popular:movie", 0.5).join(",");
    expect(seededFrontWeightedOrder(15, "s2", "pages|popular:movie", 0.5).join(",")).not.toBe(base);
    expect(seededFrontWeightedOrder(15, "s1", "pages|popular:tv", 0.5).join(",")).not.toBe(base);
  });

  test("leans toward the front by the stated weights, and a bias of 0 is even", () => {
    const n = 4000;
    const firstCounts = (bias: number) => {
      const counts = new Array<number>(16).fill(0);
      for (const seed of seeds(n)) counts[seededFrontWeightedOrder(15, seed, "p", bias)[0]]++;
      return counts;
    };
    // Weight n^-0.5: number 1 opens with probability 1 / sum(n^-0.5 for 1..15), about 0.158, and 15 with about 0.041.
    const leaning = firstCounts(0.5);
    const total = Array.from({ length: 15 }, (_, i) => (i + 1) ** -0.5).reduce((a, b) => a + b, 0);
    expect(leaning[1] / n).toBeGreaterThan(1 / total - 0.03);
    expect(leaning[1] / n).toBeLessThan(1 / total + 0.03);
    expect(leaning[15] / n).toBeGreaterThan(15 ** -0.5 / total - 0.02);
    expect(leaning[15] / n).toBeLessThan(15 ** -0.5 / total + 0.02);
    // Every number still opens some deck.
    for (let page = 1; page <= 15; page++) expect(leaning[page]).toBeGreaterThan(0);

    const even = firstCounts(0);
    for (let page = 1; page <= 15; page++) {
      expect(even[page] / n).toBeGreaterThan(1 / 15 - 0.025);
      expect(even[page] / n).toBeLessThan(1 / 15 + 0.025);
    }
  });

  test("a bad count or bias throws", () => {
    for (const count of [-1, 1.5, Number.NaN]) expect(() => seededFrontWeightedOrder(count, "s", "p", 0.5)).toThrow(RangeError);
    for (const bias of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => seededFrontWeightedOrder(15, "s", "p", bias)).toThrow(RangeError);
  });
});
