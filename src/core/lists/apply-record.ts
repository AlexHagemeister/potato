// Where a changed title's row goes in lists a screen already shows (issues 93 and 110). A title card changes a title
// while the Lists tab is out of view, and Back shows the Lists rows kept on the phone. Applying the card's saved row
// to them makes Back show where the title is now at once, without waiting for a server read.

import { compareKeys } from "../library/list";
import type { TitleRecord } from "../library/types";
import { formatTitleKey } from "../title-id";
import { LIST_STATUSES, type ListStatus, type TitleId } from "../types";
import type { ListRow } from "./lists";

/** The list order getListRows reads in (newest change first), as library/list's sortKey builds it for updated_desc. */
const orderKey = (row: ListRow) => [new Date(row.updatedAt).getTime(), row.mediaType, row.tmdbId];

/**
 * The lists with `record`, the title's row as it is now, applied to the row they show for `ref`.
 *
 * - Still on the same list: the row takes the new rating, review, and time in place, as an edit on the Lists tab does.
 * - On another list: the row goes where that list's order puts it, newest change first. A fresh move lands on top. An
 *   Undo, which restores the row's earlier time, lands back where it was. A place past the rows loaded so far, while
 *   the list has more pages, is left to Show more, which reads from the server.
 * - Skipped, or no row at all (`record` null): the row leaves the lists. A skipped title is on no list.
 *
 * Returns `lists` itself exactly when the lists don't show the title: a row is never invented, since its title and
 * poster come from a server read.
 */
export function applyTitleRecord<L extends { rows: ListRow[]; nextCursor: string | null }>(
  lists: Record<ListStatus, L>,
  ref: TitleId,
  record: TitleRecord | null,
): Record<ListStatus, L> {
  const key = formatTitleKey(ref);
  const from = LIST_STATUSES.find((status) => lists[status].rows.some((row) => formatTitleKey(row) === key));
  if (!from) return lists;
  const index = lists[from].rows.findIndex((row) => formatTitleKey(row) === key);
  const row = lists[from].rows[index];

  const out = { ...lists };
  // A title has one row, but drop any copy anywhere, so the move can never show it twice.
  for (const status of LIST_STATUSES) {
    if (lists[status].rows.some((r) => formatTitleKey(r) === key)) {
      out[status] = { ...lists[status], rows: lists[status].rows.filter((r) => formatTitleKey(r) !== key) };
    }
  }
  if (!record || !(LIST_STATUSES as readonly string[]).includes(record.status)) return out;
  const to = record.status as ListStatus;
  const next: ListRow = { ...row, status: to, rating: record.rating, review: record.review, updatedAt: record.updatedAt };
  const rows = out[to].rows;
  let at = index;
  if (to !== from) {
    at = rows.findIndex((r) => compareKeys(orderKey(next), orderKey(r), "updated_desc") < 0);
    if (at === -1) {
      if (out[to].nextCursor !== null) return out;
      at = rows.length;
    }
  }
  out[to] = { ...out[to], rows: [...rows.slice(0, at), next, ...rows.slice(at)] };
  return out;
}
