"use server";

// Server actions for first-run onboarding (issue 139). They change no title row and no chosen setting: the
// settings read creates the default settings row when there is none yet, as every settings read does. The
// services sheet saves through the Profile tab's own form and actions (profile/settings-form.tsx), so onboarding
// adds no write of its own.

import { getProfileSettings, type ProfileSettings } from "@/core/settings/profile";
import { getCurrentUserForRequest } from "@/lib/current-user";

export type SheetData = { ok: true; value: ProfileSettings } | { ok: false };

/** What the services sheet shows: the same read the Profile tab makes on first render. */
export async function loadServicesSheetAction(): Promise<SheetData> {
  const user = await getCurrentUserForRequest();
  if (!user) return { ok: false };
  try {
    const result = await getProfileSettings(user.id);
    return result.ok ? { ok: true, value: result.value } : { ok: false };
  } catch (error) {
    console.error("onboarding: services sheet could not load:", error);
    return { ok: false };
  }
}

/**
 * Does nothing. Next.js runs a page's server actions one at a time, in order, so awaiting this one waits out any
 * services save still on its way from the sheet. Then a refresh reads the saved settings.
 */
export async function settledAction(): Promise<null> {
  return null;
}
