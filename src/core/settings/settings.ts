// Read and update a user's settings: country and streaming services.
// Minimal on purpose. The core/library slice owns the fuller settings API and
// may replace this file when it lands.

import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userSettings } from "@/db/schema";

export interface UserSettings {
  /** ISO 3166-1 alpha-2 ("US"). */
  country: string;
  /** TMDB watch provider IDs. They are the same in every country (Netflix is 8 everywhere). */
  providerIds: number[];
}

export const DEFAULT_COUNTRY = "US";

/** The most services one user can save. A guard against junk input, far above any real use. */
export const MAX_PROVIDER_IDS = 200;

export class SettingsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsInputError";
  }
}

/** A two-letter uppercase ISO 3166-1 code, or SettingsInputError. */
export function parseCountry(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Z]{2}$/.test(input)) {
    throw new SettingsInputError("Country must be a two-letter ISO 3166-1 code");
  }
  return input;
}

/** Positive integer IDs, deduplicated, in first-seen order, or SettingsInputError. */
export function normalizeProviderIds(input: unknown): number[] {
  if (!Array.isArray(input)) throw new SettingsInputError("Provider IDs must be a list");
  const ids: number[] = [];
  for (const value of input) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new SettingsInputError("Provider IDs must be positive integers");
    }
    if (!ids.includes(value)) ids.push(value);
  }
  if (ids.length > MAX_PROVIDER_IDS) throw new SettingsInputError("Too many provider IDs");
  return ids;
}

/** The user's settings. Creates the row with the defaults when it is missing. */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const db = getDb();
  const read = () =>
    db
      .select({ country: userSettings.country, providerIds: userSettings.providerIds })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1);
  let rows = await read();
  if (rows.length === 0) {
    await db.insert(userSettings).values({ userId }).onConflictDoNothing();
    rows = await read();
  }
  const row = rows[0];
  if (!row) throw new Error(`No settings row for user ${userId}`);
  return { country: row.country, providerIds: row.providerIds };
}

/**
 * Saves the country. Saved services are kept: provider IDs are global, so a
 * service the new country lacks simply matches nothing there, and switching
 * back restores the selection.
 */
export async function setCountry(userId: string, country: unknown): Promise<void> {
  const value = parseCountry(country);
  await getDb()
    .insert(userSettings)
    .values({ userId, country: value })
    .onConflictDoUpdate({ target: userSettings.userId, set: { country: value, updatedAt: sql`now()` } });
}

/** Replaces the saved streaming services with this set. */
export async function setProviderIds(userId: string, providerIds: unknown): Promise<void> {
  const value = normalizeProviderIds(providerIds);
  await getDb()
    .insert(userSettings)
    .values({ userId, providerIds: value })
    .onConflictDoUpdate({ target: userSettings.userId, set: { providerIds: value, updatedAt: sql`now()` } });
}
