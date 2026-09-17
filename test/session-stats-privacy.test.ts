import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSessionStats } from "../reporter/session-stats";

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

  assert.deepEqual(sanitized, {
    schema_version: 2,
    window: { days: 28, since: "2026-08-02", until: "2026-08-30" },
    totals: { sessions_all: 12, messages_total: 120 },
    tool_mix: { by_category: { Bash: 7, Task: 2 }, total_calls: 9 },
    filters: { agent: "all", timezone: "America/Chicago" },
    code_attribution: { sources: [{ provider: "cursor", scope: "repo", status: "ok" }] },
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
