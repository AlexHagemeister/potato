"use client";

import Link from "next/link";
import { useState } from "react";
import {
  DEFAULT_FILTER_CHOICE,
  ERA_CHOICES,
  ERA_LABELS,
  MIN_RATING_CHOICES,
  MIN_RATING_LABELS,
  TYPE_CHOICES,
  TYPE_LABELS,
  describeFilterChoice,
  genresFor,
  isDefaultFilterChoice,
  normalizeFilterChoice,
  sameFilterChoice,
  type FilterChoice,
} from "@/core/filters";

export interface FilterControlProps {
  /** The applied filters. */
  value: FilterChoice;
  /** Called once, when the sheet closes with a changed choice. */
  onChange: (next: FilterChoice) => void;
  /** Whether the user has picked any streaming services in Profile. Without them, "On my services" can match nothing. */
  hasServices: boolean;
  /** Dims the button while the new filters load. */
  busy?: boolean;
  /** The button alone, for a header row (Discover). The screen shows what is applied itself. */
  compact?: boolean;
}

/**
 * The filter control shared by Discover and Lists (VISION "Shaping the deck"):
 * a compact row with a Filters button and what is applied, and a full-screen
 * sheet to change it. The sheet edits a draft and applies it once, on Done,
 * so the deck or the lists reload once per change, not once per tap.
 */
export function FilterControl({ value, onChange, hasServices, busy = false, compact = false }: FilterControlProps) {
  const [draft, setDraft] = useState<FilterChoice | null>(null);
  const applied = describeFilterChoice(value);

  function close(next: FilterChoice) {
    setDraft(null);
    if (!sameFilterChoice(next, value)) onChange(normalizeFilterChoice(next));
  }

  return (
    <div data-slot="filters" className={compact ? "flex shrink-0 items-center" : "mb-3 flex min-h-11 items-center gap-2"}>
      <button
        type="button"
        onClick={() => setDraft(normalizeFilterChoice(value))}
        aria-haspopup="dialog"
        aria-label={applied.length ? `Filters, ${applied.length} on: ${applied.join(", ")}` : "Filters, none on"}
        className={`flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold ${
          applied.length ? "bg-accent text-black" : "bg-surface-raised"
        } ${busy ? "opacity-60" : ""}`}
      >
        <FilterIcon />
        Filters
        {applied.length > 0 && (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-black/80 px-1 text-xs text-accent">
            {applied.length}
          </span>
        )}
      </button>
      {applied.length > 0 && !compact && (
        <p className="min-w-0 truncate text-sm text-muted" aria-hidden="true">
          {applied.join(" · ")}
        </p>
      )}

      {draft && <FilterSheet draft={draft} setDraft={setDraft} hasServices={hasServices} onDone={close} />}
    </div>
  );
}

