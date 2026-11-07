"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { DEFAULT_FILTER_CHOICE, filterChoiceToParams, isDefaultFilterChoice, type FilterChoice } from "@/core/filters";
import type { ActionOutcome, TitleRecord } from "@/core/library/types";
import { listFromParam, type ListRow, type ListRowsPage } from "@/core/lists";
import { formatTitleKey } from "@/core/title-id";
import type { ListStatus, TitleId } from "@/core/types";
import { FilterControl } from "../_components/filter-control";
import { Poster } from "../_components/poster";
import { RatingSheet } from "../_components/rating-sheet";
import { Stars } from "../_components/stars";
import { Screen, ScreenTitle } from "../_shell/screen";
import {
  addToWatchlistAction,
  editRatingAction,
  loadListsAction,
  loadMoreAction,
  markSeenAction,
  undoAction,
  type ActionResult,
} from "./actions";

type ListState = { rows: ListRow[]; nextCursor: string | null };
type Lists = Record<ListStatus, ListState>;

/** The lists, in the order VISION names them under Navigation. */
const TABS: { status: ListStatus; label: string }[] = [
  { status: "watchlist", label: "Watchlist" },
  { status: "seen", label: "Seen" },
  { status: "passed", label: "Passed" },
];

const EMPTY: Record<ListStatus, { title: string; note: string }> = {
  watchlist: { title: "Nothing on your Watchlist yet", note: "Tap Watchlist on a card to save a title for later." },
  seen: { title: "Nothing rated yet", note: "Tap Seen it on a card, or mark a Watchlist title as seen." },
  passed: { title: "Nothing passed yet", note: "Titles you pass on land here." },
};

/** How long the Undo toast stays up. */
const TOAST_MS = 5000;

const keyOf = formatTitleKey;
const refOf = (t: TitleId): TitleId => ({ mediaType: t.mediaType, tmdbId: t.tmdbId });
const displayTitle = (row: ListRow) => row.title ?? "Title unavailable";
const subtitleOf = (row: ListRow) => [row.year, row.mediaType === "movie" ? "Movie" : "Series"].filter(Boolean).join(" · ");

const SAVE_FAILED = "Couldn't save. Try again.";
const LOAD_FAILED = "Couldn't load more. Try again.";
const FILTER_FAILED = "Couldn't load your lists. Try again.";

/**
 * After a reload: the pages to fetch again for each list, from the fresh first
 * page's cursor, under the filters the reload used.
 */
type Refill = {
  filters: FilterChoice;
  jobs: Partial<Record<ListStatus, { cursor: string; have: number; want: number }>>;
};

/**
 * Where the list's scroll position is kept, in the history entry's state. It is written as the screen is left by a
 * link (a row's card, a tab), so Back, and a reload, land on the same rows.
 */
const SCROLL_KEY = "potatoListsScroll";

/** Space between the Undo toast's top edge and a row it is kept clear of. */
const TOAST_CLEARANCE = 12;

/** The address for a list and filters, so a reload reopens both. */
function listsUrl(status: ListStatus, filters: FilterChoice): string {
  const params = new URLSearchParams(filterChoiceToParams(filters));
  if (status !== "watchlist") params.set("list", status);
  const query = params.toString();
  return query ? `/lists?${query}` : "/lists";
}

/**
 * Calls a server action and never rejects. A call that fails outright (offline,
 * a dropped connection) resolves as a failure with `outage` as its words, so
 * every caller handles one shape and rolls its screen state back.
 */
async function call<T>(action: () => Promise<ActionResult<T>>, outage = SAVE_FAILED): Promise<ActionResult<T>> {
  try {
    return await action();
  } catch {
    return { ok: false, error: outage };
  }
}

function toLists(pages: Record<ListStatus, ListRowsPage>): Lists {
  const out = {} as Lists;
  for (const { status } of TABS) out[status] = { rows: pages[status].rows, nextCursor: pages[status].nextCursor };
  return out;
}

