// The one owner of the user_settings table: country and streaming services
// (VISION: Your account and settings). These drive streaming info on each card
// and the "on my services" filter.

import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userSettings } from "@/db/schema";
import { fail, ok, type LibraryResult } from "../library/errors";
import { FOREIGN_KEY_VIOLATION, pgErrorCode } from "../library/pg-error";
import type { UserSettings, UserSettingsPatch } from "../library/types";
import { validateUserId } from "../library/validate";

/** Largest value a Postgres integer holds. */
const PG_INT_MAX = 2_147_483_647;

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
 * numbers. Duplicates are dropped, keeping the first.
 */
export function validateSettingsPatch(patch: unknown): LibraryResult<UserSettingsPatch> {
  const bad = (message: string) => fail<UserSettingsPatch>({ code: "invalid_settings", message });
  if (typeof patch !== "object" || patch === null) return bad("settings must be an object");
  const p = patch as Record<string, unknown>;
  const out: UserSettingsPatch = {};
  if (p.country !== undefined) {
    if (typeof p.country !== "string") return bad("country must be a string");
    const country = p.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return bad(`country must be a two-letter ISO code, got ${JSON.stringify(p.country)}`);
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
export async function getUserSettings(userId: string): Promise<LibraryResult<UserSettings>> {
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

/** Changes the fields the patch names and keeps the rest. Creates the row if it is missing. */
export async function updateUserSettings(
  userId: string,
  patch: UserSettingsPatch,
  options: { now?: Date } = {},
): Promise<LibraryResult<UserSettings>> {
  const u = validateUserId(userId);
  if (!u.ok) return u;
  const valid = validateSettingsPatch(patch);
  if (!valid.ok) return valid;
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
