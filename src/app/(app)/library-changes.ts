// Tells screens kept on the phone that a write to a title landed, so they can read again (PR 135). Not a server
// module: it lives in the browser, for as long as the page does.
//
// A title screen can sit behind another one (a "You might also like" title opened from it), and a save can settle
// after Back has already brought the earlier screen up and its row has loaded. That row would keep showing the title
// just sorted, so each landed write counts here, and an open row reads again when the count moves.

import { formatTitleKey } from "@/core/title-id";
import type { TitleId } from "@/core/types";

let version = 0;
/** The title each landed write was for, by the count it raised the version to, newest last. */
const changedAt: { version: number; key: string }[] = [];
const MAX_CHANGES = 50;
const listeners = new Set<() => void>();

/**
 * A write to `ref` settled (or a refusal showed its row has changed), from any screen: a title card, the deck, or
 * Lists. A row read before it may still show the title.
 */
export function noteTitleChange(ref: TitleId) {
  version++;
  changedAt.push({ version, key: formatTitleKey(ref) });
  if (changedAt.length > MAX_CHANGES) changedAt.shift();
  for (const listener of listeners) listener();
}

export function subscribeTitleChanges(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const getChangeVersion = () => version;
// The server renders no change: every page starts at 0.
export const getServerChangeVersion = () => 0;

/**
 * The titles changed since `since` (a version read earlier), so a screen still showing what it read then can leave
 * them out until it has read again. Null when the log no longer reaches back that far: treat everything as changed.
 */
export function titlesChangedSince(since: number): ReadonlySet<string> | null {
  if (since >= version) return new Set();
  if (changedAt.length === 0 || changedAt[0]!.version > since + 1) return null;
  return new Set(changedAt.filter((c) => c.version > since).map((c) => c.key));
}