function FilterSheet({
  draft,
  setDraft,
  hasServices,
  onDone,
}: {
  draft: FilterChoice;
  setDraft: (c: FilterChoice) => void;
  hasServices: boolean;
  onDone: (c: FilterChoice) => void;
}) {
  // Every edit goes through core's normalizer, so a genre that doesn't exist for the new type drops out.
  const edit = (patch: Partial<FilterChoice>) => setDraft(normalizeFilterChoice({ ...draft, ...patch }));
  const toggleGenre = (key: string) =>
    edit({ genres: draft.genres.includes(key) ? draft.genres.filter((g) => g !== key) : [...draft.genres, key] });
  // With no services the switch can only be turned off (a link may have turned it on).
  const servicesLocked = !hasServices && !draft.onMyServices;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="filter-sheet-heading"
      className="sheet-in fixed inset-0 z-50 flex flex-col bg-background"
    >
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-hairline px-2 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          onClick={() => setDraft({ ...DEFAULT_FILTER_CHOICE, genres: [] })}
          disabled={isDefaultFilterChoice(draft)}
          className="h-14 justify-self-start px-3 text-accent disabled:text-muted"
        >
          Reset
        </button>
        <h2 id="filter-sheet-heading" className="text-base font-semibold">
          Filters
        </h2>
        <button type="button" onClick={() => onDone(draft)} className="h-14 justify-self-end px-3 font-semibold text-accent">
          Done
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <Section label="Type">
          <Segmented label="Type" choices={TYPE_CHOICES} labels={TYPE_LABELS} value={draft.type} onChange={(type) => edit({ type })} />
        </Section>

        <Section label="Genre" note="Any of these">
          <div className="flex flex-wrap gap-2">
            {genresFor(draft.type).map((g) => (
              <Chip key={g.key} on={draft.genres.includes(g.key)} onClick={() => toggleGenre(g.key)}>
                {g.label}
              </Chip>
            ))}
          </div>
        </Section>

        <Section label="Era">
          <div role="radiogroup" aria-label="Era" className="flex flex-wrap gap-2">
            {ERA_CHOICES.map((e) => (
              <Chip key={e} role="radio" on={draft.era === e} onClick={() => edit({ era: e })}>
                {ERA_LABELS[e]}
              </Chip>
            ))}
          </div>
        </Section>

        <Section label="IMDb rating" note="At least">
          <Segmented
            label="Minimum IMDb rating"
            choices={MIN_RATING_CHOICES}
            labels={MIN_RATING_LABELS}
            value={draft.minRating}
            onChange={(minRating) => edit({ minRating })}
          />
        </Section>

        <Section label="Streaming">
          <button
            type="button"
            role="switch"
            aria-checked={draft.onMyServices}
            disabled={servicesLocked}
            onClick={() => edit({ onMyServices: !draft.onMyServices })}
            className="flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-2 text-left disabled:text-muted"
          >
            <span>
              <span className="block font-medium">On my services</span>
              <span className="block text-sm text-muted">Only titles you can stream on a service you use</span>
            </span>
            <span
              aria-hidden="true"
              className={`relative h-8 w-13 shrink-0 rounded-full transition-colors ${
                draft.onMyServices ? "bg-accent" : "bg-surface-raised"
              }`}
            >
              <span
                className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-[left] ${
                  draft.onMyServices ? "left-6" : "left-1"
                }`}
              />
            </span>
          </button>
          {!hasServices && (
            <p className="mt-2 px-1 text-sm text-muted">
              You haven&apos;t picked your services yet.{" "}
              <Link href="/profile" className="font-semibold text-accent" onClick={() => onDone(draft)}>
                Pick them in Profile
              </Link>
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}

/** Grid column classes by choice count, written out so Tailwind sees each class. */
const SEGMENT_COLUMNS: Record<number, string> = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };

/** A one-of-N control drawn as equal segments in one row (Type, minimum IMDb rating). */
function Segmented<T extends string>({
  label,
  choices,
  labels,
  value,
  onChange,
}: {
  label: string;
  choices: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`grid ${SEGMENT_COLUMNS[choices.length] ?? "grid-flow-col auto-cols-fr"} gap-1 rounded-xl bg-surface p-1`}>
      {choices.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          onClick={() => onChange(c)}
          className={`h-11 rounded-lg text-sm font-semibold ${value === c ? "bg-surface-raised text-foreground" : "text-muted"}`}
        >
          {labels[c]}
        </button>
      ))}
    </div>
  );
}

function Section({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="mb-2 flex items-baseline gap-2 px-1 text-xs font-semibold tracking-wide text-muted uppercase">
        {label}
        {note && <span className="font-normal tracking-normal normal-case">{note}</span>}
      </h3>
      {children}
    </section>
  );
}

function Chip({
  on,
  onClick,
  role,
  children,
}: {
  on: boolean;
  onClick: () => void;
  role?: "radio";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "radio" ? on : undefined}
      aria-pressed={role === "radio" ? undefined : on}
      onClick={onClick}
      className={`h-11 rounded-full px-4 text-sm font-medium ${on ? "bg-accent text-black" : "bg-surface-raised text-foreground"}`}
    >
      {children}
    </button>
  );
}

function FilterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M2 4h12M4.5 8h7M7 12h2" />
    </svg>
  );
}