// Screen-state helpers. They only move rows the server already returned
// between the three on-screen lists. Every rule lives in core.
function without(lists: Lists, status: ListStatus, key: string): Lists {
  return { ...lists, [status]: { ...lists[status], rows: lists[status].rows.filter((r) => keyOf(r) !== key) } };
}
function insertAt(lists: Lists, status: ListStatus, row: ListRow, index: number): Lists {
  const rows = lists[status].rows.filter((r) => keyOf(r) !== keyOf(row));
  const at = index < 0 || index > rows.length ? 0 : index;
  return { ...lists, [status]: { ...lists[status], rows: [...rows.slice(0, at), row, ...rows.slice(at)] } };
}
function replaced(lists: Lists, status: ListStatus, row: ListRow): Lists {
  return { ...lists, [status]: { ...lists[status], rows: lists[status].rows.map((r) => (keyOf(r) === keyOf(row) ? row : r)) } };
}
/** A list with the next page added, skipping rows it already shows. */
function appendPage(list: ListState, page: ListRowsPage): ListState {
  const have = new Set(list.rows.map(keyOf));
  return { rows: [...list.rows, ...page.rows.filter((r) => !have.has(keyOf(r)))], nextCursor: page.nextCursor };
}
/** The row as the server now holds it. */
function withRecord(row: ListRow, record: TitleRecord | null): ListRow {
  if (!record) return row;
  return { ...row, status: record.status as ListStatus, rating: record.rating, review: record.review, updatedAt: record.updatedAt };
}

interface Toast {
  id: number;
  message: string;
  undo?: () => Promise<void>;
  /** The row the toast is about (the one edited, or the one now in a moved row's place), kept clear of it. */
  keep?: string;
}

type Sheet = { mode: "markSeen" | "edit"; row: ListRow };

