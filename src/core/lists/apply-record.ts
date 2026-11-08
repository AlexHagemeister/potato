// Where a changed title's row goes in lists a screen already shows (issues 93 and 110). A title card changes a title
// while the Lists tab is out of view, and Back shows the Lists rows kept on the phone. Applying the card's saved row
// to them makes Back show where the title is now at once, without waiting for a server read.

import { compareKeys, decodeCursor, updatedSortKey } from "../library/list";
import { DEFAULT_LIST_SORT, type TitleRecord } from "../library/types";
import { formatTitleKey } from "../title-id";
import { LIST_STATUSES, type ListStatus, type TitleId } from "../types";
import type { ListRow } from "./lists";

/**
 * The lists with `record`, the title's row as it is now, applied to the row they show for `ref`.
 *
 * - Still on the same list: the row takes the new rating, review, and time in place, as an edit on the Lists tab does.
 * - On another list: the row goes where that list's order puts it, newest change first (getListRows reads lists in
 *   DEFAULT_LIST_SORT). A fresh move lands on top. An Undo, which restores the earlier time, lands back where it was.
 *   A place past the list's cursor, while it has more pages, is left to Show more, which reads from the server.
 * - Skipped, or no row at all (`record` null): the row leaves the lists. A skipped title is on no list.
 *
 * `known` is a row these lists showed for the title earlier and dropped (a Skip, or Remove rating). When the lists
 * don't show the title now, it supplies the title, year, and poster, so an Undo can put the row back.
 *
 * Returns `lists` itself exactly when nothing could be applied: the lists don't show the title and no `known` row was
 * given. A row is never invented, since its title and poster come from a server read.
 */
export function applyTitleRecord<L extends { rows: ListRow[]; nextCursor: string | null }>(
  lists: Record<ListStatus, L>,
  ref: TitleId,
  record: TitleRecord | null,
  known?: ListRow | null,
): Record<ListStatus, L> {
  const key = formatTitleKey(ref);
  // One pass: where the title is now, and every list without it (a title has one row, so this never shows it twice).
  const out = { ...lists };
  let from: { status: ListStatus; index: number; row: ListRow } | null = null;
  for (const status of LIST_STATUSES) {
    const index = lists[status].rows.findIndex((r) => formatTitleKey(r) === key);
    if (index === -1) continue;
    from ??= { status, index, row: lists[status].rows[index] };
    out[status] = { ...lists[status], rows: lists[status].rows.filter((_, i) => i !== index) };
  }
  const base = from?.row ?? (known && formatTitleKey(known) === key ? known : null);
  if (!base) return lists;
  if (!record || !(LIST_STATUSES as readonly string[]).includes(record.status)) return out;

  const to = record.status as ListStatus;
  const next: ListRow = { ...base, status: to, rating: record.rating, review: record.review, updatedAt: record.updatedAt };
  const rows = out[to].rows;
  let at = from?.status === to ? from.index : -1;
  if (at === -1) {
    const nextKey = updatedSortKey(next);
    at = rows.findIndex((r) => compareKeys(nextKey, updatedSortKey(r), DEFAULT_LIST_SORT) < 0);
    if (at === -1) {
      // After every row shown. It still belongs at the end when it sorts no later than the list's cursor, since Show
      // more reads only past the cursor (an Undo can restore the very row the cursor names). Past it, Show more
      // brings it.
      const cursor = out[to].nextCursor === null ? null : decodeCursor(out[to].nextCursor);
      const loaded =
        out[to].nextCursor === null ||
        (cursor?.sort === DEFAULT_LIST_SORT && compareKeys(nextKey, cursor.values, DEFAULT_LIST_SORT) <= 0);
      if (!loaded) return out;
      at = rows.length;
    }
  }
  out[to] = { ...out[to], rows: [...rows.slice(0, at), next, ...rows.slice(at)] };
  return out;
}
