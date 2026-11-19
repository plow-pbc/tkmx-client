import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// report.ts is a program, not a module — it runs on require (exits on
// missing USERNAME/API_KEY and writes to .env on first run), so there's
// no ergonomic way to unit-test its call-site wiring. Extracting a
// testable body-builder would introduce a lot of surface churn for a
// narrow guarantee.
//
// This is a single grep-style guard against the original scrubbing bug:
// reintroducing REPORT_DAYS coupling to the rolling-window blob fields
// (session_stats, cursor_stats), which the server stores wholesale and
// would therefore lose history on short REPORT_DAYS runs.
//
// Why only cursor_stats here, not session_stats: the session_stats path
// is covered behaviorally by `report-e2e.test.ts` (it asserts that
// agentsview is invoked with `--since 28d` even when REPORT_DAYS=1).
// cursor_stats is harder to E2E (would need a stub better-sqlite3 DB),
// so the wiring grep stays as the cheaper-than-a-fixture coverage.
// Drop this test once an equivalent E2E for cursor lands.

// Grep the TypeScript source, not the compiled output — TS rewrites
// import names (`collectCursorStats` → `cursor_1.collectCursorStats`)
// which would break our patterns. After build, this test lives in
// dist/test/, so the source is two levels up at PROJECT_ROOT/reporter.
const SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "reporter", "report.ts"),
  "utf-8",
);

test("collectOpenclawUsage is called with sinceStr, not statsSinceStr", () => {
  assert.match(
    SRC,
    /collectOpenclawUsage\(\s*\{[^}]*sinceDateStr:\s*sinceStr/,
    "openclaw must use REPORT_DAYS window (sinceStr), not the 28d stats window",
  );
  assert.doesNotMatch(
    SRC,
    /collectOpenclawUsage\(\s*\{[^}]*sinceDateStr:\s*statsSinceStr/,
    "openclaw must not be windowed to the 28d stats blob window",
  );
});

test("collectCursorStats uses statsSinceStr, not sinceStr", () => {
  assert.match(
    SRC,
    /collectCursorStats\(\s*statsSinceStr\s*\)/,
    "collectCursorStats should receive the 28d statsSinceStr",
  );
  assert.doesNotMatch(
    SRC,
    /collectCursorStats\(\s*sinceStr\s*\)/,
    "cursor_stats must not be windowed by REPORT_DAYS",
  );
});

// THE THREADING GUARD. EXTRA_CLAUDE_CONFIGS used to reach the token path only
// (the collectExtraAgentsviewHomes map), so session_stats always described just
// the default ~/.claude home while the operator had configured more. Tokens
// counted the extra home; the subagent / plan-mode / tool-mix panels did not.
//
// This is the test that fails if the threading is reverted to token-path-only:
// collectSessionStats must receive extraHomes derived from EXTRA_CLAUDE_CONFIGS.
// The behavioral half — that a passed extra home is really queried and folded
// in — lives in session-stats.test.ts, which a grep cannot cover.
test("extra Claude and Codex configs reach session stats, not just the token path", () => {
  // It must still reach the token path (the pre-existing behaviour).
  assert.match(
    SRC,
    /raw:\s*EXTRA_CLAUDE_CONFIGS/,
    "EXTRA_CLAUDE_CONFIGS must still feed the usage/token collection",
  );
  // And it must ALSO reach the stats blob.
  assert.match(
    SRC,
    /extraStatsHomes\(\s*EXTRA_CLAUDE_CONFIGS\s*,\s*EXTRA_CODEX_CONFIGS\s*\)/,
    "extraStatsHomes must include both EXTRA_CLAUDE_CONFIGS and EXTRA_CODEX_CONFIGS",
  );
  assert.match(
    SRC,
    /collectSessionStats\(\s*\{[^}]*extraHomes:/,
    "collectSessionStats must receive extraHomes, or every stats panel silently " +
      "excludes the configured extra homes",
  );
  // The stats homes must be resolved through the SAME data-dir function the
  // usage path syncs into — a second, independent path would drift.
  assert.match(
    SRC,
    /function extraStatsHomes[\s\S]*?agentsviewDataDirFor\(/,
    "extraStatsHomes must resolve dirs via agentsviewDataDirFor, the same " +
      "function collectExtraAgentsviewHomes syncs into",
  );
});
