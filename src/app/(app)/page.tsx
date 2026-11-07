import { getCurrentUserForRequest } from "@/lib/current-user";
import { Deck } from "./_deck/deck";
import { SignedOutScreen } from "./_shell/signed-out";

// Discover: the deck. The app opens here (VISION invariant 8). The page only
// checks the session: the deck fetches its cards in the browser (from
// /api/deck) and keeps them across tab switches, so coming back to Discover
// shows the same card at once.
export default async function DiscoverPage() {
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  const user = await getCurrentUserForRequest();
  if (!user) return <SignedOutScreen />;
  return <Deck userId={user.id} />;
}
