import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { collectOpenclawUsage, parseUsageLine, aggregateRecords, discoverOpenclawSessionsDirs } from "../reporter/openclaw";

const FIXTURES = path.join(__dirname, "fixtures", "openclaw");

test("collectOpenclawUsage returns [] when given zero roots", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "20260501",
    sessionsDirs: [],
  });
  assert.deepEqual(result, []);
});

test("collectOpenclawUsage throws when a given root does not exist (fail-loud)", async () => {
  // A typo'd OPENCLAW_SESSIONS_DIRS entry should surface as an error,
  // not silently undercount. discoverOpenclawSessionsDirs filters the
  // production path; callers passing explicit dirs own the existence.
  await assert.rejects(
    () => collectOpenclawUsage({
      sinceDateStr: "20260501",
      sessionsDirs: [path.join(FIXTURES, "does-not-exist")],
    }),
    { code: "ENOENT" },
  );
});

test("collectOpenclawUsage returns [] when roots exist but contain no .jsonl session files", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "20260501",
    sessionsDirs: [path.join(FIXTURES, "empty-root")],
  });
  assert.deepEqual(result, []);
});

test("parseUsageLine extracts usage from an assistant message", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-05-25T19:19:55.663Z",
    message: {
      role: "assistant",
      content: "TRANSCRIPT_SENTINEL_OPENCLAW",
      model: "anthropic/claude-sonnet-4-6",
      provider: "plow",
      api: "openai-completions",
      // Real OpenClaw shape: input is already net (unlike OpenAI's gross
      // input_tokens). totalTokens here is deliberately bogus (99999) to
      // prove the collector ignores wire totalTokens and computes its own
      // from the four counters (expected: 31593 + 147 + 100 + 50 = 31890).
      usage: { input: 31593, output: 147, cacheRead: 100, cacheWrite: 50, totalTokens: 99999 },
      responseId: "chatcmpl-369386b2",
    },
  });
  assert.deepEqual(parseUsageLine(line), {
    date: "2026-05-25",
    modelName: "anthropic/claude-sonnet-4-6",
    inputTokens: 31593,
    outputTokens: 147,
    cacheReadTokens: 100,
    cacheCreationTokens: 50,
    totalTokens: 31890,
    responseId: "chatcmpl-369386b2",
  });
  assert.doesNotMatch(
    JSON.stringify(parseUsageLine(line)),
    /TRANSCRIPT_SENTINEL_OPENCLAW/,
    "assistant content must stay local even when its aggregate usage is counted",
  );
});

test("parseUsageLine returns null for non-message lines", () => {
  assert.equal(parseUsageLine(JSON.stringify({ type: "session", id: "abc" })), null);
});

test("parseUsageLine returns null for user messages", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-05-25T19:19:55.663Z",
    message: { role: "user", content: "hi" },
  });
  assert.equal(parseUsageLine(line), null);
});

test("parseUsageLine returns null for assistant messages without usage", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-05-25T19:19:55.663Z",
    message: { role: "assistant", model: "x", responseId: "r" },
  });
  assert.equal(parseUsageLine(line), null);
});

test("parseUsageLine returns null for assistant messages without responseId (cannot dedupe)", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-05-25T19:19:55.663Z",
    message: { role: "assistant", model: "x", usage: { input: 1, output: 1, totalTokens: 2 } },
  });
  assert.equal(parseUsageLine(line), null);
});

test("parseUsageLine returns null for malformed JSON", () => {
  assert.equal(parseUsageLine("not json"), null);
});

test("parseUsageLine uses local calendar date at timezone boundary (matches openai.ts contract)", () => {
  // A session at 23:00 PDT on May 25 (= 06:00 UTC on May 26) is "yesterday"
  // for a Pacific user — must bucket to 2026-05-25, not the UTC 2026-05-26
  // it would land on under .toISOString().slice(0,10). Without this, a
  // session shows up as a different day on the dashboard than the same
  // moment's claude/codex tokens (which already use local dates).
  const originalTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const line = JSON.stringify({
      type: "message",
      timestamp: "2026-05-26T06:00:00.000Z", // 23:00 PDT May 25
      message: {
        role: "assistant",
        model: "anthropic/claude-sonnet-4-6",
        usage: { input: 1, output: 1, totalTokens: 2 },
        responseId: "tz-r1",
      },
    });
    const result = parseUsageLine(line);
    assert.equal(
      result?.date,
      "2026-05-25",
      "expected local Pacific date 2026-05-25, not UTC 2026-05-26",
    );
  } finally {
    process.env.TZ = originalTZ;
  }
});

test("parseUsageLine falls back to message.timestamp (epoch ms) when top-level timestamp missing", () => {
  // Force TZ — epoch 1779736791413 is 2026-05-26T02:39Z (varies by TZ in
  // local-date mode). Pinning TZ keeps the test CI-deterministic.
  const originalTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        model: "anthropic/claude-sonnet-4-6",
        timestamp: 1779736791413,
        usage: { input: 1, output: 1, totalTokens: 2 },
        responseId: "r1",
      },
    });
    assert.equal(parseUsageLine(line)?.date, "2026-05-25");
  } finally {
    process.env.TZ = originalTZ;
  }
});

const rec = (date: string, model: string, input: number, output: number, responseId: string) => ({
  date, modelName: model, inputTokens: input, outputTokens: output,
  cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: input + output, responseId,
});

