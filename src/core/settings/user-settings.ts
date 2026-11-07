import { getDb } from "@/db/client";
import { userSettings } from "@/db/schema";

/**
 * Creates the user's settings row with the defaults (country 'US', no
 * streaming services) if it does not exist yet. Safe to call more than once.
 */
export async function ensureUserSettings(userId: string): Promise<void> {
  await getDb().insert(userSettings).values({ userId }).onConflictDoNothing();
}
