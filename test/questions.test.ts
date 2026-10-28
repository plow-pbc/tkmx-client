import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingLine, fetchPendingCount } from "../reporter/questions";

const SERVER = "https://tkmx.example";

// [name, pending, serverUrl, username, expected line or null]
for (const [name, pending, serverUrl, username, expected] of [
  ["silence when nothing is waiting", 0, SERVER, "alice", null],
  ["one question is singular", 1, SERVER, "alice",
    `  You have 1 unanswered question — answer at ${SERVER}/ask/alice`],
  ["more than one is plural", 3, SERVER, "alice",
    `  You have 3 unanswered questions — answer at ${SERVER}/ask/alice`],
  ["a trailing slash on SERVER_URL does not double up", 2, SERVER + "///", "alice",
    `  You have 2 unanswered questions — answer at ${SERVER}/ask/alice`],
  ["a username with URL-unsafe characters is encoded", 1, SERVER, "a b",
    `  You have 1 unanswered question — answer at ${SERVER}/ask/a%20b`],
] as const) {
  test(`pendingLine: ${name}`, () => {
    assert.equal(pendingLine({ pending, username, serverUrl }), expected);
  });
}

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

test("a server that accepts the connection and never answers times out to null", async () => {
  // The flag is what proves the timeout fired: a missing signal would also
  // throw into the catch and return null, passing a bare null check.
  // The ref'd timer stands in for the open socket a real hung request holds;
  // without it the abort timer (unref'd) lets the loop drain on Node 22.
  let aborted = false;
  const started = Date.now();
  const n = await fetchPendingCount(SERVER, "alice", (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      const socket = setTimeout(() => {}, 1_000);
      signal.addEventListener("abort", () => {
        aborted = true;
        clearTimeout(socket);
        reject(signal.reason);
      });
    }), 20);
  assert.equal(n, null);
  assert.ok(aborted, "the request was never aborted");
  assert.ok(Date.now() - started < 1_000, "the caller's timeout was not the one applied");
});

test("no username means no request at all", async () => {
  let called = false;
  const n = await fetchPendingCount(SERVER, "", async () => { called = true; return { ok: true, json: async () => ({}) }; });
  assert.equal(n, null);
  assert.equal(called, false);
});
