"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SEARCH_QUERY_MAX_LENGTH } from "@/core/search/constants";
import { mergeSearchPages } from "@/core/search/merge";
import type { SearchPage, SearchResult } from "@/core/search/types";
import { formatTitleKey, parseTitleKey } from "@/core/title-id";
import type { TitleStatus } from "@/core/types";
import type { SearchResponse } from "@/app/api/search/route";
import { Poster } from "../_components/poster";
import { Screen, ScreenTitle } from "../_shell/screen";
import { getChangeVersion, getServerChangeVersion, subscribeTitleChanges, titlesChangedSince } from "../library-changes";
import { readSearchStatuses } from "./actions";

// The Search tab: a query box and a list of results, each opening the full
// card (VISION: Search). Results come from /api/search, which calls core. The
// query lives in the URL (?q=), so Back from a card and a reload come back to
// the same query. Back also comes back to the same rows (Show more pages
// included) and scroll position, kept in this module when a result is opened
// (#69). A reload, a new query, and Clear start from the first page. A row
// whose title was sorted since its results were read (on the card opened from
// it) shows no status until its status is read again (library-changes).

/** Wait this long after the last keystroke before searching. */
const DEBOUNCE_MS = 300;

const STATUS_WORDS: Record<TitleStatus, string> = {
  watchlist: "On Watchlist",
  passed: "Passed",
  seen: "Seen",
  skipped: "Skipped",
};

/** `version`: the change version (library-changes) the rows' statuses are at least as new as. */
type Results = { kind: "results"; page: SearchPage; results: SearchResult[]; more: "idle" | "loading" | "error"; version: number };

/** An answer from /api/search, with the query and attempt it answers. */
type Fetched = { query: string; attempt: number } & (Failed | Results);

/** `invalid`: core refused the query itself (too long), so trying again cannot help. */
type Failed = { kind: "error"; reason: "invalid" | "unavailable" };

type View = { kind: "idle" } | { kind: "loading" } | Failed | (Results & { stale?: boolean });

/**
 * The results showing when a result was opened, and where the list was scrolled, so Back from its card shows them
 * again (#69). One at a time: only the last opened result's screen comes back. It lives as long as the page does,
 * so a reload starts over.
 */
let kept: { results: Fetched & Results; scrollTop: number } | null = null;

/** The kept results, if they answer the query this screen arrived with and their statuses can be brought up to date. */
function keptFor(query: string): (Fetched & Results) | null {
  if (!kept || kept.results.query !== query || titlesChangedSince(kept.results.version) === null) return null;
  return { ...kept.results, attempt: 0, more: "idle" };
}

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

