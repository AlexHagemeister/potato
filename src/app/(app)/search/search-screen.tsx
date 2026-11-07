"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SEARCH_QUERY_MAX_LENGTH } from "@/core/search/constants";
import { mergeSearchPages } from "@/core/search/merge";
import type { SearchPage, SearchResult } from "@/core/search/types";
import type { TitleStatus } from "@/core/types";
import type { SearchResponse } from "@/app/api/search/route";
import { Poster } from "../_components/poster";
import { Screen, ScreenTitle } from "../_shell/screen";

// The Search tab: a query box and a list of results, each opening the full
// card (VISION: Search). Results come from /api/search, which calls core. The
// query lives in the URL (?q=), so Back from a card and a reload come back to
// the same results. Every visit fetches afresh, so a row's status reflects a
// tap just made on its card.

/** Wait this long after the last keystroke before searching. */
const DEBOUNCE_MS = 300;

const STATUS_WORDS: Record<TitleStatus, string> = {
  watchlist: "On Watchlist",
  passed: "Passed",
  seen: "Seen",
  skipped: "Skipped",
};

type Results = { kind: "results"; page: SearchPage; results: SearchResult[]; more: "idle" | "loading" | "error" };

/** An answer from /api/search, with the query and attempt it answers. */
type Fetched = { query: string; attempt: number } & (Failed | Results);

/** `invalid`: core refused the query itself (too long), so trying again cannot help. */
type Failed = { kind: "error"; reason: "invalid" | "unavailable" };

type View = { kind: "idle" } | { kind: "loading" } | Failed | (Results & { stale?: boolean });

async function fetchResults(query: string, page: number, signal: AbortSignal): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set("page", String(page));
  try {
    const res = await fetch(`/api/search?${params}`, { cache: "no-store", signal });
    return (await res.json()) as SearchResponse;
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, error: "unavailable" };
  }
}

