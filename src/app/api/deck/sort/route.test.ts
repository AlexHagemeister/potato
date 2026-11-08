import { beforeEach, describe, expect, mock, test } from "bun:test";

// The routes are glue: they read the body and hand it to the deck's action functions (which call core). The
// actions are stubbed here, so these tests need no database or session.
const calls: { fn: string; args: unknown[] }[] = [];
mock.module("@/app/(app)/_deck/actions", () => ({
  sortDeckCardAction: async (...args: unknown[]) => {
    calls.push({ fn: "sort", args });
    return { ok: false, error: "Already on your Passed list.", stale: true };
  },
  saveDeckChoiceAction: async (...args: unknown[]) => {
    calls.push({ fn: "choice", args });
    return { ok: true };
  },
}));

const sortRoute = await import("./route");
const choiceRoute = await import("../choice/route");

function post(body: string, contentType = "application/json"): Request {
  return new Request("http://localhost/api/deck/x", { method: "POST", headers: { "Content-Type": contentType }, body });
}

beforeEach(() => {
  calls.length = 0;
});

describe("POST /api/deck/sort", () => {
  test("hands the kind and title to the deck's sort and returns its result as is", async () => {
    const title = { mediaType: "movie", tmdbId: 603 };
    const res = await sortRoute.POST(post(JSON.stringify({ kind: "pass", title })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "Already on your Passed list.", stale: true });
    expect(calls).toEqual([{ fn: "sort", args: ["pass", title] }]);
  });

  test("refuses a body not sent as JSON, without saving", async () => {
    const res = await sortRoute.POST(post(JSON.stringify({ kind: "pass" }), "text/plain"));
    expect(res.status).toBe(415);
    expect((await res.json()).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("refuses a body that is not JSON, without saving", async () => {
    const res = await sortRoute.POST(post("{nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("POST /api/deck/choice", () => {
  test("hands the choice to the deck's choice save and returns its result", async () => {
    const choice = { mode: "blend", filters: {} };
    const res = await choiceRoute.POST(post(JSON.stringify({ choice })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ fn: "choice", args: [choice] }]);
  });

  test("refuses a body not sent as JSON, without saving", async () => {
    const res = await choiceRoute.POST(post("{}", "text/plain;charset=UTF-8"));
    expect(res.status).toBe(415);
    expect(calls).toEqual([]);
  });
});
