"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { detectInstallPlatform, installGuide, type InstallSection, type StepIcon } from "@/core/install/guide";
import { autoOpenInstallSheet, closeInstallSheet, runInstallPrompt, useInstallState, type InstallState } from "./store";

/**
 * The home-screen prompt (issue 138). It lives in the app shell and lays a bottom sheet over whatever tab is up.
 * The tab underneath mounts and loads as usual, so the deck is ready the moment the sheet closes (VISION
 * invariant 8). It opens by itself once per device, in a browser tab only, and from the Profile tab on request.
 */
export function InstallPrompt() {
  const state = useInstallState();
  // After mount, so the device checks (storage, display mode) run in the browser only.
  useEffect(() => {
    autoOpenInstallSheet();
  }, []);
  if (!state.open) return null;
  return <InstallSheet state={state} />;
}

function InstallSheet({ state }: { state: InstallState }) {
  // Read here, not at module load: this component only ever renders in the browser, after the sheet opens.
  const guide = useMemo(
    () => installGuide(detectInstallPlatform({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints })),
    [],
  );
  const sheetRef = useRef<HTMLDivElement>(null);
  const canInstall = guide.canOfferPrompt && (state.promptReady || state.prompting);

  // The sheet itself takes focus, so VoiceOver reads it from the top and Tab starts inside it. Not a button: a
  // focused button draws a ring on some browsers, and nothing here should look selected.
  // When it closes, focus goes back to whatever had it (the Profile tab's row).
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeInstallSheet();
        return;
      }
      // The sheet is modal, so Tab stays inside it and never reaches the deck's buttons under the backdrop.
      if (e.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const stops = Array.from(sheet.querySelectorAll<HTMLElement>("button:not([disabled])"));
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && stops.includes(active);
      if (e.shiftKey ? !inside || active === first : !inside || active === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    // Same shape as the rating sheet's confirmation: a dimmed backdrop that closes on tap, and a sheet from the bottom.
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={closeInstallSheet}>
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-sheet-heading"
        aria-describedby="install-sheet-intro"
        onClick={(e) => e.stopPropagation()}
        className="sheet-in mx-auto flex max-h-[calc(100dvh-env(safe-area-inset-top)-2rem)] w-full max-w-md flex-col rounded-t-3xl bg-surface outline-none"
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-6">
          <Image
            src="/icons/icon-192.png"
            alt=""
            width={64}
            height={64}
            className="mx-auto rounded-2xl ring-1 ring-hairline"
          />
          <h2 id="install-sheet-heading" className="mt-4 text-center text-xl leading-tight font-bold tracking-tight">
            {guide.title}
          </h2>
          <p id="install-sheet-intro" className="mt-2 px-4 text-center text-sm leading-snug text-muted">
            {guide.intro}
          </p>

          {guide.sections.map((section, index) => (
            <Steps key={section.heading ?? index} section={section} />
          ))}
        </div>

        <div className="shrink-0 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <div className="flex flex-col gap-2">
            {canInstall && (
              <button
                type="button"
                onClick={() => void runInstallPrompt()}
                disabled={state.prompting}
                className="h-14 rounded-2xl bg-accent font-semibold text-black disabled:opacity-60"
              >
                Install Potato
              </button>
            )}
            <button
              type="button"
              onClick={closeInstallSheet}
              className="h-14 rounded-2xl bg-surface-raised font-semibold text-accent"
            >
              {canInstall ? "Not now" : "Got it"}
            </button>
          </div>
          {/* Only when it is true and news: there are steps, and the sheet was not opened from the Profile tab. */}
          {state.auto && guide.sections.length > 0 && (
            <p className="mt-3 text-center text-xs text-muted">These steps stay on your Profile tab.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Steps({ section }: { section: InstallSection }) {
  return (
    <section className="mt-5">
      {section.heading && (
        <h3 className="mb-2 px-1 text-xs font-semibold tracking-wide text-muted uppercase">{section.heading}</h3>
      )}
      <ol className="overflow-hidden rounded-2xl bg-surface-raised">
        {section.steps.map((step, index) => (
          <li key={index} className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-b-0">
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent"
            >
              {index + 1}
            </span>
            <p className="min-w-0 flex-1 text-[0.9375rem] leading-snug">{withBold(step.text)}</p>
            {step.icon && <StepGlyph icon={step.icon} />}
          </li>
        ))}
      </ol>
      {section.note && <p className="mt-2 px-1 text-xs leading-snug text-muted">{section.note}</p>}
    </section>
  );
}

/** Core marks a control's name with **. Every odd piece of the split is one. */
function withBold(text: string): ReactNode[] {
  return text.split("**").map((piece, index) =>
    index % 2 === 1 ? (
      <strong key={index} className="font-semibold">
        {piece}
      </strong>
    ) : (
      piece
    ),
  );
}

const glyphProps = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  className: "shrink-0 text-muted",
};

/** A sketch of the control the step names, in the tab bar's line style. Decoration: the step's text says it all. */
function StepGlyph({ icon }: { icon: StepIcon }) {
  switch (icon) {
    case "share":
      return (
        <svg {...glyphProps}>
          <path d="M12 15V3.5" />
          <path d="m8 7 4-4 4 4" />
          <path d="M8.5 10.5H7a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6.5a2 2 0 0 0-2-2h-1.5" />
        </svg>
      );
    case "add":
      return (
        <svg {...glyphProps}>
          <rect x="4" y="4" width="16" height="16" rx="4" />
          <path d="M12 8.5v7M8.5 12h7" />
        </svg>
      );
    case "dots-vertical":
      return (
        <svg {...glyphProps}>
          <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "open-out":
      return (
        <svg {...glyphProps}>
          <path d="M14 4h6v6" />
          <path d="M20 4 11 13" />
          <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
        </svg>
      );
    case "install":
      return (
        <svg {...glyphProps}>
          <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
          <path d="M12 7.5v7" />
          <path d="m9 12 3 3 3-3" />
        </svg>
      );
  }
}
