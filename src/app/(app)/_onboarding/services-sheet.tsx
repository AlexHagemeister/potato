"use client";

import { useEffect, useRef } from "react";
import { SettingsForm } from "../profile/settings-form";
import type { SheetData } from "./actions";
import { finishOnboarding, retrySheet } from "./store";

/**
 * The one onboarding sheet (issue 139): country and streaming services. It holds the Profile tab's own settings
 * form, so every choice saves the way it does there, through the same actions and core functions, and nothing
 * here writes. Skippable, and it says where to change the choice later.
 */
export function ServicesSheet({ data, onRefresh }: { data: SheetData | null; onRefresh: () => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = () => void finishOnboarding(onRefresh);

  // The sheet takes focus, so a screen reader starts at its heading and Tab starts inside it. On close, focus goes
  // back to whatever had it.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An Escape meant for a field (clearing the service search, or closing the country list) stays with it:
        // closing the sheet ends onboarding for good.
        const t = e.target;
        if (t instanceof HTMLSelectElement) return;
        if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value !== "") return;
        void finishOnboarding(onRefresh);
        return;
      }
      // Modal: Tab stays inside the sheet.
      if (e.key !== "Tab") return;
      const root = sheet.current;
      if (!root) return;
      const stops = Array.from(
        root.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), input:not([disabled])"),
      );
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
  }, [onRefresh]);

  return (
    <div
      ref={sheet}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-sheet-heading"
      aria-describedby="onboarding-sheet-intro"
      data-slot="onboarding-services"
      className="sheet-in fixed inset-0 z-50 flex flex-col bg-background outline-none"
    >
      {/* The filter sheet's header: a quiet action on the left, the title, the main action on the right. */}
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-hairline px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" onClick={close} className="h-14 justify-self-start px-3 text-muted">
          Not now
        </button>
        <h2 id="onboarding-sheet-heading" className="text-base font-semibold">
          Your services
        </h2>
        <button type="button" onClick={close} className="h-14 justify-self-end px-3 font-semibold text-accent">
          Done
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <div className="mb-6 px-1">
          <p className="text-[1.375rem] leading-tight font-bold tracking-tight">Where do you watch?</p>
          <p id="onboarding-sheet-intro" className="mt-2 text-[0.9375rem] leading-snug text-muted">
            Pick your country and the services you use. Each card then shows where you can stream it, with yours
            highlighted, and Filters can keep to what&apos;s on your services.
          </p>
          <p className="mt-2 text-sm text-muted">You can change this any time in Profile.</p>
        </div>

        {data === null && <FormSkeleton />}
        {data && !data.ok && (
          <div className="rounded-2xl bg-surface px-4 py-6 text-center">
            <p className="font-medium">Couldn&apos;t load the services</p>
            <p className="mt-1 text-sm text-muted">Try again, or pick them later in Profile.</p>
            <button type="button" onClick={retrySheet} className="mt-4 rounded-full bg-surface-raised px-6 py-3 font-medium">
              Try again
            </button>
          </div>
        )}
        {data?.ok && (
          <SettingsForm
            initialCountry={data.value.settings.country}
            initialProviderIds={data.value.settings.providerIds}
            countries={data.value.countries}
            initialServices={data.value.services}
            servicesUnavailable={data.value.servicesUnavailable}
          />
        )}
      </div>
    </div>
  );
}

/** Quiet grey blocks in the form's shape while it loads, like the deck's loading card. */
function FormSkeleton() {
  return (
    <div aria-label="Loading" aria-busy="true" className="animate-pulse motion-reduce:animate-none">
      <div className="mb-2 h-4 w-20 rounded bg-surface" />
      <div className="mb-8 h-12 rounded-2xl bg-surface" />
      <div className="mb-2 h-4 w-36 rounded bg-surface" />
      <div className="mb-3 h-11 rounded-xl bg-surface" />
      <div className="h-72 rounded-2xl bg-surface" />
    </div>
  );
}
