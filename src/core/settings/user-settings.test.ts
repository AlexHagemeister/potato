import { describe, expect, test } from "bun:test";
import { validateSettingsPatch } from "./user-settings";

describe("validateSettingsPatch", () => {
  test("uppercases and trims the country", () => {
    expect(validateSettingsPatch({ country: " gb " })).toEqual({ ok: true, value: { country: "GB" } });
  });

  test.each(["USA", "U", "1A", "", 5])("rejects country %p", (country) => {
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
