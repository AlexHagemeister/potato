"use client";

import { useMemo, useRef, useState } from "react";
import type { StreamingService } from "@/core/settings/profile";
import type { WatchRegion } from "@/core/tmdb/regions";
import { changeCountryAction, saveServicesAction } from "./actions";

interface Props {
  initialCountry: string;
  initialProviderIds: number[];
  countries: WatchRegion[];
  initialServices: StreamingService[];
}

/**
 * Country and streaming services. Each change saves at once (no Save button),
 * like an iOS settings screen. The selection updates on tap and rolls back if
 * the save fails. Server actions from one page run one at a time, in order, so
 * the last tap's set is what ends up saved.
 */
export function SettingsForm({ initialCountry, initialProviderIds, countries, initialServices }: Props) {
  const [country, setCountry] = useState(initialCountry);
  const [services, setServices] = useState(initialServices);
  const [selected, setSelected] = useState<number[]>(initialProviderIds);
  const [query, setQuery] = useState("");
  const [loadingServices, setLoadingServices] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countryRequest = useRef(0);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? services.filter((s) => s.name.toLowerCase().includes(q)) : services;
  }, [services, query]);

  // Saved services that this country lists, in the list's order.
  const selectedHere = useMemo(() => services.filter((s) => selected.includes(s.id)), [services, selected]);

  async function onCountryChange(next: string) {
    const previous = country;
    const request = ++countryRequest.current;
    setCountry(next);
    setError(null);
    setLoadingServices(true);
    const result = await changeCountryAction(next);
    if (request !== countryRequest.current) return; // a newer pick superseded this one
    setLoadingServices(false);
    if (result.ok) {
      setServices(result.value);
      setQuery("");
    } else {
      setCountry(previous);
      setError(result.error);
    }
  }

  async function toggle(id: number) {
    const previous = selected;
    const next = previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id];
    setSelected(next);
    setError(null);
    const result = await saveServicesAction(next);
    if (!result.ok) {
      setSelected(previous);
      setError(result.error);
    }
  }

  return (
    <>
      <section className="mb-8">
        <h2 className="mb-2 px-1 text-xs font-semibold tracking-wide text-muted uppercase">Country</h2>
        <label className="flex min-h-12 items-center justify-between gap-3 rounded-2xl bg-surface px-4">
          <span>Country</span>
          <select
            aria-label="Country"
            value={country}
            onChange={(e) => onCountryChange(e.target.value)}
            className="min-w-0 appearance-none truncate bg-transparent py-3 text-right text-muted outline-none"
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="-ml-1 shrink-0 text-muted">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </label>
      </section>

      <section aria-labelledby="services-heading" className="mb-2">
        <div className="mb-2 flex items-baseline justify-between px-1">
          <h2 id="services-heading" className="text-xs font-semibold tracking-wide text-muted uppercase">
            Streaming services
          </h2>
          <span className="text-xs text-muted" aria-live="polite">
            {selectedHere.length === 0 ? "None selected" : `${selectedHere.length} selected`}
          </span>
        </div>

        {selectedHere.length > 0 && (
          <ul aria-label="Your services" className="mb-3 flex flex-wrap gap-2 px-1">
            {selectedHere.map((s) => (
              <li key={s.id}>
                <ServiceLogo service={s} size={32} />
              </li>
            ))}
          </ul>
        )}

        <input
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Search services"
          aria-label="Search services"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-3 h-11 w-full rounded-xl bg-surface px-4 outline-none placeholder:text-muted"
        />

        {error && (
          <p role="alert" className="mb-3 px-1 text-sm text-red-400">
            {error}
          </p>
        )}

        <div className={loadingServices ? "opacity-40 transition-opacity" : "transition-opacity"} aria-busy={loadingServices}>
          {visible.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted">
              {services.length === 0 ? "No streaming data for this country." : "No services match."}
            </p>
          ) : (
            <ul className="overflow-hidden rounded-2xl bg-surface">
              {visible.map((s) => {
                const on = selected.includes(s.id);
                return (
                  <li key={s.id} className="border-b border-hairline last:border-b-0">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggle(s.id)}
                      className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left"
                    >
                      <ServiceLogo service={s} size={36} />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <Check on={on} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="mt-2 px-1 text-xs text-muted">Streaming data from JustWatch.</p>
      </section>
    </>
  );
}

function ServiceLogo({ service, size }: { service: StreamingService; size: number }) {
  if (!service.logoUrl) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-lg bg-surface-raised text-xs font-semibold"
      >
        {service.name.slice(0, 1)}
      </span>
    );
  }
  return (
    // TMDB serves logos at fixed sizes already, so next/image adds nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={service.logoUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="shrink-0 rounded-lg"
      style={{ width: size, height: size }}
    />
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
        on ? "border-accent bg-accent text-black" : "border-hairline"
      }`}
    >
      {on && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 5 5 9-10" />
        </svg>
      )}
    </span>
  );
}
