import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSessionStats } from "../reporter/session-stats";

test("sanitizeSessionStats keeps v1 aggregates and drops transcript-shaped fields", () => {
  const sentinel = "TRANSCRIPT_SENTINEL_MUST_STAY_LOCAL";
  const sanitized = sanitizeSessionStats({
    schema_version: 1,
    window: {
      days: 28,
      since: "2026-08-02",
      until: "2026-08-30",
      transcript: sentinel,
    },
    totals: {
      sessions_all: 12,
      messages_total: 120,
      content: sentinel,
    },
    tool_mix: {
      by_category: { Bash: 7, Task: 2, prompt: sentinel },
      total_calls: 9,
      messages: [{ content: sentinel }],
    },
    filters: {
      agent: "all",
      timezone: "America/Chicago",
      projects_included: [sentinel],
    },
    generated_at: "2026-08-30T12:00:00Z",
    transcript: sentinel,
    messages: [{ role: "user", content: sentinel }],
    prompt: sentinel,
  });

  assert.deepEqual(sanitized, {
    schema_version: 1,
    window: {
      days: 28,
      since: "2026-08-02",
      until: "2026-08-30",
    },
    totals: {
      sessions_all: 12,
      messages_total: 120,
    },
    tool_mix: {
      by_category: { Bash: 7, Task: 2 },
      total_calls: 9,
    },
    filters: {
      agent: "all",
      timezone: "America/Chicago",
    },
    generated_at: "2026-08-30T12:00:00Z",
  });
  assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(sentinel));
});

test("sanitizeSessionStats fails closed for an unreviewed schema version", () => {
  assert.equal(
    sanitizeSessionStats({
      schema_version: 2,
      totals: { sessions_all: 12 },
      transcript: "future schema content",
    }),
    null,
  );
});
