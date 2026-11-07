import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userSettings } from "@/db/schema";

export type UserSettings = typeof userSettings.$inferSelect;

/**
 * Creates the user's settings row with the defaults (country 'US', no
 * streaming services) if it does not exist yet. Safe to call more than once.
 */
export async function ensureUserSettings(userId: string): Promise<void> {
  await getDb().insert(userSettings).values({ userId }).onConflictDoNothing();
}

/**
 * The user's settings, creating the default row first if it is missing. Every
 * read of settings goes through here, so no code path depends on the sign-up
 * hook having succeeded.
 */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const db = getDb();
  const [existing] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  if (existing) return existing;
  await ensureUserSettings(userId);
  const [created] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  if (!created) throw new Error(`No settings row for user ${userId}`);
  return created;
}
