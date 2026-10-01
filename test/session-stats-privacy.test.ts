import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSessionStats, mergeSessionStats } from "../reporter/session-stats";

const SENTINEL = "TRANSCRIPT_SENTINEL_MUST_STAY_LOCAL";

// One table-driven case per question the allowlist has to answer, not one per
// field: the rule is declarative, so a per-field test would restate it rather
// than challenge it.
test("keeps reviewed aggregates and drops transcript-shaped fields", () => {
  const sanitized = sanitizeSessionStats({
    schema_version: 2,
    window: { days: 28, since: "2026-08-02", until: "2026-08-30", transcript: SENTINEL },
    totals: { sessions_all: 12, messages_total: 120, content: SENTINEL },
    tool_mix: { by_category: { Bash: 7, Task: 2, prompt: SENTINEL }, total_calls: 9, messages: [{ content: SENTINEL }] },
    filters: { agent: "all", timezone: "America/Chicago", projects_excluded: [SENTINEL] },
    code_attribution: { sources: [{ provider: "cursor", scope: "repo", status: "ok", warnings: [SENTINEL] }] },
    generated_at: "2026-08-30T12:00:00Z",
    transcript: SENTINEL,
    messages: [{ role: "user", content: SENTINEL }],
    prompt: SENTINEL,
  });

  // window / filters / code_attribution are dropped whole: no server path reads
  // them, so they never leave the machine.
  assert.deepEqual(sanitized, {
    schema_version: 2,
    totals: { sessions_all: 12, messages_total: 120 },
    tool_mix: { by_category: { Bash: 7, Task: 2 }, total_calls: 9 },
    generated_at: "2026-08-30T12:00:00Z",
  });
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(SENTINEL));
});

// The allowlist, not a version pin, is what blocks an unreviewed field: a pin
// would silently stop every upload the first time agentsview bumps its schema,
// which is the silent skip REVIEW.md asks us to avoid. An unreviewed version
// still sanitizes — and says so.
test("an unreviewed schema version still uploads allowlisted fields", () => {
  const sanitized = sanitizeSessionStats({
    schema_version: 99,
    totals: { sessions_all: 3 },
    top_prompts: [SENTINEL],
  });

  assert.deepEqual(sanitized, { schema_version: 99, totals: { sessions_all: 3 } });
});

test("rejects output that is not a stats blob", () => {
  for (const bad of [null, undefined, 42, "text", [], {}, { schema_version: "2" }]) {
    assert.equal(sanitizeSessionStats(bad), null, `should reject ${JSON.stringify(bad) ?? "undefined"}`);
  }
});

// A reported name that collides with Object.prototype survives the allowlist.
test("a map key named __proto__ or constructor is kept, not dropped", () => {
  const sanitized = sanitizeSessionStats(JSON.parse(
    '{"schema_version":1,"tool_mix":{"by_category":{"__proto__":3,"constructor":2,"Bash":1},"total_calls":6}}'));
  const byCategory = (sanitized!.tool_mix as { by_category: Record<string, number> }).by_category;
  assert.deepEqual(Object.entries(byCategory), [["__proto__", 3], ["constructor", 2], ["Bash", 1]]);
});

// Folding an extra home in keeps such a name too, and sums it.
test("merging an extra home sums a __proto__ or constructor category", () => {
  const blob = (n: number) => JSON.parse(`{"schema_version":1,"tool_mix":{"by_category":{"__proto__":${n},"constructor":${n}},"total_calls":${2 * n}}}`);
  const merged = mergeSessionStats(blob(1), [blob(2)]);
  const byCategory = (merged!.tool_mix as { by_category: Record<string, number> }).by_category;
  assert.deepEqual(Object.entries(byCategory), [["__proto__", 3], ["constructor", 3]]);
});
