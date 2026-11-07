import { describe, expect, test } from "bun:test";
import { MAX_PROVIDER_IDS, updateUserSettings, validateSettingsPatch } from "./user-settings";

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
