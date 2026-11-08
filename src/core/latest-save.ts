// Saves a value that only matters in its newest form (the Discover mode and
// filters): one save on its way at a time, and only the newest value waits
// behind it. A value made while a save is on its way replaces any value still
// waiting, since the newer one decides what is kept.
//
// flush() is for a page that is going away (issue 106). It sends the waiting
// value at once, without waiting for the save ahead of it, so it leaves the
// page before the page dies. The two saves then race. If the older one's
// answer comes back after the newer one succeeded, the older one may have
// landed last and overwritten it, so the newer value is sent once more (if
// the page is still alive to do it, and nothing newer waits).
//
// Pure TypeScript with no I/O of its own: the caller passes `send`, which
// does the request and must resolve (never reject) with its result.

export interface LatestSave<T> {
  /** A new value to save. It replaces any value still waiting. */
  save(value: T): void;
  /** Sends the waiting value now, even if a save is on its way. For a page that is going away. */
  flush(): void;
  /** Drops the waiting value unsent (the user changed). */
  clear(): void;
}

export function latestSave<T, R extends { ok: boolean }>(
  send: (value: T) => Promise<R>,
  settle: (value: T, result: R) => void,
): LatestSave<T> {
  let waiting: { value: T } | null = null;
  /** The loop that sends waiting values one at a time is running. */
  let draining = false;
  let sentCount = 0;
  /** The newest save sent, and whether its answer came back ok. */
  let newest: { n: number; value: T; ok: boolean | null } | null = null;

  async function sendOne(value: T): Promise<void> {
    const n = ++sentCount;
    const mine = { n, value, ok: null as boolean | null };
    newest = mine;
    let result: R;
    try {
      result = await send(value);
    } catch {
      // `send` must not reject. If it does, the save counts as failed with no result to report.
      mine.ok = false;
      return;
    }
    mine.ok = result.ok;
    settle(value, result);
    const latest = newest;
    // An older save answered after the newest one succeeded: it may have landed last. Send the newest again.
    if (latest !== mine && latest.ok === true && result.ok && !waiting) save(latest.value);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (waiting) {
        const { value } = waiting;
        waiting = null;
        await sendOne(value);
      }
    } finally {
      draining = false;
    }
  }

  function save(value: T) {
    waiting = { value };
    void drain();
  }

  return {
    save,
    flush() {
      if (!waiting) return;
      const { value } = waiting;
      waiting = null;
      void sendOne(value);
    },
    clear() {
      waiting = null;
    },
  };
}
