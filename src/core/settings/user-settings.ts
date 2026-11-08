// The one owner of the user_settings table: country and streaming services
// (VISION: Your account and settings). These drive streaming info on each card
// and the "on my services" filter.

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userSettings } from "@/db/schema";
import { FOREIGN_KEY_VIOLATION, pgErrorCode } from "../pg-error";
import { fail, ok, validateUserId, type Result } from "../result";
import { isDiscoveryMode, normalizeDeckChoice, type DeckChoice } from "../filters";
import { getTmdb } from "../tmdb/app-client";
import type { WatchRegion } from "../tmdb/types";

/** Largest value a Postgres integer holds. */
const PG_INT_MAX = 2_147_483_647;

/** The most streaming services one user can save. A guard against junk input, far above real use. */
export const MAX_PROVIDER_IDS = 200;

/** The countries a user can pick: those TMDB has streaming data for. */
export type WatchRegionSource = () => Promise<readonly WatchRegion[]>;

const tmdbWatchRegions: WatchRegionSource = () => getTmdb().getWatchRegions();

export interface UserSettings {
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string;
  /** TMDB watch provider IDs. */
  providerIds: number[];
  updatedAt: Date;
}

export interface UserSettingsPatch {
  country?: string;
  providerIds?: number[];
}

/**
 * Creates the user's settings row with the defaults (country 'US', no
 * streaming services) if it does not exist yet. Safe to call more than once.
 */
export async function ensureUserSettings(userId: string): Promise<void> {
  await getDb().insert(userSettings).values({ userId }).onConflictDoNothing();
}

/**
 * Checks and normalizes a settings change. The country is trimmed and
 * uppercased, and must then be two letters (ISO 3166-1 alpha-2), as
 * user_settings_country_check requires. Provider IDs must be positive whole
 * numbers. Duplicates are dropped, keeping the first, and at most
 * MAX_PROVIDER_IDS remain (too_many_services). Whether TMDB knows the country
 * needs a lookup, so updateUserSettings checks that.
 */
export function validateSettingsPatch(patch: unknown): Result<UserSettingsPatch> {
  const bad = (message: string) => fail<UserSettingsPatch>({ code: "invalid_settings", message });
  if (typeof patch !== "object" || patch === null) return bad("settings must be an object");
  const p = patch as Record<string, unknown>;
  const out: UserSettingsPatch = {};
  if (p.country !== undefined) {
    if (typeof p.country !== "string") return bad("country must be a string");
    // Check ASCII letters before uppercasing: toUpperCase maps some non-ASCII
    // letters to ASCII ("ß" becomes "SS"), which would pass the check.
    const trimmed = p.country.trim();
    if (!/^[A-Za-z]{2}$/.test(trimmed)) return bad(`country must be a two-letter ISO code, got ${JSON.stringify(p.country)}`);
    const country = trimmed.toUpperCase();
    out.country = country;
  }
  if (p.providerIds !== undefined) {
    if (!Array.isArray(p.providerIds)) return bad("providerIds must be an array");
    for (const id of p.providerIds as unknown[]) {
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || id > PG_INT_MAX) {
        return bad(`invalid provider ID ${JSON.stringify(id)}`);
      }
    }
    out.providerIds = [...new Set(p.providerIds as number[])];
    if (out.providerIds.length > MAX_PROVIDER_IDS) return fail({ code: "too_many_services", max: MAX_PROVIDER_IDS });
  }
  if (out.country === undefined && out.providerIds === undefined) return bad("the change names no field");
  return ok(out);
}

function toSettings(row: typeof userSettings.$inferSelect): UserSettings {
  return { country: row.country, providerIds: row.providerIds, updatedAt: row.updatedAt };
}

/**
 * The user's settings. Creates the default row first if it is missing
 * (get-or-create). Every read of settings goes through here, so no code path
 * depends on the sign-up hook having succeeded.
 */
export async function getUserSettings(userId: string): Promise<Result<UserSettings>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const read = () => getDb().select().from(userSettings).where(eq(userSettings.userId, u.value)).limit(1);
  let [row] = await read();
  if (!row) {
    try {
      await ensureUserSettings(u.value);
    } catch (error) {
      if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) return fail({ code: "unknown_user" });
      throw error;
    }
    [row] = await read();
  }
  if (!row) throw new Error("getUserSettings: settings row missing after insert");
  return ok(toSettings(row));
}

