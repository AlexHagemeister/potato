"use server";

// The Search tab's one server action. Thin glue (CLAUDE.md rule 3): it
// resolves the user from the session cookie, never from client input, and
// calls core, which checks the titles. It reads; it writes nothing.
//
// A server action, unlike the search itself (/api/search): a page's actions
// run one at a time, in order, so a read sent on Back from a title card waits
// behind a sort that card sent, and sees it.

import { getSearchStatuses, type SearchStatus } from "@/core/search";
import { getCurrentUserForRequest } from "@/lib/current-user";

/** Null when the read failed (signed out, bad input, the database): the screen then searches afresh. */
export async function readSearchStatuses(titles: unknown): Promise<SearchStatus[] | null> {
  const user = await getCurrentUserForRequest();
  if (!user) return null;
  try {
    const result = await getSearchStatuses(user.id, titles);
    if (result.ok) return result.value;
    console.error("search: getSearchStatuses refused:", result.error);
    return null;
  } catch (err) {
    console.error("search: getSearchStatuses failed:", err);
    return null;
  }
}
