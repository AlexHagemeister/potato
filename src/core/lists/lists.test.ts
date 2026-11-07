import { describe, expect, test } from "bun:test";
import type { TitleRecord } from "../library/types";
import type { DetailsCore } from "../tmdb";
import { toListRow } from "./lists";

const record: TitleRecord = {
  mediaType: "movie",
  tmdbId: 603,
  status: "seen",
  rating: 4.5,
  review: "Still holds up.",
  reviewVisibility: "private",
  skipUntil: null,
  createdAt: new Date("2026-11-01T10:00:00Z"),
  updatedAt: new Date("2026-11-02T10:00:00Z"),
};

const info = {
  mediaType: "movie",
  tmdbId: 603,
  title: "The Matrix",
  year: 1999,
  posterPath: "/poster.jpg",
} as DetailsCore;

describe("toListRow", () => {
  test("carries the row's identity, status, rating, review, and time, plus title, year, and a thumbnail poster", () => {
    expect(toListRow(record, info)).toEqual({
      mediaType: "movie",
      tmdbId: 603,
      status: "seen",
      rating: 4.5,
      review: "Still holds up.",
      updatedAt: record.updatedAt,
      title: "The Matrix",
      year: 1999,
      posterUrl: "https://image.tmdb.org/t/p/w185/poster.jpg",
    });
  });

  test("unknown metadata still gives a row, with null display fields", () => {
    const row = toListRow({ ...record, status: "watchlist", rating: null, review: null }, undefined);
    expect(row).toMatchObject({ mediaType: "movie", tmdbId: 603, status: "watchlist", title: null, year: null, posterUrl: null });
  });

  test("a title with no poster gets a null poster URL", () => {
    expect(toListRow(record, { ...info, posterPath: null }).posterUrl).toBeNull();
  });
});
