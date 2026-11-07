"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ActionOutcome, TitleRecord } from "@/core/library/types";
import type { ListRow, ListRowsPage } from "@/core/lists";
import { formatTitleKey } from "@/core/title-id";
import type { ListStatus, TitleId } from "@/core/types";
import { Poster } from "../_components/poster";
import { RatingSheet } from "../_components/rating-sheet";
import { Stars } from "../_components/stars";
import { Screen, ScreenTitle } from "../_shell/screen";
import {
  addToWatchlistAction,
  editRatingAction,
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

/** After a refresh: the pages to fetch again for each list, from the fresh first page's cursor. */
type Refill = Partial<Record<ListStatus, { cursor: string; have: number; want: number }>>;

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
}

type Sheet = { mode: "markSeen" | "edit"; row: ListRow };

export function ListsScreen({ lists: fromServer, initialList }: { lists: Record<ListStatus, ListRowsPage>; initialList: ListStatus }) {
  const router = useRouter();
  const [lists, setLists] = useState(() => toLists(fromServer));
  // A refresh (router.refresh after a stale write) brings new server data: start from it.
  // Rows past the first page (loaded with Show more) are fetched again, so the
  // refresh doesn't drop them.
  const [synced, setSynced] = useState(fromServer);
  const [refill, setRefill] = useState<Refill | null>(null);
  if (fromServer !== synced) {
    const fresh = toLists(fromServer);
    const want: Refill = {};
    for (const { status } of TABS) {
      const shown = lists[status].rows.length;
      const cursor = fresh[status].nextCursor;
      if (cursor && shown > fresh[status].rows.length) want[status] = { cursor, have: fresh[status].rows.length, want: shown };
    }
    setSynced(fromServer);
    setLists(fresh);
    setRefill(Object.keys(want).length > 0 ? want : null);
  }
  const [active, setActive] = useState(initialList);
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
        const job = refill[status];
        if (!job) continue;
        // Page by page, until the list shows as many rows as it did before the refresh.
        let cursor: string | null = job.cursor;
        let have = job.have;
        while (!cancelled && cursor && have < job.want) {
          const from: string = cursor;
          const result: ActionResult<ListRowsPage> = await call(() => loadMoreAction(status, from), LOAD_FAILED);
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
  const show = (message: string, undo?: () => Promise<void>) => setToast({ id: ++toastSeq.current, message, undo });

  /** A write failed. Say why, and reload the lists when the title changed elsewhere. */
  function failed(result: { error: string; stale?: boolean }) {
    show(result.error);
    if (result.stale) router.refresh();
  }

  function select(status: ListStatus) {
    setActive(status);
    // Keeps the chosen list across a reload, without a navigation.
    window.history.replaceState(null, "", status === "watchlist" ? "/lists" : `/lists?list=${status}`);
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
    setLists((prev) => insertAt(without(prev, "watchlist", key), "seen", moved, 0));
    setSheet(null);
    show("Moved to Seen", undoer(ref, result.value, (prev) => insertAt(without(prev, "seen", key), "watchlist", row, index)));
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
    show("Rating saved", undoer(ref, result.value, (prev) => replaced(prev, "seen", row)));
    return null;
  }

  async function addToWatchlist(row: ListRow) {
    const ref = refOf(row);
    const key = keyOf(row);
    const index = lists.passed.rows.findIndex((r) => keyOf(r) === key);
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
    show("Moved to Watchlist", undoer(ref, result.value, putBack));
  }

  async function showMore() {
    const status = active;
    const cursor = lists[status].nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const result = await call(() => loadMoreAction(status, cursor), LOAD_FAILED);
    setLoadingMore(false);
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

      {/* Filter controls go here: the next slice builds them, shared with Discover
          (VISION: "The filters that shape the deck also work on each list"). */}
      <div data-slot="list-filters" />

      <section id="list-panel" role="tabpanel" aria-labelledby={`list-tab-${active}`}>
        {current.rows.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="font-semibold">{EMPTY[active].title}</p>
            <p className="mt-1 text-sm text-muted">{EMPTY[active].note}</p>
          </div>
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

      {toast && (
        <div
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
