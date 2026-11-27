"use client";

import { openInstallSheet, useInstallState, useStandalone } from "../_install/store";

/**
 * Where the home-screen steps stay reachable after the prompt is dismissed (issue 138). It opens the shell's sheet.
 * Hidden when the app already runs from the home screen. It sits below the settings, so appearing after the page
 * loads (the display mode is only known in the browser) moves nothing the user is reading.
 */
export function InstallRow() {
  const standalone = useStandalone();
  // The browser has offered its install prompt (it can come late, after the sheet was closed), so the sheet this
  // row opens will carry a real Install button.
  const { promptReady } = useInstallState();
  if (standalone) return null;
  return (
    <section aria-labelledby="install-heading" className="mt-8">
      <h2 id="install-heading" className="mb-2 px-1 text-xs font-semibold tracking-wide text-muted uppercase">
        Home Screen
      </h2>
      <button
        type="button"
        onClick={openInstallSheet}
        className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-surface px-4 py-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block">Add Potato to your Home Screen</span>
          <span className="block text-sm text-muted">
            {promptReady ? "Ready to install. Tap to add it." : "Open it like an app, full screen."}
          </span>
        </span>
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-muted"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
    </section>
  );
}