function ResultRow({ result, unsure }: { result: SearchResult; unsure: boolean }) {
  const type = result.mediaType === "movie" ? "Movie" : "Series";
  return (
    <li>
      <Link
        href={`/title/${result.mediaType}/${result.tmdbId}`}
        prefetch={false}
        data-title-key={`${result.mediaType}:${result.tmdbId}`}
        className="flex items-center gap-3 py-2"
      >
        <Poster url={result.posterUrl} title={`${result.title} poster`} width={56} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{result.title}</span>
          <span className="block text-sm text-muted">{[result.year, type].filter(Boolean).join(" · ")}</span>
          {result.status && !unsure && (
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

function MoreButton({ more, label, onClick }: { more: Results["more"]; label: string; onClick: () => Promise<void> }) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={more === "loading"}
      className="rounded-full bg-surface-raised px-6 py-3 font-medium disabled:opacity-50"
    >
      {more === "loading" ? "Loading…" : more === "error" ? "Couldn't load more. Try again" : label}
    </button>
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
  // Back from a result's card: the rows it was opened from, and where they were scrolled (#69).
  const [restored] = useState(() => {
    const results = keptFor(initialQuery.trim());
    return results && kept ? { results, scrollTop: kept.scrollTop } : null;
  });
  // The query the restored rows answer, until the box moves off it: its search is not run again. Any edit, Clear,
  // or navigation to another query drops it, so those search from the first page.
  const [restoredFor, setRestoredFor] = useState(restored?.results.query ?? null);
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
      setRestoredFor(null);
    }
  }
  // The pending URL write. A link tap cancels it, so a late write can't cancel the tap's navigation.
  const urlTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The last answer, and the query and attempt it answers.
  const [fetched, setFetched] = useState<Fetched | null>(restored?.results ?? null);
  // Bumped to search the same query again (Try again).
  const [attempt, setAttempt] = useState(0);
  const moreAbort = useRef<AbortController | null>(null);
  const trimmed = query.trim();
  const list = useRef<HTMLUListElement>(null);

  /** The box's text changed (typing, Clear). */
  function edit(next: string) {
    setQuery(next);
    if (next.trim() !== trimmed) setRestoredFor(null);
  }

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
  // Compared with what this screen last wrote, never with window.location: the location lags a replace that is
  // still rendering, so a Backspace inside that window would look already written and the URL would keep the
  // longer query.
  useEffect(() => {
    if (trimmed === written) return;
    const url = trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
    urlTimer.current = setTimeout(
      () => {
        setWritten(trimmed);
        router.replace(url, { scroll: false });
      },
      trimmed ? DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(urlTimer.current);
  }, [trimmed, written, router]);

  // Any link tapped (a result, a tab) cancels the pending write, so a late replace can't supersede its navigation.
  // The Search tab itself also clears the box (its URL may be the one already showing, so no render would), and
  // the tab's own navigation writes the empty URL, so no replace may race it for the history entry.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link) return;
      clearTimeout(urlTimer.current);
      const to = new URL(link.href);
      if (to.origin === window.location.origin && to.pathname === "/search" && !to.search) {
        setQuery("");
        setWritten("");
        setRestoredFor(null);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    moreAbort.current?.abort();
    if (!trimmed) return;
    // Back to rows kept for this query: they show already, so their search is not run again.
    if (trimmed === restoredFor && attempt === 0) return;
    // Each new query cancels the one before, so a slow answer can never replace a newer one.
    const controller = new AbortController();
    const timer = setTimeout(
      async () => {
        try {
          // Read before the search, so a sort that lands while it runs counts as newer than its statuses.
          const version = getChangeVersion();
          const body = await fetchResults(trimmed, 1, controller.signal);
          if (controller.signal.aborted) return;
          if (!body.ok && body.error === "signed_out") {
            window.location.reload();
            return;
          }
          setFetched(
            body.ok
              ? { query: trimmed, attempt, kind: "results", page: body.page, results: body.page.results, more: "idle", version }
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
  }, [trimmed, attempt, arrivedWith, restoredFor]);

  // A title sorted since the rows' statuses were read (on the card opened from a row; its save can land after
  // Back) shows no status until its status is read again, with no search and no TMDB call. If that read fails, or
  // the change log can't say which titles changed, the screen searches again from the first page, as a fresh visit
  // does.
  const changeVersion = useSyncExternalStore(subscribeTitleChanges, getChangeVersion, getServerChangeVersion);
  const shown = fetched?.kind === "results" ? fetched : null;
  const sinceRead = shown ? titlesChangedSince(shown.version) : null;
  const lost = shown !== null && sinceRead === null;
  const toRead = shown && sinceRead ? shown.results.map((r) => formatTitleKey(r)).filter((k) => sinceRead.has(k)) : [];
  const toReadKeys = toRead.join(" ");
  const shownQuery = shown?.query;
  const shownAttempt = shown?.attempt;
  useEffect(() => {
    if (shownQuery === undefined || (!lost && toReadKeys === "")) return;
    let live = true;
    const startOver = () => {
      if (!live) return;
      setRestoredFor(null);
      setAttempt((n) => n + 1);
      list.current?.closest("main")?.scrollTo({ top: 0 });
    };
    // Read before the action is sent: a sort that lands while it runs counts as newer.
    const version = getChangeVersion();
    const refs = toReadKeys.split(" ").flatMap((key) => parseTitleKey(key) ?? []);
    const read = lost ? Promise.resolve(null) : readSearchStatuses(refs).catch(() => null);
    void read.then((statuses) => {
      if (!live) return;
      if (!statuses) return startOver();
      const now = new Map(statuses.map((s) => [formatTitleKey(s), s.status]));
      setFetched((f) =>
        f?.kind === "results" && f.query === shownQuery && f.attempt === shownAttempt
          ? {
              ...f,
              results: f.results.map((r) => {
                const key = formatTitleKey(r);
                return now.has(key) ? { ...r, status: now.get(key) ?? null } : r;
              }),
              version: Math.max(f.version, version),
            }
          : f,
      );
    });
    return () => {
      live = false;
    };
  }, [shownQuery, shownAttempt, lost, toReadKeys, changeVersion]);

  // Back to kept rows puts the list where it was. The scroller is the shell's <main>.
  useLayoutEffect(() => {
    const main = list.current?.closest("main");
    if (main && restored) main.scrollTop = restored.scrollTop;
  }, [restored]);

  /** A result was tapped: keep what shows, so Back from its card comes back to it. */
  function keep() {
    const main = list.current?.closest("main");
    kept = answered && fetched.kind === "results" ? { results: fetched, scrollTop: main?.scrollTop ?? 0 } : null;
  }

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
            onChange={(e) => edit(e.target.value)}
            className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => edit("")} className="-mr-1 h-11 px-2 text-muted">
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
      {view.kind === "results" && view.results.length === 0 && view.page.page >= view.page.totalPages && (
        <Message title="No matches">Nothing found for &ldquo;{view.page.query}&rdquo;. Check the spelling, or try fewer words.</Message>
      )}
      {/* TMDB pages can hold only people (dropped), and core reads only a few pages per request (#46): later pages may still hold titles. */}
      {view.kind === "results" && view.results.length === 0 && view.page.page < view.page.totalPages && (
        <Message title="No movies or series yet" action={!view.stale && <MoreButton more={view.more} label="Keep looking" onClick={loadMore} />}>
          The results so far for &ldquo;{view.page.query}&rdquo; are all people.
        </Message>
      )}
      {view.kind === "results" && view.results.length > 0 && (
        <>
          <ul
            ref={list}
            onClick={(e) => {
              if (e.target instanceof Element && e.target.closest("a[href]")) keep();
            }}
            aria-label="Results"
            aria-busy={view.stale || undefined}
            className={`divide-y divide-hairline transition-opacity ${view.stale ? "opacity-50" : ""}`}
          >
            {view.results.map((r) => {
              const key = formatTitleKey(r);
              return <ResultRow key={key} result={r} unsure={sinceRead === null || sinceRead.has(key)} />;
            })}
          </ul>
          {!view.stale && view.page.page < view.page.totalPages && (
            <div className="mt-4 text-center">
              <MoreButton more={view.more} label="Show more" onClick={loadMore} />
            </div>
          )}
        </>
      )}
    </Screen>
  );
}
