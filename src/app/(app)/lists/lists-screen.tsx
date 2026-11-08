"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_FILTER_CHOICE,
  filterChoiceFromParams,
  filterChoiceToParams,
  isDefaultFilterChoice,
  sameFilterChoice,
  type FilterChoice,
} from "@/core/filters";
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

/** How long a filter load may take before it counts as failed, so a dead connection can't leave it hanging. */
const FILTER_TIMEOUT_MS = 15_000;

/** The action, or a rejection once FILTER_TIMEOUT_MS passes. */
function timed<T>(action: () => Promise<T>): () => Promise<T> {
  return () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), FILTER_TIMEOUT_MS);
    });
    return Promise.race([action(), timeout]).finally(() => clearTimeout(timer));
  };
}

/**
 * Writes the address for a list and filters, so Back from a card and a reload reopen both. Next's router takes the
 * new address without a server render, so it works offline. The rows on screen are this screen's own state, not the
 * router's copy of the page.
 */
function writeAddress(status: ListStatus, filters: FilterChoice) {
  window.history.replaceState(null, "", listsUrl(status, filters));
}

/**
 * Sets one key in the history entry's state. Next's own state rides along (it carries `__NA`), so Next passes the
 * write straight through and the address doesn't change.
 */
function keepHistoryState(key: string, value: number) {
  const state = window.history.state as Record<string, unknown> | null;
  if (!state || state[key] === value) return;
  try {
    window.history.replaceState({ ...state, [key]: value }, "");
  } catch {
    // Safari limits history writes. Losing the position is harmless.
  }
}

function toLists(pages: Record<ListStatus, ListRowsPage>): Lists {
  const out = {} as Lists;
  for (const { status } of TABS) out[status] = { rows: pages[status].rows, nextCursor: pages[status].nextCursor };
  return out;
}

/** The rows on screen, the filters they were loaded under, and whose they are. */
type Shown = { userId: string; filters: FilterChoice; lists: Lists };

/*
 * The rows the screen shows live here, at module scope, not in the component (issue 76). Back from a card mounts
 * the screen again from the router's copy of the page, which holds the rows of its server render and none of this
 * screen's changes since: an edited rating, Seen it, + Watchlist, an Undo, a filter change. So the screen takes its
 * rows from the server only for a render it hasn't shown yet. For a render it has shown (a copy Back restored), it
 * takes the rows it showed last, here. A save that settles after the screen is gone still lands here, and so does
 * the reload a stale save asks for, so Back shows them. A reload of the page starts the module over, from a fresh
 * server render. The rows belong to one user: another user's render starts them over, as in the deck's store.
 */
let shownNow: Shown | null = null;
/** The server renders of the page already shown, oldest first. Each fresh one replaces the rows above. */
const shownRenders = new Set<string>();
/**
 * How many render ids to keep. Back can restore only renders still in the browser's history, and a home-screen app
 * can stay open for days. A render forgotten here would show its server copy on Back, as before issue 76.
 */
const MAX_SHOWN_RENDERS = 50;

/** Notes a fresh render as shown, and starts the rows over from it. */
function seedShown(renderId: string, from: Shown) {
  if (shownNow && shownNow.userId !== from.userId) shownRenders.clear();
  shownRenders.add(renderId);
  while (shownRenders.size > MAX_SHOWN_RENDERS) shownRenders.delete(shownRenders.values().next().value as string);
  setShown(from);
}
const shownListeners = new Set<() => void>();

function subscribeShown(listener: () => void) {
  shownListeners.add(listener);
  return () => {
    shownListeners.delete(listener);
  };
}
const getShown = () => shownNow;
// The server never holds a user's rows between requests: it renders from the page's props.
const getServerShown = () => null;

function setShown(next: Shown) {
  shownNow = next;
  for (const listener of shownListeners) listener();
}

