import { describe, expect, test } from "bun:test";
import { handleJsonPost, jsonPostRefusal } from "./json-post";

const REFUSED = { ok: false, error: "no" };

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/deck/sort", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin", ...headers },
    body,
  });
}

/** A handler that records what it was given. */
function recorder() {
  const calls: Record<string, unknown>[] = [];
  const handle = async (fields: Record<string, unknown>) => {
    calls.push(fields);
    return { ok: true, error: "" };
  };
  return { calls, handle };
}

describe("jsonPostRefusal", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  test("lets a same-origin JSON request through", () => {
    expect(jsonPostRefusal(h({ "content-type": "application/json", "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(jsonPostRefusal(h({ "content-type": "application/json; charset=utf-8" }))).toBeNull();
  });
  test("refuses a cross-site or same-site request", () => {
    expect(jsonPostRefusal(h({ "content-type": "application/json", "sec-fetch-site": "cross-site" }))).toBe(403);
    expect(jsonPostRefusal(h({ "content-type": "application/json", "sec-fetch-site": "same-site" }))).toBe(403);
  });
  test("refuses a body not sent as JSON", () => {
    expect(jsonPostRefusal(h({ "content-type": "text/plain" }))).toBe(415);
    expect(jsonPostRefusal(h({ "content-type": "application/x-www-form-urlencoded" }))).toBe(415);
    expect(jsonPostRefusal(h({}))).toBe(415);
  });
});

describe("handleJsonPost", () => {
  test("hands the body's fields to the handler and replies 200 with its result, uncached", async () => {
    const { calls, handle } = recorder();
    const title = { mediaType: "movie", tmdbId: 603 };
    const res = await handleJsonPost(post(JSON.stringify({ kind: "pass", title })), REFUSED, handle);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, error: "" });
    expect(calls).toEqual([{ kind: "pass", title }]);
  });

  test("a body that is not a JSON object reaches the handler as no fields", async () => {
    const { calls, handle } = recorder();
    await handleJsonPost(post("[1,2]"), REFUSED, handle);
    await handleJsonPost(post("null"), REFUSED, handle);
    expect(calls).toEqual([{}, {}]);
  });

  test("refuses, without calling the handler: cross-site 403, not sent as JSON 415, not JSON 400", async () => {
    const { calls, handle } = recorder();
    const cross = await handleJsonPost(post("{}", { "Sec-Fetch-Site": "cross-site" }), REFUSED, handle);
    const plain = await handleJsonPost(post("{}", { "Content-Type": "text/plain" }), REFUSED, handle);
    const broken = await handleJsonPost(post("{nope"), REFUSED, handle);
    expect([cross.status, plain.status, broken.status]).toEqual([403, 415, 400]);
    expect(await broken.json()).toEqual(REFUSED);
    expect(calls).toEqual([]);
  });
});