test("aggregateRecords sums tokens by (date, model) and tags source=openclaw", () => {
  const result = aggregateRecords([
    rec("2026-05-25", "anthropic/claude-sonnet-4-6", 100, 10, "r1"),
    rec("2026-05-25", "anthropic/claude-sonnet-4-6", 200, 20, "r2"),
    rec("2026-05-25", "anthropic/claude-opus-4-7", 50, 5, "r3"),
    rec("2026-05-26", "anthropic/claude-sonnet-4-6", 10, 1, "r4"),
  ]);
  assert.equal(result.length, 2);
  const day25 = result.find((d) => d.date === "2026-05-25")!;
  assert.equal(day25.modelBreakdowns.length, 2);
  const sonnet = day25.modelBreakdowns.find((m) => m.modelName === "anthropic/claude-sonnet-4-6")!;
  assert.equal(sonnet.inputTokens, 300);
  assert.equal(sonnet.outputTokens, 30);
  assert.equal(sonnet.totalTokens, 330);
  assert.equal(sonnet.source, "openclaw");
});

test("aggregateRecords dedupes records sharing the same responseId", () => {
  const r = rec("2026-05-25", "anthropic/claude-sonnet-4-6", 100, 10, "r1");
  const result = aggregateRecords([r, r, r]);
  assert.equal(result[0].modelBreakdowns[0].inputTokens, 100);
  assert.equal(result[0].modelBreakdowns[0].totalTokens, 110);
});

test("aggregateRecords returns rows sorted by date ascending", () => {
  const result = aggregateRecords([
    rec("2026-05-27", "m", 1, 1, "a"),
    rec("2026-05-25", "m", 1, 1, "b"),
    rec("2026-05-26", "m", 1, 1, "c"),
  ]);
  assert.deepEqual(result.map((r) => r.date), ["2026-05-25", "2026-05-26", "2026-05-27"]);
});

test("collectOpenclawUsage aggregates across multiple roots, dedupes by responseId across roots, ignores trajectory + sessions.json", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "20260501",
    sessionsDirs: [
      path.join(FIXTURES, "root-a"),
      path.join(FIXTURES, "root-b"),
    ],
  });
  assert.equal(result.length, 2);
  const day25 = result.find((d) => d.date === "2026-05-25")!;
  const sonnet = day25.modelBreakdowns.find((m) => m.modelName === "anthropic/claude-sonnet-4-6")!;
  // resp-abc-1 appears in 3 places (root-a/abc, root-a/def.checkpoint, root-b/ghi) — counted once.
  // resp-def-1 (only in root-a) — counted once.
  assert.equal(sonnet.inputTokens, 150);
  assert.equal(sonnet.outputTokens, 15);
  assert.equal(sonnet.totalTokens, 165);
  assert.equal(sonnet.source, "openclaw");
  const day26 = result.find((d) => d.date === "2026-05-26")!;
  assert.equal(day26.modelBreakdowns[0].modelName, "anthropic/claude-opus-4-7");
  assert.equal(day26.modelBreakdowns[0].totalTokens, 220);
});

test("collectOpenclawUsage filters out days strictly before sinceDateStr", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "20260526",
    sessionsDirs: [
      path.join(FIXTURES, "root-a"),
      path.join(FIXTURES, "root-b"),
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].date, "2026-05-26");
});

const DISCOVERY_HOME = path.join(FIXTURES, "discovery", "home");

test("discoverOpenclawSessionsDirs returns standalone + every plow variant on macOS", async () => {
  const result = await discoverOpenclawSessionsDirs({ env: {}, homeDir: DISCOVERY_HOME, platform: "darwin" });
  const rel = result.map((p) => p.slice(DISCOVERY_HOME.length + 1)).sort();
  // `agent-runtime` is what Plow writes today and `openclaw` is what it used
  // to; the fixture carries both under one bundle because discovery has to
  // find whichever a given install has without being told the name.
  assert.deepEqual(rel, [
    ".openclaw/agents/main/sessions",
    "Library/Application Support/co.plow.app.dev.wt1/openclaw/gateway/agents/main/sessions",
    "Library/Application Support/co.plow.app.wt1/openclaw/gateway/agents/main/sessions",
    "Library/Application Support/co.plow.app/agent-runtime/gateway/agents/main/sessions",
    "Library/Application Support/co.plow.app/openclaw/gateway/agents/main/sessions",
  ].sort());
});

test("discoverOpenclawSessionsDirs returns only roots that exist (skips missing)", async () => {
  const emptyHome = path.join(FIXTURES, "empty-root");
  const result = await discoverOpenclawSessionsDirs({ env: {}, homeDir: emptyHome, platform: "darwin" });
  assert.deepEqual(result, []);
});

test("discoverOpenclawSessionsDirs honors OPENCLAW_SESSIONS_DIRS env (comma-separated, overrides probe)", async () => {
  const result = await discoverOpenclawSessionsDirs({
    env: { OPENCLAW_SESSIONS_DIRS: "/tmp/foo,/tmp/bar" },
    homeDir: DISCOVERY_HOME,
    platform: "darwin",
  });
  assert.deepEqual(result, ["/tmp/foo", "/tmp/bar"]);
});

test("discoverOpenclawSessionsDirs trims whitespace and ignores empty entries in env override", async () => {
  const result = await discoverOpenclawSessionsDirs({
    env: { OPENCLAW_SESSIONS_DIRS: "  /tmp/a , ,/tmp/b  ," },
    homeDir: DISCOVERY_HOME,
    platform: "darwin",
  });
  assert.deepEqual(result, ["/tmp/a", "/tmp/b"]);
});

test("discoverOpenclawSessionsDirs returns just standalone path on non-darwin platforms", async () => {
  const result = await discoverOpenclawSessionsDirs({ env: {}, homeDir: DISCOVERY_HOME, platform: "linux" });
  assert.deepEqual(result, [path.join(DISCOVERY_HOME, ".openclaw/agents/main/sessions")]);
});
