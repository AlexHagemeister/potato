"use client";

import { Screen, ScreenTitle } from "./_shell/screen";

// A tab that failed to load keeps the tab bar and offers a retry.
// retry() fetches the screen's server data again and re-renders it. reset()
// would only re-render, so a failed server read would fail the same way.
export default function TabError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Screen>
      <ScreenTitle>Something went wrong</ScreenTitle>
      <p className="mb-6 text-muted">This screen didn&apos;t load.</p>
      <button type="button" onClick={() => retry()} className="rounded-full bg-surface-raised px-6 py-3 font-medium">
        Try again
      </button>
    </Screen>
  );
}
