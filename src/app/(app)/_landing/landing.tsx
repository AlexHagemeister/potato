import type { ReactNode } from "react";
import { ChoiceIcon, choiceTone } from "./choice-icon";
import {
  BUILDS,
  BUILDS_FOOTNOTE,
  BUILDS_HEADING,
  CHOICES,
  CHOICES_HEADING,
  LEAD,
  TAGLINE,
} from "./copy";
import { ExampleCard } from "./example-card";

function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </h2>
  );
}

/**
 * What a signed-out visitor sees: what Potato is, an example card, the four
 * choices, and what builds up from them, with sign-in as the one action
 * (issue 145). Static: no database, no TMDB, no images but the app's own icon.
 *
 * `signIn` is the sign-in button. It is passed in, not imported, so this page
 * stays presentation only and renders in a test without the auth client. It
 * renders twice, and CSS shows one: on a phone it sits in a row pinned to the
 * bottom of the screen, outside the scroll area, so it is always on screen and
 * in thumb reach; on a wide window it sits under the tagline.
 *
 * It covers the whole screen, tab bar included, and scrolls inside itself
 * because the page body never scrolls (globals.css).
 */
export function Landing({ signIn }: { signIn: ReactNode }) {
  return (
    <main
      data-landing
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto grid w-full max-w-md grid-cols-1 gap-x-16 px-5 pt-[calc(env(safe-area-inset-top)+1.75rem)] pb-10 md:min-h-full md:max-w-5xl md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] md:content-center md:px-10 md:py-16">
          <header className="md:col-start-1">
            <div className="flex items-center gap-3">
              {/* The app's own icon, the same one on the home screen. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- a 192px local icon; next/image adds nothing */}
              <img src="/icons/icon-192.png" alt="" width={44} height={44} className="size-11 rounded-xl ring-1 ring-hairline" />
              <h1 className="text-[2.5rem] leading-none font-bold tracking-tight md:text-5xl">Potato</h1>
            </div>
            <p className="mt-5 text-[1.375rem] leading-snug font-semibold tracking-tight text-balance md:text-3xl">{TAGLINE}</p>
            <p className="mt-3 leading-relaxed text-pretty text-muted md:text-lg">{LEAD}</p>
          </header>

          <div className="hidden md:col-start-1 md:mt-8 md:flex md:flex-col md:items-start md:gap-2">{signIn}</div>

          <div className="mt-10 mb-4 md:col-start-2 md:row-span-4 md:row-start-1 md:my-0 md:self-center">
            <ExampleCard />
          </div>

          <section aria-labelledby="landing-choices" className="mt-10 md:col-start-1">
            <SectionHeading id="landing-choices">{CHOICES_HEADING}</SectionHeading>
            <ul className="grid gap-3 md:grid-cols-2 md:gap-x-6">
              {CHOICES.map((c) => (
                <li key={c.kind} className="flex items-center gap-3.5">
                  <span
                    aria-hidden
                    className={`flex size-12 shrink-0 items-center justify-center rounded-2xl bg-surface-raised ${choiceTone(c.kind)}`}
                  >
                    <ChoiceIcon kind={c.kind} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold">{c.label}</span>
                    <span className="block text-sm leading-snug text-muted">{c.words}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="landing-builds" className="mt-10 md:col-start-1">
            <SectionHeading id="landing-builds">{BUILDS_HEADING}</SectionHeading>
            <ul className="divide-y divide-hairline overflow-hidden rounded-2xl bg-surface">
              {BUILDS.map((b) => (
                <li key={b.label} className="px-4 py-3">
                  <span className="block font-semibold">{b.label}</span>
                  <span className="block text-sm leading-snug text-muted">{b.words}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm leading-snug text-muted">{BUILDS_FOOTNOTE}</p>
          </section>
        </div>
      </div>

      <div className="shrink-0 border-t border-hairline bg-bar px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:hidden">
        <div className="mx-auto flex max-w-md flex-col items-center gap-2 [&>button]:w-full">{signIn}</div>
      </div>
    </main>
  );
}
