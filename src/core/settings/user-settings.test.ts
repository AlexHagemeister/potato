import { describe, expect, test } from "bun:test";
import {
  getDeckChoice,
  MAX_PROVIDER_IDS,
  saveDeckChoice,
  updateUserSettings,
  validateDeckChoice,
  validateSettingsPatch,
} from "./user-settings";
import type { FilterChoice } from "../filters";

describe("deck choice (saved to the profile)", () => {
  const filters: FilterChoice = { type: "tv", genres: ["scifi"], era: "recent", minRating: "7.5", onMyServices: true };

  test("validateDeckChoice accepts a full choice and normalizes its filters", () => {
    expect(validateDeckChoice({ mode: "top_rated", filters })).toEqual({ ok: true, value: { mode: "top_rated", filters } });
    // A genre the control can't produce, or one that doesn't exist for series, drops out.
    expect(validateDeckChoice({ mode: "blend", filters: { ...filters, genres: ["scifi", "horror", "nope"] } })).toEqual({
      ok: true,
      value: { mode: "blend", filters },
    });
  });

  // Each case wrapped in an array: test.each spreads a bare array case into arguments.
  test.each([[null], ["blend"], [[]], [{ filters }], [{ mode: "box_office", filters }], [{ mode: "blend" }], [{ mode: "blend", filters: [] }]])(
    "validateDeckChoice rejects %p",
    (input: unknown) => {
      expect(validateDeckChoice(input)).toMatchObject({ ok: false, error: { code: "invalid_settings" } });
    },
  );

  test("saveDeckChoice refuses a bad user or a bad choice before any write", async () => {
    expect(await saveDeckChoice("", { mode: "blend", filters })).toEqual({ ok: false, error: { code: "invalid_user" } });
    expect(await saveDeckChoice("user-1", { mode: "box_office", filters })).toMatchObject({ ok: false, error: { code: "invalid_settings" } });
  });

  test("getDeckChoice refuses a bad user before any read", async () => {
    expect(await getDeckChoice("")).toEqual({ ok: false, error: { code: "invalid_user" } });
  });
});

describe("validateSettingsPatch", () => {
  test("uppercases and trims the country", () => {
    expect(validateSettingsPatch({ country: " gb " })).toEqual({ ok: true, value: { country: "GB" } });
  });

  // "ß" and "ıt" become two ASCII letters only after uppercasing ("SS", "IT").
  test.each(["USA", "U", "1A", "", 5, "ß", "ıt", "é1"])("rejects country %p", (country) => {
    expect(validateSettingsPatch({ country })).toMatchObject({ ok: false, error: { code: "invalid_settings" } });
  });

  test("dedupes provider IDs, keeping first-seen order", () => {
    expect(validateSettingsPatch({ providerIds: [8, 337, 8, 15] })).toEqual({ ok: true, value: { providerIds: [8, 337, 15] } });
  });

  test("an empty provider list is valid (no services)", () => {
    expect(validateSettingsPatch({ providerIds: [] })).toEqual({ ok: true, value: { providerIds: [] } });
  });

  test.each([[0], [-8], [1.5], ["8"], [2_147_483_648]])("rejects provider ID list %p", (...providerIds) => {
    expect(validateSettingsPatch({ providerIds }).ok).toBe(false);
  });

  test("rejects a non-array and an empty change", () => {
    expect(validateSettingsPatch({ providerIds: 8 }).ok).toBe(false);
    expect(validateSettingsPatch({}).ok).toBe(false);
    expect(validateSettingsPatch(null).ok).toBe(false);
  });
});

describe("settings limits", () => {
  test("caps saved services at MAX_PROVIDER_IDS, after dropping duplicates", () => {
    const max = Array.from({ length: MAX_PROVIDER_IDS }, (_, i) => i + 1);
    expect(validateSettingsPatch({ providerIds: [...max, 1] }).ok).toBe(true);
    expect(validateSettingsPatch({ providerIds: [...max, MAX_PROVIDER_IDS + 1] })).toEqual({
      ok: false,
      error: { code: "too_many_services", max: MAX_PROVIDER_IDS },
    });
  });

  test("a country TMDB has no streaming data for is unknown_country, checked before any write", async () => {
    const watchRegions = async () => [{ code: "US", name: "United States" }];
    expect(await updateUserSettings("user-1", { country: "zz" }, { watchRegions })).toEqual({
      ok: false,
      error: { code: "unknown_country", country: "ZZ" },
    });
  });
});
