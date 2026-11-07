import { getCurrentUserForRequest } from "@/lib/current-user";
import { Screen } from "./_shell/screen";
import { SignedOutScreen } from "./_shell/signed-out";

// Discover: the deck. The app opens here (VISION invariant 8). The deck
// builder replaces the placeholder card and fills the actions slot with the
// four buttons (Pass, Skip, Watchlist, Seen it).
export default async function DiscoverPage() {
  // Checked here too, not only in the shell layout, which a tab tap does not re-run.
  if (!(await getCurrentUserForRequest())) return <SignedOutScreen />;
  return (
    <Screen actions={<div aria-hidden className="h-full" />}>
      <div className="flex h-full min-h-[24rem] flex-col items-center justify-center rounded-3xl border border-dashed border-hairline bg-surface px-6 text-center">
        <p className="text-lg font-semibold">Your deck goes here</p>
        <p className="mt-2 text-sm text-muted">One title at a time. Coming soon.</p>
      </div>
    </Screen>
  );
}