function ResultRow({ result, onOpen }: { result: SearchResult; onOpen: () => void }) {
  const type = result.mediaType === "movie" ? "Movie" : "Series";
  return (
    <li>
      <Link
        href={`/title/${result.mediaType}/${result.tmdbId}`}
        prefetch={false}
        onClick={onOpen}
        data-title-key={`${result.mediaType}:${result.tmdbId}`}
        className="flex items-center gap-3 py-2"
      >
        <Poster url={result.posterUrl} title={`${result.title} poster`} width={56} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{result.title}</span>
          <span className="block text-sm text-muted">{[result.year, type].filter(Boolean).join(" · ")}</span>
          {result.status && (
            <span data-status={result.status} className="mt-1 inline-block rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium">
              {STATUS_WORDS[result.status]}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

function Message({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 pt-16 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {children && <p className="mt-2 text-muted">{children}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <ul aria-label="Loading" aria-busy="true" className="animate-pulse">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="flex items-center gap-3 py-2">
          <span className="h-[84px] w-14 shrink-0 rounded-md bg-surface" />
          <span className="flex-1 space-y-2">
            <span className="block h-4 w-2/3 rounded bg-surface" />
            <span className="block h-3 w-1/3 rounded bg-surface" />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SearchScreen({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  // The query this screen arrived with. Later renders of the page carry newer ones (the URL follows the box),
  // and those must not restart the search.
  const [arrivedWith] = useState(initialQuery.trim());
  // The query in the URL as this screen last wrote it, and the last query a page render handed it.
  const [written, setWritten] = useState(initialQuery.trim());
  const [handed, setHanded] = useState(initialQuery);
  // Box and URL always agree. A page render whose query this screen did not write is a navigation (tapping the
  // Search tab while on results hands it "", Back or Forward hands it that entry's query): the box takes it.
  if (initialQuery !== handed) {
    setHanded(initialQuery);
    if (initialQuery.trim() !== written) {
      setQuery(initialQuery);
      setWritten(initialQuery.trim());
    }
  }
  // The pending URL write. A result tap cancels it, so a late write can't cancel the tap's navigation.
  const urlTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The last answer, and the query and attempt it answers.
  const [fetched, setFetched] = useState<Fetched | null>(null);
  // Bumped to search the same query again (Try again).
  const [attempt, setAttempt] = useState(0);
  const moreAbort = useRef<AbortController | null>(null);
  const trimmed = query.trim();

  const answered = fetched && fetched.query === trimmed && fetched.attempt === attempt;
  // While a new query is on its way, the last results stay up (dimmed), so typing doesn't flash a skeleton.
  const view: View = !trimmed
    ? { kind: "idle" }
    : answered
      ? fetched
      : fetched?.kind === "results"
        ? { ...fetched, stale: true }
        : { kind: "loading" };

  // The query goes into the URL through the router, so the router's own entry for this screen holds it, and Back
  // from a card comes back to the same query and results. Debounced like the search, so typing doesn't ask the
  // server for the page on every keystroke.
  useEffect(() => {
    const url = trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
    if (`${window.location.pathname}${window.location.search}` === url) return;
    urlTimer.current = setTimeout(
      () => {
        setWritten(trimmed);
        router.replace(url, { scroll: false });
      },
      trimmed ? DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(urlTimer.current);
  }, [trimmed, router]);

  useEffect(() => {
    moreAbort.current?.abort();
    if (!trimmed) return;
    // Each new query cancels the one before, so a slow answer can never replace a newer one.
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        try {
          const body = await fetchResults(trimmed, 1, controller.signal);
          if (controller.signal.aborted) return;
          if (!body.ok && body.error === "signed_out") {
            window.location.reload();
            return;
          }
          setFetched(
            body.ok
              ? { query: trimmed, attempt, kind: "results", page: body.page, results: body.page.results, more: "idle" }
              : { query: trimmed, attempt, kind: "error", reason: body.error === "invalid_search_query" ? "invalid" : "unavailable" },
          );
        } catch {
          // Aborted: a newer query took over.
        }
      },
      // The first search on arrival (a query from the URL) runs at once.
      attempt === 0 && trimmed === arrivedWith ? 0 : DEBOUNCE_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, attempt, arrivedWith]);

  async function loadMore() {
    if (!answered || fetched.kind !== "results" || fetched.more === "loading") return;
    const controller = new AbortController();
    moreAbort.current = controller;
    const current = fetched;
    setFetched({ ...current, more: "loading" });
    try {
      const body = await fetchResults(current.page.query, current.page.page + 1, controller.signal);
      if (controller.signal.aborted) return;
      if (!body.ok) {
        setFetched({ ...current, more: "error" });
        return;
      }
      setFetched({ ...current, page: body.page, results: mergeSearchPages(current.results, body.page.results), more: "idle" });
    } catch {
      // Aborted: the query changed.
    }
  }

  return (
    <Screen>
      <ScreenTitle>Search</ScreenTitle>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.blur();
        }}
        className="sticky top-0 z-10 -mx-4 bg-background px-4 pb-3"
      >
        <div className="flex items-center gap-2 rounded-xl bg-surface px-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-muted" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4.2-4.2" />
          </svg>
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            aria-label="Search movies and series"
            placeholder="Movies and series"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={SEARCH_QUERY_MAX_LENGTH}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="-mr-1 h-11 px-2 text-muted">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </form>

      {view.kind === "idle" && <Message title="Find any movie or series">Add it to your Watchlist, or rate something you just watched.</Message>}
      {view.kind === "loading" && <RowsSkeleton />}
      {view.kind === "error" && view.reason === "invalid" && (
        <Message title="That search is too long">Try a shorter title, up to {SEARCH_QUERY_MAX_LENGTH} characters.</Message>
      )}
      {view.kind === "error" && view.reason === "unavailable" && (
        <Message
          title="Search isn't working right now"
          action={
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded-full bg-surface-raised px-6 py-3 font-medium">
              Try again
            </button>
          }
        >
          The movie database didn&apos;t answer.
        </Message>
      )}
      {view.kind === "results" && view.results.length === 0 && (
        <Message title="No matches">Nothing found for &ldquo;{view.page.query}&rdquo;. Check the spelling, or try fewer words.</Message>
      )}
      {view.kind === "results" && view.results.length > 0 && (
        <>
          <ul aria-label="Results" aria-busy={view.stale || undefined} className={`divide-y divide-hairline transition-opacity ${view.stale ? "opacity-50" : ""}`}>
            {view.results.map((r) => (
              <ResultRow key={`${r.mediaType}:${r.tmdbId}`} result={r} onOpen={() => clearTimeout(urlTimer.current)} />
            ))}
          </ul>
          {!view.stale && view.page.page < view.page.totalPages && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={view.more === "loading"}
                className="rounded-full bg-surface-raised px-6 py-3 font-medium disabled:opacity-50"
              >
                {view.more === "loading" ? "Loading…" : view.more === "error" ? "Couldn't load more. Try again" : "Show more"}
              </button>
            </div>
          )}
        </>
      )}
    </Screen>
  );
}
