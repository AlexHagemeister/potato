"use server";

// Server actions for the Profile tab. Thin glue (CLAUDE.md rule 3): each one
// resolves the user from the session cookie, never from client input, calls
// core, and words core's typed errors for the screen. Every check lives in core.

import { changeCountry, type StreamingService } from "@/core/settings/profile";
import { updateUserSettings, type CoreError, type Result } from "@/core/library";
import { getCurrentUserForRequest } from "@/lib/current-user";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

const SIGNED_OUT = "You're signed out. Sign in again to save.";

/** Presentation only: the words the screen shows for each core error. */
function messageFor(error: CoreError): string {
  switch (error.code) {
    case "invalid_user":
    case "unknown_user":
      return SIGNED_OUT;
    case "unknown_country":
      return "There's no streaming data for that country.";
    case "too_many_services":
      return `You can save up to ${error.max} services.`;
    default:
      // invalid_settings and the rest carry developer wording, not screen copy.
      console.error("profile action rejected:", error);
      return "Couldn't save that. Try again.";
  }
}

async function run<T>(fn: (userId: string) => Promise<Result<T>>): Promise<ActionResult<T>> {
  const user = await getCurrentUserForRequest();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const result = await fn(user.id);
    return result.ok ? result : { ok: false, error: messageFor(result.error) };
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