/**
 * Changes the fields the patch names and keeps the rest. Creates the row if it
 * is missing. A new country must be one TMDB has streaming data for
 * (unknown_country). That check reads TMDB's country list (cached), so a TMDB
 * outage throws rather than saving an unchecked country. `watchRegions`
 * replaces the TMDB lookup in tests.
 */
export async function updateUserSettings(
  userId: string,
  patch: UserSettingsPatch,
  options: { now?: Date; watchRegions?: WatchRegionSource } = {},
): Promise<Result<UserSettings>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const valid = validateSettingsPatch(patch);
  if (!valid.ok) return valid;
  const country = valid.value.country;
  if (country !== undefined) {
    const regions = await (options.watchRegions ?? tmdbWatchRegions)();
    if (!regions.some((r) => r.code === country)) return fail({ code: "unknown_country", country });
  }
  const now = options.now ?? new Date();
  try {
    const [row] = await getDb()
      .insert(userSettings)
      .values({ userId: u.value, ...valid.value, updatedAt: now })
      .onConflictDoUpdate({ target: userSettings.userId, set: { ...valid.value, updatedAt: now } })
      .returning();
    if (!row) throw new Error("updateUserSettings: no row returned");
    return ok(toSettings(row));
  } catch (error) {
    if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) return fail({ code: "unknown_user" });
    throw error;
  }
}

// ---- Discover's mode and filters ----
// VISION, Your account and settings: "Everything you do is saved to your
// profile and follows you across devices." The deck choice lives on the
// settings row, so the app on any device, and the future AI connection, read
// the same one.

/**
 * Checks a deck choice before it is saved. The shape must be right (an
 * object with a known mode and a filters object). Filter values the control
 * can't produce (an unknown genre, say) are dropped by core's normalizer, so
 * the saved value is always one the app can show.
 */
export function validateDeckChoice(input: unknown): Result<DeckChoice> {
  const bad = (message: string) => fail<DeckChoice>({ code: "invalid_settings", message });
  if (typeof input !== "object" || input === null) return bad("deck choice must be an object");
  const raw = input as Record<string, unknown>;
  if (!isDiscoveryMode(raw.mode)) return bad(`unknown mode ${JSON.stringify(raw.mode)}`);
  if (typeof raw.filters !== "object" || raw.filters === null || Array.isArray(raw.filters)) return bad("filters must be an object");
  return ok(normalizeDeckChoice(raw));
}

/** The user's saved deck choice, or the default (Blend, no filters) when none is saved. Creates the settings row if missing. */
export async function getDeckChoice(userId: string): Promise<Result<DeckChoice>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const read = () =>
    getDb().select({ deckChoice: userSettings.deckChoice }).from(userSettings).where(eq(userSettings.userId, u.value)).limit(1);
  let [row] = await read();
  if (!row) {
    // Same get-or-create as getUserSettings.
    const created = await getUserSettings(u.value);
    if (!created.ok) return created;
    [row] = await read();
  }
  // Normalized on read: a value saved by an older build still reads as a choice the app can show.
  return ok(normalizeDeckChoice(row?.deckChoice));
}

/** Saves the user's deck choice and returns it as saved (normalized). */
export async function saveDeckChoice(userId: string, choice: unknown, options: { now?: Date } = {}): Promise<Result<DeckChoice>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const valid = validateDeckChoice(choice);
  if (!valid.ok) return valid;
  const now = options.now ?? new Date();
  try {
    const [row] = await getDb()
      .insert(userSettings)
      .values({ userId: u.value, deckChoice: valid.value, updatedAt: now })
      .onConflictDoUpdate({ target: userSettings.userId, set: { deckChoice: valid.value, updatedAt: now } })
      .returning({ deckChoice: userSettings.deckChoice });
    if (!row) throw new Error("saveDeckChoice: no row returned");
    return ok(normalizeDeckChoice(row.deckChoice));
  } catch (error) {
    if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) return fail({ code: "unknown_user" });
    throw error;
  }
}