/** Changes the rows on screen. The rows' filters stay. */
function updateLists(change: (lists: Lists) => Lists) {
  if (shownNow) setShown({ ...shownNow, lists: change(shownNow.lists) });
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
  userId,
  renderId,
  lists: fromServer,
  filters: filtersFromServer,
  hasServices,
}: {
  /** The signed-in user. The rows kept for Back belong to one user (see shownNow). */
  userId: string;
  /** Names this server render. Back restores a render with the id it had (see shownNow). */
  renderId: string;
  lists: Record<ListStatus, ListRowsPage>;
  /** The filters the server loaded `lists` with (from the address it rendered). */
  filters: FilterChoice;
  hasServices: boolean;
}) {
  // The address names the list and the filters (issue 67). This screen writes it directly (writeAddress), so the
  // rows it shows can be for older filters than the address names (Back to an entry whose filters were changed).
  // Those rows are used only when they were loaded under the address's filters. Otherwise the screen loads the
  // rows for the address.
  const searchParams = useSearchParams();
  const addressList = listFromParam(searchParams.get("list"));
  const addressFilters = filterChoiceFromParams(searchParams);

  // The rows: the server's for a render not shown yet, else the ones this screen showed last (issue 76).
  const fromRender = useMemo<Shown>(
    () => ({ userId, filters: filtersFromServer, lists: toLists(fromServer) }),
    [userId, filtersFromServer, fromServer],
  );
  const stored = useSyncExternalStore(subscribeShown, getShown, getServerShown);
  const restored = stored !== null && stored.userId === userId && shownRenders.has(renderId);
  const shown = restored ? stored : fromRender;
  useEffect(() => {
    if (shownRenders.has(renderId) && shownNow?.userId === userId) return;
    seedShown(renderId, fromRender);
  }, [renderId, userId, fromRender]);
  const lists = shown.lists;
  // The filters the rows on screen were loaded under. A failed filter load falls back to them.
  const loaded = shown.filters;
  const shownFits = sameFilterChoice(loaded, addressFilters);
  // The filters the label shows: `loaded`, or the ones a running filter load is for.
  const [filters, setFilters] = useState(addressFilters);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  const [active, setActive] = useState(addressList);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  // A filter load to run (see the effect below): for a filter change, or on mount for the address's filters when
  // the rows have other filters. While it is set, the rows stay dimmed. If it fails, the screen goes back to
  // `fallback`, the filters of the rows it still shows.
  const [due, setDue] = useState<{ filters: FilterChoice; fallback: FilterChoice } | null>(() =>
    shownFits ? null : { filters: addressFilters, fallback: loaded },
  );
  const filtering = due !== null;
  const filteringRef = useRef(filtering);
  useEffect(() => {
    filteringRef.current = filtering;
  }, [filtering]);
  // A link on this screen was tapped, so a navigation away may be under way. A filter load that settles meanwhile
  // must not write the address: Next would take that write as a navigation and drop the one the tap started.
  const leaving = useRef(false);
  // A reload a stale write asked for while a filter load ran. It runs if that load fails.
  const reloadWanted = useRef(false);
  const [refill, setRefill] = useState<Refill | null>(null);
  // Counts list loads, so a slower, older load never overwrites a newer one,
  // or the server data a navigation brought in meanwhile. `restarts` counts the times the screen starts over.
  const loadSeq = useRef(0);
  const [restarts, setRestarts] = useState(0);
  useEffect(() => {
    loadSeq.current++;
    leaving.current = false;
  }, [restarts]);
  // Show more, a refill or a filter load that settles once the screen is gone changes nothing. A save still lands,
  // in the rows at module scope (updateLists), and so does the reload a stale save asks for, so Back shows them.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The render and address last seen. A new render (a refresh after a change on a card, the Lists tab while on
  // Lists, Back between two Lists entries) or an address this screen didn't write (the Lists tab while on Lists,
  // when Next reuses its copy of the page) starts the screen over on the list and filters the address names, with
  // the rows `shown` picks for the render.
  const addressKey = searchParams.toString();
  const [seen, setSeen] = useState({ renderId, address: addressKey });
  if (renderId !== seen.renderId || addressKey !== seen.address) {
    setSeen({ renderId, address: addressKey });
    const newRender = renderId !== seen.renderId;
    const sameFilters = sameFilterChoice(addressFilters, filters);
    // This screen's own writes name the list and filters it already shows.
    if (newRender || addressList !== active || !sameFilters) setActive(addressList);
    if (newRender || !sameFilters) {
      setFilters(addressFilters);
      setRefill(null);
      setDue(shownFits ? null : { filters: addressFilters, fallback: loaded });
      setRestarts((n) => n + 1);
    }
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
          updateLists((prev) => ({ ...prev, [status]: appendPage(prev[status], page) }));
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

  // Back to this screen (or a reload) puts the list where it was, once rows for the address show: at once when the
  // rows fit the address, or when the load for the address settles. The position is saved when a scroll
  // ends and when a link is tapped, so it is always the latest. (A write while the page unloads for a reload is not
  // kept, so it can't wait until then.) Back keeps rows added with Show more, but a reload doesn't fetch them again,
  // so after a reload a position past them clamps.
  const scrollDue = useRef<number | null | undefined>(undefined);
  useLayoutEffect(() => {
    const main = panel.current?.closest("main");
    if (!main) return;
    if (scrollDue.current === undefined) {
      const saved = (window.history.state as Record<string, unknown> | null)?.[SCROLL_KEY];
      scrollDue.current = typeof saved === "number" ? saved : null;
    }
    if (scrollDue.current === null || filtering) return;
    main.scrollTop = scrollDue.current;
    scrollDue.current = null;
  }, [lists, filtering]);

  useEffect(() => {
    const main = panel.current?.closest("main");
    if (!main) return;
    // A position not applied yet (rows for the address still loading) is still the one to keep.
    const save = () => keepHistoryState(SCROLL_KEY, typeof scrollDue.current === "number" ? scrollDue.current : main.scrollTop);
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("a[href]")) return;
      save();
      leaving.current = true;
    };
    // Once per scroll, after it settles: Safari limits how often history can be written.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!leaving.current) save();
      }, 250);
    };
    document.addEventListener("click", onClick, true);
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", onClick, true);
      main.removeEventListener("scroll", onScroll);
    };
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
    const here = mounted.current;
    // A filter load under way brings fresh lists if it succeeds. If it fails, it runs this reload then.
    if (here && filteringRef.current) {
      reloadWanted.current = true;
      return;
    }
    const seq = ++loadSeq.current;
    // On screen: the latest filters, not this closure's, since a write can come back stale after the filters
    // changed. After leaving (a stale save that settled late): the filters of the rows kept for Back.
    const using = here ? filtersRef.current : shownNow?.filters;
    const before = shownNow?.lists ?? lists;
    if (!using) return;
    const result = await call(() => loadListsAction(using), FILTER_FAILED);
    if (seq !== loadSeq.current || !result.ok) return;
    // The rows kept for Back can have moved on meanwhile (a fresh render, a filter load). Only rows for the same
    // user and filters land.
    if (!shownNow || shownNow.userId !== userId || !sameFilterChoice(shownNow.filters, using)) return;
    const fresh = toLists(result.value);
    const jobs: Refill["jobs"] = {};
    for (const { status } of TABS) {
      const cursor = fresh[status].nextCursor;
      const want = before[status].rows.length;
      if (cursor && want > fresh[status].rows.length) jobs[status] = { cursor, have: fresh[status].rows.length, want };
    }
    updateLists(() => fresh);
    // Rows past the first page are fetched again only on screen. After leaving, Back shows the first pages.
    if (mounted.current) setRefill(Object.keys(jobs).length > 0 ? { filters: using, jobs } : null);
  }

  /**
   * The filter load, for a filter change or for an address the rows don't fit. Wherever `due` is set,
   * the Filters label already shows its filters and the rows are dimmed. The address is written once the load
   * settles: with the new filters if it loaded, or with `fallback`, whose rows still show, if it failed. So the
   * address never names filters the rows don't have. The list in it is the one showing then, since a tab can be
   * tapped during the load. A load that is replaced, or outlives the screen, changes nothing.
   */
  useEffect(() => {
    if (!due) return;
    let cancelled = false;
    const seq = ++loadSeq.current;
    void (async () => {
      const result = await call(timed(() => loadListsAction(due.filters)), FILTER_FAILED);
      // A newer load, server data that fits the address, or leaving the screen took over.
      if (cancelled || seq !== loadSeq.current) return;
      setDue(null);
      filteringRef.current = false;
      const settled = result.ok ? due.filters : due.fallback;
      if (result.ok) {
        setShown({ userId, filters: due.filters, lists: toLists(result.value) });
      } else {
        setFilters(due.fallback);
        // Now, not after the next render: the deferred reload below reads it.
        filtersRef.current = due.fallback;
      }
      if (!leaving.current) writeAddress(activeRef.current, settled);
      if (result.ok) {
        reloadWanted.current = false;
        return;
      }
      show(result.error);
      if (reloadWanted.current) {
        reloadWanted.current = false;
        void reload();
      }
    })();
    return () => {
      cancelled = true;
    };
    // show and reload are recreated each render. Only a new `due` starts a load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due]);

  /** New filters from the control. If the load fails, the filters of the rows on screen come back. */
  function applyFilters(next: FilterChoice) {
    leaving.current = false;
    setFilters(next);
    setRefill(null);
    setDue({ filters: next, fallback: loaded });
  }

  function select(status: ListStatus) {
    if (status === active) return;
    leaving.current = false;
    setActive(status);
    // During a filter load, the address is written when the load settles, with this list.
    if (filtering) return;
    // The rows don't depend on the list (all three are loaded), so this needs no load and works offline.
    writeAddress(status, filters);
  }

  /** Undo for a move or an edit: restore the row in core, then put the screen back. */
  function undoer(ref: TitleId, outcome: ActionOutcome, putBack: (lists: Lists) => Lists) {
    return async () => {
      setToast(null);
      const result = await call(() => undoAction(ref, outcome));
      // On failure nothing was undone, so the screen already matches the server.
      if (!result.ok) return failed(result);
      updateLists(putBack);
    };
  }

  /**
   * A rating sheet's save refused because the title changed elsewhere (issue 79). The sheet stays open with the
   * message and what the user typed, so a review is still there to copy, and the lists reload behind it to show
   * where the title is now. Cancel closes it.
   */
  function refusedInSheet(result: { error: string }): string {
    void reload();
    return result.error;
  }

  async function saveMarkSeen(row: ListRow, rating: number, review: string): Promise<string | null> {
    const ref = refOf(row);
    const key = keyOf(row);
    const result = await call(() => markSeenAction(ref, rating, review));
    if (!result.ok) return result.stale ? refusedInSheet(result) : result.error;
    const index = lists.watchlist.rows.findIndex((r) => keyOf(r) === key);
    const moved = withRecord(row, result.value.current);
    const next = index >= 0 ? lists.watchlist.rows[index + 1] : undefined;
    updateLists((prev) => insertAt(without(prev, "watchlist", key), "seen", moved, 0));
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
    if (!result.ok) return result.stale ? refusedInSheet(result) : result.error;
    updateLists((prev) => replaced(prev, "seen", withRecord(row, result.value.current)));
    setSheet(null);
    show("Rating saved", undoer(ref, result.value, (prev) => replaced(prev, "seen", row)), keyOf(row));
    return null;
  }

  async function addToWatchlist(row: ListRow) {
    const ref = refOf(row);
    const key = keyOf(row);
    const index = lists.passed.rows.findIndex((r) => keyOf(r) === key);
    const next = index >= 0 ? lists.passed.rows[index + 1] : undefined;
    const putBack = (prev: Lists) => insertAt(without(prev, "watchlist", key), "passed", row, index);
    // Moves on tap, with the row's button disabled until the move saves. A failure puts the row back.
    setRowPending(key, true);
    updateLists((prev) => insertAt(without(prev, "passed", key), "watchlist", { ...row, status: "watchlist" }, 0));
    const result = await call(() => addToWatchlistAction(ref));
    setRowPending(key, false);
    if (!result.ok) {
      updateLists(putBack);
      return failed(result);
    }
    // The whole move again, not only the saved record: a fresh render read before the save landed can have started
    // the rows over meanwhile, with the title still on Passed.
    const saved = withRecord({ ...row, status: "watchlist" }, result.value.current);
    updateLists((prev) => {
      const at = prev.watchlist.rows.findIndex((r) => keyOf(r) === key);
      return insertAt(without(prev, "passed", key), "watchlist", saved, at);
    });
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
    if (seq !== loadSeq.current || !mounted.current) return;
    if (!result.ok) return failed(result);
    const page = result.value;
    updateLists((prev) => ({ ...prev, [status]: appendPage(prev[status], page) }));
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