export function ListsScreen({
  lists: fromServer,
  initialList,
  filters: filtersFromServer,
  hasServices,
}: {
  lists: Record<ListStatus, ListRowsPage>;
  initialList: ListStatus;
  /** The filters the server loaded `lists` with (from the address). */
  filters: FilterChoice;
  hasServices: boolean;
}) {
  const router = useRouter();
  const [lists, setLists] = useState(() => toLists(fromServer));
  const [filters, setFilters] = useState(filtersFromServer);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  // The list and filters live in the address, so Back from a card and a reload restore exactly what was showing
  // (issue 67). A tab tap writes the address directly (see select), so after Back the router's copy of this page
  // can carry an older `initialList` than the address: the list comes from the address.
  const searchParams = useSearchParams();
  const [active, setActive] = useState(() => listFromParam(searchParams.get("list")));
  // A filter change is a router navigation to the new address, and its server render brings the filtered lists.
  const [filtering, startFiltering] = useTransition();
  const [refill, setRefill] = useState<Refill | null>(null);
  // New server data (a filter change, the Lists tab while on Lists, a refresh after a change on a card): start
  // from it, on the list and filters its address names.
  const [synced, setSynced] = useState(fromServer);
  // Counts list loads, so a slower, older load never overwrites a newer one,
  // or the server data a navigation brought in meanwhile.
  const loadSeq = useRef(0);
  useEffect(() => {
    loadSeq.current++;
  }, [synced]);
  if (fromServer !== synced) {
    setSynced(fromServer);
    setLists(toLists(fromServer));
    setActive(initialList);
    setFilters(filtersFromServer);
    setRefill(null);
  }
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Rows whose move hasn't saved yet. Their buttons stay disabled until it does.
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const setRowPending = (key: string, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  useEffect(() => {
    if (!refill) return;
    let cancelled = false;
    (async () => {
      for (const { status } of TABS) {
        const job = refill.jobs[status];
        if (!job) continue;
        // Page by page, until the list shows as many rows as it did before the reload.
        let cursor: string | null = job.cursor;
        let have = job.have;
        while (!cancelled && cursor && have < job.want) {
          const from: string = cursor;
          const result: ActionResult<ListRowsPage> = await call(
            () => loadMoreAction(status, from, refill.filters),
            LOAD_FAILED,
          );
          if (cancelled || !result.ok) break;
          const page: ListRowsPage = result.value;
          setLists((prev) => ({ ...prev, [status]: appendPage(prev[status], page) }));
          have += page.rows.length;
          cursor = page.nextCursor;
        }
      }
      if (!cancelled) setRefill(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [refill]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const toastSeq = useRef(0);
  const show = (message: string, undo?: () => Promise<void>, keep?: string) =>
    setToast({ id: ++toastSeq.current, message, undo, keep });

  // The toast sits over the bottom of the list (issue 68). The spacer below the list leaves room to scroll any
  // row clear of it, and the row the toast is about is scrolled clear as it appears, so a saved rating or the
  // next row's button is never left under it.
  const panel = useRef<HTMLElement>(null);
  const toastEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const main = panel.current?.closest("main");
    if (!toast?.keep || !main || !toastEl.current) return;
    const row = [...main.querySelectorAll<HTMLElement>("li[data-title-key]")].find((li) => li.dataset.titleKey === toast.keep);
    if (!row) return;
    const overlap = row.getBoundingClientRect().bottom - (toastEl.current.getBoundingClientRect().top - TOAST_CLEARANCE);
    if (overlap <= 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    main.scrollBy({ top: overlap, behavior: reduce ? "auto" : "smooth" });
  }, [toast]);

  // Back to this screen (or a reload) puts the list where it was. The rows are the router's copy of the page as
  // it was left, so the position fits them. Rows added with Show more aren't in that copy.
  useLayoutEffect(() => {
    const main = panel.current?.closest("main");
    if (!main) return;
    const saved = (window.history.state as Record<string, unknown> | null)?.[SCROLL_KEY];
    if (typeof saved === "number") main.scrollTop = saved;
    const save = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("a[href]")) return;
      try {
        // Next's own state rides along (it carries `__NA`), so Next passes this write straight through.
        window.history.replaceState({ ...window.history.state, [SCROLL_KEY]: main.scrollTop }, "");
      } catch {
        // Safari limits history writes. Losing the position is harmless.
      }
    };
    document.addEventListener("click", save, true);
    return () => document.removeEventListener("click", save, true);
  }, []);

  /** A write failed. Say why, and reload the lists when the title changed elsewhere. */
  function failed(result: { error: string; stale?: boolean }) {
    show(result.error);
    if (result.stale) void reload();
  }

  /**
   * Loads the first page of every list again under the current filters. Rows
   * past the first page (loaded with Show more) are fetched again, so the
   * reload doesn't drop them.
   */
  async function reload() {
    const seq = ++loadSeq.current;
    // The latest filters, not this closure's: a write can come back stale after the filters changed.
    const using = filtersRef.current;
    const shown = lists;
    const result = await call(() => loadListsAction(using), FILTER_FAILED);
    if (seq !== loadSeq.current) return;
    if (!result.ok) return;
    const fresh = toLists(result.value);
    const jobs: Refill["jobs"] = {};
    for (const { status } of TABS) {
      const cursor = fresh[status].nextCursor;
      const want = shown[status].rows.length;
      if (cursor && want > fresh[status].rows.length) jobs[status] = { cursor, have: fresh[status].rows.length, want };
    }
    setLists(fresh);
    setRefill(Object.keys(jobs).length > 0 ? { filters: using, jobs } : null);
  }

  /** Goes to the address for a list and filters through the router, so its copy of this page holds both. */
  function navigate(status: ListStatus, using: FilterChoice) {
    startFiltering(() => router.replace(listsUrl(status, using), { scroll: false }));
  }

  /**
   * New filters from the control. The router goes to their address, and the page's server render brings all
   * three lists under them, so the rows and the address change together. The router's copy of the page, which
   * Back restores, then matches both.
   */
  function applyFilters(next: FilterChoice) {
    // A router fetch that fails falls back to a full page load, which offline is the browser's error page.
    if (!navigator.onLine) return show(FILTER_FAILED);
    setFilters(next);
    setRefill(null);
    navigate(active, next);
  }

  function select(status: ListStatus) {
    if (status === active) return;
    setActive(status);
    // While a filter change is on its way, the tab joins it: a direct write would cancel that navigation, and
    // the filters' rows would never arrive.
    if (filtering) return navigate(status, filters);
    // The rows don't depend on the list (all three are loaded), so a tab tap writes the address directly, with
    // no server render, and works offline like the rest of the screen. Back reads the list from the address.
    window.history.replaceState(null, "", listsUrl(status, filters));
  }

  /** Undo for a move or an edit: restore the row in core, then put the screen back. */
  function undoer(ref: TitleId, outcome: ActionOutcome, putBack: (lists: Lists) => Lists) {
    return async () => {
      setToast(null);
      const result = await call(() => undoAction(ref, outcome));
      // On failure nothing was undone, so the screen already matches the server.
      if (!result.ok) return failed(result);
      setLists(putBack);
    };
  }

  async function saveMarkSeen(row: ListRow, rating: number, review: string): Promise<string | null> {
    const ref = refOf(row);
    const key = keyOf(row);
    const result = await call(() => markSeenAction(ref, rating, review));
    if (!result.ok) {
      if (!result.stale) return result.error;
      setSheet(null);
      failed(result);
      return null;
    }
    const index = lists.watchlist.rows.findIndex((r) => keyOf(r) === key);
    const moved = withRecord(row, result.value.current);
    const next = lists.watchlist.rows[index + 1];
    setLists((prev) => insertAt(without(prev, "watchlist", key), "seen", moved, 0));
    setSheet(null);
    show(
      "Moved to Seen",
      undoer(ref, result.value, (prev) => insertAt(without(prev, "seen", key), "watchlist", row, index)),
      next && keyOf(next),
    );
    return null;
  }

  async function saveEdit(row: ListRow, rating: number, review: string): Promise<string | null> {
    const ref = refOf(row);
    const result = await call(() => editRatingAction(ref, rating, review));
    if (!result.ok) {
      if (!result.stale) return result.error;
      setSheet(null);
      failed(result);
      return null;
    }
    setLists((prev) => replaced(prev, "seen", withRecord(row, result.value.current)));
    setSheet(null);
    show("Rating saved", undoer(ref, result.value, (prev) => replaced(prev, "seen", row)), keyOf(row));
    return null;
  }

  async function addToWatchlist(row: ListRow) {
    const ref = refOf(row);
    const key = keyOf(row);
    const index = lists.passed.rows.findIndex((r) => keyOf(r) === key);
    const next = lists.passed.rows[index + 1];
    const putBack = (prev: Lists) => insertAt(without(prev, "watchlist", key), "passed", row, index);
    // Moves on tap, with the row's button disabled until the move saves. A failure puts the row back.
    setRowPending(key, true);
    setLists((prev) => insertAt(without(prev, "passed", key), "watchlist", { ...row, status: "watchlist" }, 0));
    const result = await call(() => addToWatchlistAction(ref));
    setRowPending(key, false);
    if (!result.ok) {
      setLists(putBack);
      return failed(result);
    }
    setLists((prev) => replaced(prev, "watchlist", withRecord(row, result.value.current)));
    show("Moved to Watchlist", undoer(ref, result.value, putBack), next && keyOf(next));
  }

  async function showMore() {
    const status = active;
    const cursor = lists[status].nextCursor;
    if (!cursor || loadingMore || filtering) return;
    // A cursor belongs to the filters that made it. If the lists reload meanwhile, this page is dropped.
    const seq = loadSeq.current;
    setLoadingMore(true);
    const result = await call(() => loadMoreAction(status, cursor, filters), LOAD_FAILED);
    setLoadingMore(false);
    if (seq !== loadSeq.current) return;
    if (!result.ok) return failed(result);
    const page = result.value;
    setLists((prev) => ({ ...prev, [status]: appendPage(prev[status], page) }));
  }

  const current = lists[active];

  return (
    <Screen>
      <ScreenTitle>Lists</ScreenTitle>

      <div role="tablist" aria-label="Lists" className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-surface p-1">
        {TABS.map((t) => (
          <button
            key={t.status}
            type="button"
            role="tab"
            id={`list-tab-${t.status}`}
            aria-selected={active === t.status}
            aria-controls="list-panel"
            onClick={() => select(t.status)}
            className={`h-11 rounded-lg text-sm font-semibold ${
              active === t.status ? "bg-surface-raised text-foreground" : "text-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* The deck's filters, applied to all three lists (VISION: "The filters that shape the deck also work on each list"). */}
      <div data-slot="list-filters">
        <FilterControl value={filters} onChange={applyFilters} hasServices={hasServices} busy={filtering} />
      </div>

      <section
        ref={panel}
        id="list-panel"
        role="tabpanel"
        aria-labelledby={`list-tab-${active}`}
        aria-busy={filtering}
        className={filtering ? "opacity-50 transition-opacity" : undefined}
      >
        {current.rows.length === 0 ? (
          isDefaultFilterChoice(filters) ? (
            <div className="px-6 py-16 text-center">
              <p className="font-semibold">{EMPTY[active].title}</p>
              <p className="mt-1 text-sm text-muted">{EMPTY[active].note}</p>
            </div>
          ) : (
            <div className="px-6 py-16 text-center">
              <p className="font-semibold">Nothing here matches your filters</p>
              {filters.onMyServices && !hasServices ? (
                <p className="mt-1 text-sm text-muted">
                  &ldquo;On my services&rdquo; needs your streaming services.{" "}
                  <Link href="/profile" className="font-semibold text-accent">
                    Pick them in Profile
                  </Link>
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted">Try fewer filters.</p>
              )}
              <button
                type="button"
                onClick={() => applyFilters({ ...DEFAULT_FILTER_CHOICE, genres: [] })}
                disabled={filtering}
                className="mt-4 h-11 rounded-full bg-surface-raised px-5 text-sm font-semibold"
              >
                Clear filters
              </button>
            </div>
          )
        ) : (
          <ul>
            {current.rows.map((row) => (
              <Row
                key={keyOf(row)}
                row={row}
                busy={pending.has(keyOf(row))}
                onMarkSeen={() => setSheet({ mode: "markSeen", row })}
                onEdit={() => setSheet({ mode: "edit", row })}
                onAddToWatchlist={() => addToWatchlist(row)}
              />
            ))}
          </ul>
        )}

        {current.nextCursor && (
          <button
            type="button"
            onClick={showMore}
            disabled={loadingMore || refill !== null}
            className="mt-4 h-11 w-full rounded-xl bg-surface font-medium disabled:text-muted"
          >
            {loadingMore || refill !== null ? "Loading…" : "Show more"}
          </button>
        )}
      </section>

      {/* Room to scroll the last row above the Undo toast: the toast and its gap over the tab bar, less the screen's own bottom padding. */}
      <div aria-hidden="true" data-slot="toast-room" className="h-14" />

      {toast && (
        <div
          ref={toastEl}
          role="status"
          className="fixed inset-x-4 z-40 flex min-h-12 items-center justify-between gap-3 rounded-2xl bg-surface-raised py-1 pr-1 pl-4 shadow-lg shadow-black/40"
          style={{ bottom: "calc(var(--tab-bar-height) + env(safe-area-inset-bottom) + 0.75rem)" }}
        >
          <span className="text-sm">{toast.message}</span>
          {toast.undo && (
            <button type="button" onClick={toast.undo} className="h-11 shrink-0 px-3 font-semibold text-accent">
              Undo
            </button>
          )}
        </div>
      )}

      {sheet && (
        <RatingSheet
          key={`${sheet.mode}:${keyOf(sheet.row)}`}
          heading={sheet.mode === "markSeen" ? "Mark as seen" : "Edit rating"}
          title={displayTitle(sheet.row)}
          subtitle={subtitleOf(sheet.row)}
          posterUrl={sheet.row.posterUrl}
          initialRating={sheet.mode === "edit" ? sheet.row.rating : null}
          initialReview={sheet.mode === "edit" ? sheet.row.review : null}
          onCancel={() => setSheet(null)}
          onSave={(rating, review) =>
            sheet.mode === "markSeen" ? saveMarkSeen(sheet.row, rating, review) : saveEdit(sheet.row, rating, review)
          }
        />
      )}
    </Screen>
  );
}

function Row({
  row,
  busy,
  onMarkSeen,
  onEdit,
  onAddToWatchlist,
}: {
  row: ListRow;
  /** The row's move is still saving: its button waits. */
  busy: boolean;
  onMarkSeen: () => void;
  onEdit: () => void;
  onAddToWatchlist: () => void;
}) {
  const title = displayTitle(row);
  return (
    <li className="flex items-center gap-3 border-b border-hairline py-3 last:border-b-0" data-title-key={keyOf(row)}>
      {/* The hook for the full card: /title/[mediaType]/[tmdbId]. The card screen builder owns that route. */}
      <Link href={`/title/${row.mediaType}/${row.tmdbId}`} prefetch={false} className="flex min-w-0 flex-1 items-center gap-3">
        <Poster url={row.posterUrl} title={title} width={56} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 leading-snug font-semibold">{title}</p>
          <p className="text-sm text-muted">{subtitleOf(row)}</p>
          {row.status === "seen" && row.rating !== null && (
            <p className="mt-1 flex items-center gap-1.5">
              <Stars rating={row.rating} size={14} />
            </p>
          )}
          {row.status === "seen" && row.review && <p className="mt-1 line-clamp-2 text-sm text-muted">{row.review}</p>}
        </div>
      </Link>
      {row.status === "watchlist" && (
        <RowButton label="Seen it" aria={`Mark ${title} as seen`} onClick={onMarkSeen} disabled={busy} />
      )}
      {row.status === "passed" && (
        <RowButton label="+ Watchlist" aria={`Move ${title} to Watchlist`} onClick={onAddToWatchlist} disabled={busy} />
      )}
      {row.status === "seen" && <RowButton label="Edit" aria={`Edit rating for ${title}`} onClick={onEdit} disabled={busy} />}
    </li>
  );
}

function RowButton({
  label,
  aria,
  onClick,
  disabled,
}: {
  label: string;
  aria: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      onClick={onClick}
      disabled={disabled}
      className="h-11 shrink-0 rounded-full bg-surface-raised px-4 text-sm font-semibold disabled:text-muted"
    >
      {label}
    </button>
  );
}
