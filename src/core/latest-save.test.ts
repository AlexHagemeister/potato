import { describe, expect, test } from "bun:test";
import { latestSave } from "./latest-save";

interface Result {
  ok: boolean;
}

/** A send whose answers the test releases by hand, in any order. */
function harness() {
  const sent: { value: string; answer: (r: Result) => Promise<void> }[] = [];
  const settled: [string, boolean][] = [];
  /** What the server holds: each ok answer stands for its write landing then. */
  let stored: string | null = null;
  const saves = latestSave<string, Result>(
    (value) =>
      new Promise<Result>((resolve) => {
        sent.push({
          value,
          answer: async (r) => {
            if (r.ok) stored = value;
            resolve(r);
            await ticks();
          },
        });
      }),
    (value, result) => settled.push([value, result.ok]),
  );
  return { saves, sent, settled, values: () => sent.map((s) => s.value), stored: () => stored };
}

/** Lets pending handlers (settle, the next send) run. */
async function ticks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const OK = { ok: true };
const FAIL = { ok: false };

describe("latestSave", () => {
  test("sends a lone value at once", () => {
    const { saves, values } = harness();
    saves.save("a");
    expect(values()).toEqual(["a"]);
  });

  test("one save on its way at a time; only the newest waiting value is sent next", async () => {
    const { saves, sent, settled, values } = harness();
    saves.save("a");
    saves.save("b");
    saves.save("c");
    expect(values()).toEqual(["a"]);
    await sent[0].answer(OK);
    expect(values()).toEqual(["a", "c"]);
    await sent[1].answer(OK);
    expect(values()).toEqual(["a", "c"]);
    expect(settled).toEqual([
      ["a", true],
      ["c", true],
    ]);
  });

  test("flush sends the waiting value without waiting for the save ahead of it, and only once", async () => {
    const { saves, sent, values } = harness();
    saves.save("a");
    saves.save("b");
    saves.flush();
    expect(values()).toEqual(["a", "b"]);
    saves.flush();
    await sent[0].answer(OK);
    await sent[1].answer(OK);
    expect(values()).toEqual(["a", "b"]);
  });

  test("flush with nothing waiting sends nothing", () => {
    const { saves, values } = harness();
    saves.save("a");
    saves.flush();
    saves.flush();
    expect(values()).toEqual(["a"]);
  });

  test("an older save answering after the newest succeeded sends the newest again", async () => {
    const { saves, sent, values } = harness();
    saves.save("a");
    saves.save("b");
    saves.flush();
    await sent[1].answer(OK);
    await sent[0].answer(OK);
    expect(values()).toEqual(["a", "b", "b"]);
    // The resend answering doesn't start another.
    await sent[2].answer(OK);
    expect(values()).toEqual(["a", "b", "b"]);
  });

  test("no resend when the older save failed (it never landed) or the newest failed", async () => {
    const one = harness();
    one.saves.save("a");
    one.saves.save("b");
    one.saves.flush();
    await one.sent[1].answer(OK);
    await one.sent[0].answer(FAIL);
    expect(one.values()).toEqual(["a", "b"]);

    const two = harness();
    two.saves.save("a");
    two.saves.save("b");
    two.saves.flush();
    await two.sent[1].answer(FAIL);
    await two.sent[0].answer(OK);
    expect(two.values()).toEqual(["a", "b"]);
  });

  test("no resend when the answers come back in order", async () => {
    const { saves, sent, values } = harness();
    saves.save("a");
    saves.save("b");
    saves.flush();
    await sent[0].answer(OK);
    await sent[1].answer(OK);
    expect(values()).toEqual(["a", "b"]);
  });

  test("no resend when a newer value is waiting: it follows anyway", async () => {
    const { saves, sent, values } = harness();
    saves.save("a");
    saves.save("b");
    saves.flush();
    await sent[1].answer(OK);
    saves.save("c");
    await sent[0].answer(OK);
    expect(values()).toEqual(["a", "b", "c"]);
  });

  test("after a flush, the next value waits for the flushed save too, and the newest is what lands", async () => {
    const { saves, sent, values, stored } = harness();
    saves.save("a");
    saves.save("b");
    saves.flush();
    saves.save("c");
    await sent[0].answer(OK);
    // A answered, but B (flushed) is still on its way: C must not go out yet.
    expect(values()).toEqual(["a", "b"]);
    await sent[1].answer(OK);
    expect(values()).toEqual(["a", "b", "c"]);
    await sent[2].answer(OK);
    expect(values()).toEqual(["a", "b", "c"]);
    expect(stored()).toBe("c");
  });

  test("after a flush, a value saved once both answered goes out at once", async () => {
    const { saves, sent, values } = harness();
    saves.save("a");
    saves.save("b");
    saves.flush();
    await sent[0].answer(OK);
    await sent[1].answer(OK);
    saves.save("c");
    await ticks();
    expect(values()).toEqual(["a", "b", "c"]);
  });

  test("clear forgets the saves on their way: an older answer after it sends nothing again", async () => {
    const { saves, sent, values } = harness();
    saves.save("a");
    saves.save("b");
    saves.flush();
    await sent[1].answer(OK);
    saves.clear();
    await sent[0].answer(OK);
    expect(values()).toEqual(["a", "b"]);
    // The next user's saves still go out.
    saves.save("c");
    await ticks();
    expect(values()).toEqual(["a", "b", "c"]);
  });

  test("clear drops the waiting value unsent", async () => {
    const { saves, sent, values } = harness();
    saves.save("a");
    saves.save("b");
    saves.clear();
    await sent[0].answer(OK);
    expect(values()).toEqual(["a"]);
    saves.save("c");
    expect(values()).toEqual(["a", "c"]);
  });

  test("a send that rejects anyway doesn't stop later saves", async () => {
    const sent: string[] = [];
    const saves = latestSave<string, Result>(
      (value) => {
        sent.push(value);
        return value === "a" ? Promise.reject(new Error("boom")) : Promise.resolve(OK);
      },
      () => {},
    );
    saves.save("a");
    saves.save("b");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(sent).toEqual(["a", "b"]);
  });
});
