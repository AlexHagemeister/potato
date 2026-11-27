// Whether a signed-in user is a new account (issue 139), from what the server already knows. The rule itself is
// isNewAccount, in rules.ts. It changes no title row and no chosen setting. Its settings read goes through
// getUserSettings, which creates the default settings row (country US, no services) when there is none yet, as
// every settings read does.

import { getUserTitleStates } from "../library/queries";
import { getUserSettings } from "../settings/user-settings";
import { isNewAccount } from "./rules";

/**
 * True only for an account with no title rows and untouched settings. Settings are read first, and the rows only
 * when the settings still look untouched, so most existing users pay no extra query. Any failure reads as not new:
 * an existing user must never see onboarding.
 */
export async function getIsNewAccount(userId: string): Promise<boolean> {
  try {
    const settings = await getUserSettings(userId);
    if (!settings.ok) return false;
    const facts = { titleRows: 0, country: settings.value.country, providerIds: settings.value.providerIds };
    if (!isNewAccount(facts)) return false;
    const rows = await getUserTitleStates(userId);
    if (!rows.ok) return false;
    return isNewAccount({ ...facts, titleRows: rows.value.length });
  } catch (error) {
    console.error("onboarding: could not tell whether the account is new:", error);
    return false;
  }
}
