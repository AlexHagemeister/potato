import { Screen, ScreenTitle } from "./screen";

/** A tab that is not built yet. */
export function PlaceholderScreen({ title, note }: { title: string; note: string }) {
  return (
    <Screen>
      <ScreenTitle>{title}</ScreenTitle>
      <p className="text-muted">{note}</p>
    </Screen>
  );
}

/** What a tab shows while its page streams in. Quiet on purpose: no spinner. */
export function ScreenSkeleton() {
  return (
    <Screen>
      <div className="mb-4 h-10 w-40 rounded-lg bg-surface" />
      <div className="space-y-3">
        <div className="h-14 rounded-xl bg-surface" />
        <div className="h-14 rounded-xl bg-surface" />
        <div className="h-14 rounded-xl bg-surface" />
      </div>
    </Screen>
  );
}
