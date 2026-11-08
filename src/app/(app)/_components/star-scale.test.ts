import { describe, expect, test } from "bun:test";
import { isValidRating } from "@/core/library/validate";
import { ratingAt, starAt, stepRating, tapRating } from "./star-scale";

const SLOT = 39; // one star's slot on a 390-wide phone

describe("ratingAt: the rating follows the finger in half steps", () => {
  test("the left half of a star is the half step, the right half the whole", () => {
    expect(ratingAt(1, SLOT)).toBe(0.5);
    expect(ratingAt(19, SLOT)).toBe(0.5);
    expect(ratingAt(20, SLOT)).toBe(1);
    expect(ratingAt(39, SLOT)).toBe(1);
    expect(ratingAt(40, SLOT)).toBe(1.5);
    expect(ratingAt(7 * SLOT + 10, SLOT)).toBe(7.5);
    expect(ratingAt(7 * SLOT + 30, SLOT)).toBe(8);
    expect(ratingAt(10 * SLOT, SLOT)).toBe(10);
  });

  test("clamps to 0.5 and 10 past either end of the row", () => {
    expect(ratingAt(0, SLOT)).toBe(0.5);
    expect(ratingAt(-50, SLOT)).toBe(0.5);
    expect(ratingAt(10 * SLOT + 1, SLOT)).toBe(10);
    expect(ratingAt(2000, SLOT)).toBe(10);
  });

  test("every point of the row gives a rating core accepts", () => {
    for (let x = -20; x <= 10 * SLOT + 20; x += 0.25) expect(isValidRating(ratingAt(x, SLOT))).toBe(true);
  });

  test("works at the 56px cap on a wide screen", () => {
    expect(ratingAt(56 * 4 + 1, 56)).toBe(4.5);
    expect(ratingAt(56 * 4 + 29, 56)).toBe(5);
  });
});

describe("starAt", () => {
  test("names the star under the point, 1 to 10", () => {
    expect(starAt(1, SLOT)).toBe(1);
    expect(starAt(SLOT, SLOT)).toBe(1);
    expect(starAt(SLOT + 1, SLOT)).toBe(2);
    expect(starAt(10 * SLOT, SLOT)).toBe(10);
  });

  test("clamps past either end", () => {
    expect(starAt(-5, SLOT)).toBe(1);
    expect(starAt(0, SLOT)).toBe(1);
    expect(starAt(10 * SLOT + 30, SLOT)).toBe(10);
  });
});

describe("tapRating: tap a star for that many, tap it again for half a star less", () => {
  test("a first tap sets the star's number", () => {
    expect(tapRating(null, 8)).toBe(8);
    expect(tapRating(3, 8)).toBe(8);
    expect(tapRating(7.5, 8)).toBe(8);
  });

  test("tapping the star that holds the rating takes off half a star", () => {
    expect(tapRating(8, 8)).toBe(7.5);
    expect(tapRating(10, 10)).toBe(9.5);
    expect(tapRating(1, 1)).toBe(0.5);
  });

  test("tapping a half-filled star fills it again", () => {
    expect(tapRating(0.5, 1)).toBe(1);
    expect(tapRating(7.5, 8)).toBe(8);
  });
});

describe("stepRating: arrow keys step 0.5 within the scale", () => {
  test("from no rating, either arrow gives the lowest rating", () => {
    expect(stepRating(null, 1)).toBe(0.5);
    expect(stepRating(null, -1)).toBe(0.5);
  });

  test("steps by half a star and stops at the ends", () => {
    expect(stepRating(7, 1)).toBe(7.5);
    expect(stepRating(7, -1)).toBe(6.5);
    expect(stepRating(10, 1)).toBe(10);
    expect(stepRating(0.5, -1)).toBe(0.5);
  });
});
