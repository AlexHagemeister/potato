import { Screen } from "./_shell/screen";

// Discover: the deck. The app opens here (VISION invariant 8). The deck
// builder replaces the placeholder card and fills the actions slot with the
// four buttons (Pass, Skip, Watchlist, Seen it).
export default function DiscoverPage() {
  return (
    <Screen actions={<div aria-hidden className="h-full" />}>
      <div className="flex h-full min-h-[24rem] flex-col items-center justify-center rounded-3xl border border-dashed border-hairline bg-surface px-6 text-center">
        <p className="text-lg font-semibold">Your deck goes here</p>
        <p className="mt-2 text-sm text-muted">One title at a time. Coming soon.</p>
      </div>
    </Screen>
  );
}
