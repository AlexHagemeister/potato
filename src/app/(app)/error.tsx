"use client";

import { Screen, ScreenTitle } from "./_shell/screen";

// A tab that failed to load keeps the tab bar and offers a retry.
export default function TabError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Screen>
      <ScreenTitle>Something went wrong</ScreenTitle>
      <p className="mb-6 text-muted">This screen didn&apos;t load.</p>
      <button type="button" onClick={reset} className="rounded-full bg-surface-raised px-6 py-3 font-medium">
        Try again
      </button>
    </Screen>
  );
}
