"use server";

// Server actions for the Profile tab. Thin glue (CLAUDE.md rule 3): each one
// resolves the user from the session cookie, never from client input, and
// calls core.

import { changeCountry, type StreamingService } from "@/core/settings/profile";
import { SettingsInputError, setProviderIds } from "@/core/settings/settings";
import { getCurrentUserForRequest } from "@/lib/current-user";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const user = await getCurrentUserForRequest();
  if (!user) return { ok: false, error: "You're signed out. Sign in again to save." };
  try {
    return { ok: true, value: await fn(user.id) };
  } catch (err) {
    if (err instanceof SettingsInputError) return { ok: false, error: err.message };
    console.error("profile action failed:", err);
    return { ok: false, error: "Couldn't save. Try again." };
  }
}

/** Saves the country and returns its streaming services. */
export async function changeCountryAction(country: string): Promise<ActionResult<StreamingService[]>> {
  return run((userId) => changeCountry(userId, country));
}

/** Replaces the saved streaming services. */
export async function saveServicesAction(providerIds: number[]): Promise<ActionResult<null>> {
  return run(async (userId) => {
    await setProviderIds(userId, providerIds);
    return null;
  });
}
