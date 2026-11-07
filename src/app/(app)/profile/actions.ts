"use server";

// Server actions for the Profile tab. Thin glue (CLAUDE.md rule 3): each one
// resolves the user from the session cookie, never from client input, calls
// core, and turns core's result into a message for the screen.

import { changeCountry, type StreamingService } from "@/core/settings/profile";
import { updateUserSettings, type Result } from "@/core/library";
import { getCurrentUserForRequest } from "@/lib/current-user";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

const SIGNED_OUT = "You're signed out. Sign in again to save.";

async function run<T>(fn: (userId: string) => Promise<Result<T>>): Promise<ActionResult<T>> {
  const user = await getCurrentUserForRequest();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const result = await fn(user.id);
    if (result.ok) return result;
    // invalid_settings messages are written for developers, not for the screen.
    if (result.error.code === "invalid_user" || result.error.code === "unknown_user") return { ok: false, error: SIGNED_OUT };
    console.error("profile action rejected:", result.error);
    return { ok: false, error: "Couldn't save that. Try again." };
  } catch (err) {
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
    const saved = await updateUserSettings(userId, { providerIds });
    return saved.ok ? { ok: true, value: null } : saved;
  });
}
