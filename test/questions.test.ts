import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingLine, fetchPendingCount } from "../reporter/questions";

const SERVER = "https://tkmx.example";

test("silence when nothing is waiting", () => {
  assert.equal(pendingLine({ pending: 0, username: "alice", serverUrl: SERVER }), null);
  assert.equal(pendingLine({ pending: -1, username: "alice", serverUrl: SERVER }), null);
  assert.equal(pendingLine({ pending: NaN, username: "alice", serverUrl: SERVER }), null);
});

test("one question is singular, more are plural", () => {
  assert.match(pendingLine({ pending: 1, username: "alice", serverUrl: SERVER })!, /1 unanswered question —/);
  assert.match(pendingLine({ pending: 3, username: "alice", serverUrl: SERVER })!, /3 unanswered questions —/);
});

test("the link is the ask page, and a trailing slash on SERVER_URL does not double up", () => {
  const line = pendingLine({ pending: 2, username: "alice", serverUrl: SERVER + "///" })!;
  assert.ok(line.includes(`${SERVER}/ask/alice`), line);
});

test("a username with URL-unsafe characters is encoded", () => {
  const line = pendingLine({ pending: 1, username: "a b", serverUrl: SERVER })!;
  assert.ok(line.includes("/ask/a%20b"), line);
});

test("a pending count is read from the API", async () => {
  const seen: string[] = [];
  const n = await fetchPendingCount(SERVER, "alice", async (url) => {
    seen.push(url);
    return { ok: true, json: async () => ({ ok: true, pending: 4, answers: [] }) };
  });
  assert.equal(n, 4);
  assert.deepEqual(seen, [`${SERVER}/api/user/alice/questions`]);
});

// Each of these would otherwise surface as a confident "0 questions".
for (const [name, impl] of [
  ["a non-200", async () => ({ ok: false, json: async () => ({}) })],
  ["a thrown request", async () => { throw new Error("ECONNREFUSED"); }],
  ["a body without a count", async () => ({ ok: true, json: async () => ({ ok: true }) })],
  ["a non-numeric count", async () => ({ ok: true, json: async () => ({ pending: "lots" }) })],
  ["unparseable JSON", async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })],
] as const) {
  test(`${name} is "don't know", not zero`, async () => {
    assert.equal(await fetchPendingCount(SERVER, "alice", impl as any), null);
  });
}

test("no username means no request at all", async () => {
  let called = false;
  const n = await fetchPendingCount(SERVER, "", async () => { called = true; return { ok: true, json: async () => ({}) }; });
  assert.equal(n, null);
  assert.equal(called, false);
});
