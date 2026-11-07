import { getUserSettings } from "@/core/settings/user-settings";
import { getCurrentUserForRequest } from "@/lib/current-user";
import { Deck } from "./_deck/deck";
import { SignedOutScreen } from "./_shell/signed-out";

// Discover: the deck. The app opens here (VISION invariant 8). The page checks
// the session and reads the user's country and services. The deck fetches its
// cards in the browser (from /api/deck) and keeps them across tab switches, so
// coming back to Discover shows the same card at once. The settings key tells
// it when the country or services changed, so it refetches the queued cards.
export default async function DiscoverPage() {
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  const user = await getCurrentUserForRequest();
  if (!user) return <SignedOutScreen />;
  const settings = await getUserSettings(user.id);
  // unknown_user: the session outlived the user row.
  if (!settings.ok) return <SignedOutScreen />;
  const { country, providerIds } = settings.value;
  const settingsKey = `${country}:${[...providerIds].sort((a, b) => a - b).join(",")}`;
  return <Deck userId={user.id} settingsKey={settingsKey} />;
}
