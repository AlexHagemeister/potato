import type { ReactNode } from "react";

/**
 * One tab's screen inside the app shell. The shell is a fixed full-screen
 * column: [this screen's content] [this screen's actions] [tab bar]. Only the
 * content scrolls.
 *
 * The actions slot: pass `actions` and it renders as a row pinned directly
 * above the tab bar, outside the scroll area, so it stays put while the
 * content scrolls. This is where the deck's four buttons go (VISION
 * "Navigation": the card buttons sit just above the tab bar). Any route can
 * use it, so a search result's card can show the same four buttons. The row's
 * height is `--deck-actions-height` (globals.css). The buttons fill it; keep
 * each target at least 44pt tall.
 */
export function Screen({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-6">
        {children}
      </main>
      {actions !== undefined && (
        <div
          data-slot="deck-actions"
          className="h-[var(--deck-actions-height)] shrink-0 px-4"
        >
          {actions}
        </div>
      )}
    </>
  );
}

/** A tab's large title, iOS style. */
export function ScreenTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-4 text-[2rem] leading-tight font-bold tracking-tight">{children}</h1>;
}
