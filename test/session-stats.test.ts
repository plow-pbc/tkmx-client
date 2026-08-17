import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// Each case runs with HOME + PATH reset so `resolveAgentsview` can't fall
// through to a real agentsview install at ~/.local/bin/agentsview (a
// candidate path) or via `which` on the host's PATH.
//
// PATH is set to /bin:/usr/bin so shebangs (`#!/usr/bin/env bash`) in the
// test fixtures can still resolve their interpreter. That's enough surface
// for the shebang but not enough for the `which agentsview` fallback to
// find anything real.
const ORIG = {
  AGENTSVIEW_BIN: process.env.AGENTSVIEW_BIN,
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  USERPROFILE: process.env.USERPROFILE,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
};
let tmpHome;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-ssession-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.PATH = "/bin:/usr/bin";
  delete process.env.AGENTSVIEW_BIN;
  delete process.env.NODE_OPTIONS;
  delete require.cache[require.resolve("../reporter/session-stats")];
  delete require.cache[require.resolve("../reporter/agentsview")];
});

afterEach(() => {
  if (ORIG.AGENTSVIEW_BIN === undefined) delete process.env.AGENTSVIEW_BIN;
  else process.env.AGENTSVIEW_BIN = ORIG.AGENTSVIEW_BIN;
  process.env.HOME = ORIG.HOME;
  process.env.PATH = ORIG.PATH;
  if (ORIG.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG.USERPROFILE;
  if (ORIG.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = ORIG.NODE_OPTIONS;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function useFakeAgentsview(output: string): void {
  if (process.platform !== "win32") {
    process.env.AGENTSVIEW_BIN = output === "garbage"
      ? path.join(__dirname, "fixtures", "broken-agentsview")
      : path.join(__dirname, "fixtures", "fake-agentsview");
    return;
  }

  const preload = path.join(tmpHome, "fake-agentsview-preload.cjs");
  fs.writeFileSync(
    preload,
    `const path = require("path");
if (path.basename(process.argv[1] || "") !== "stats") return;
console.log(${JSON.stringify(output)});
process.exit(0);
`,
  );
  process.env.AGENTSVIEW_BIN = process.execPath;
  process.env.NODE_OPTIONS = `--require=${preload}`;
}

test("collectSessionStats returns parsed JSON from agentsview", () => {
  useFakeAgentsview('{"schema_version":1,"window":{"days":28},"totals":{"sessions_all":10},"generated_at":"2026-04-18T00:00:00Z"}');
  const { collectSessionStats } = require("../reporter/session-stats");
  const out = collectSessionStats({ sinceDays: 28 });
  assert.ok(out);
  assert.equal(out.schema_version, 1);
  assert.equal(out.totals.sessions_all, 10);
});

test("collectSessionStats returns null when binary missing", () => {
  // A bogus AGENTSVIEW_BIN is ignored rather than fatal — the resolver falls
  // through to its candidates, and the hard-coded /opt/homebrew and
  // /usr/local paths are absolute, so HOME/PATH isolation can't hide a real
  // install on a dev box. Stub the resolver itself so "not found" is the
  // condition under test on every host, not just one without agentsview.
  process.env.AGENTSVIEW_BIN = "/definitely/not/here";
  const agentsview = require("../reporter/agentsview");
  agentsview.resolveAgentsview = () => null;
  const { collectSessionStats } = require("../reporter/session-stats");
  const out = collectSessionStats({ sinceDays: 28 });
  assert.equal(out, null);
});

test("collectSessionStats returns null on non-JSON output", () => {
  // broken-agentsview is a committed static fixture under test/fixtures/
  // that prints garbage and exits 0 — exercises the JSON.parse failure path.
  useFakeAgentsview("garbage");
  const { collectSessionStats } = require("../reporter/session-stats");
  const out = collectSessionStats({ sinceDays: 28 });
  assert.equal(out, null);
});

// ── extra homes (EXTRA_CLAUDE_CONFIGS) ──────────────────────────────────
//
// The regression these cover: collectSessionStats took no data-dir argument,
// so EXTRA_CLAUDE_CONFIGS reached the TOKEN totals only and every stats panel
// silently described just the default ~/.claude home. The fixture emits a
// DIFFERENT blob per AGENT_VIEWER_DATA_DIR, so "did the extra home actually
// get queried and folded in" is observable rather than assumed.
//
// Fixture numbers are chosen so the merged result differs from BOTH inputs:
//   primary  Task=10 rate=0.05 -> N=200   plan 0.01 -> 2 sessions
//   extra    Task=2  rate=0.04 -> N=50    plan 0.02 -> 1 session
//   merged   (10+2)/250 = 0.048           (2+1)/250 = 0.012
// so a test asserting 0.048 cannot pass by returning either home alone.
function usePerDataDirAgentsview(): void {
  if (process.platform !== "win32") {
    process.env.AGENTSVIEW_BIN = path.join(__dirname, "fixtures", "fake-agentsview-per-datadir");
    return;
  }
  const preload = path.join(tmpHome, "per-datadir-preload.cjs");
  fs.writeFileSync(
    preload,
    `const path = require("path");
if (path.basename(process.argv[1] || "") !== "stats") return;
const extra = String(process.env.AGENT_VIEWER_DATA_DIR || "").includes("extra-home");
console.log(extra
  ? '{"schema_version":1,"window":{"days":28},"totals":{"sessions_all":50,"messages_total":500},"tool_mix":{"by_category":{"Bash":20,"Task":2},"total_calls":22},"adoption":{"subagents_per_session":0.04,"plan_mode_rate":0.02,"distinct_skills":3},"generated_at":"2026-04-18T00:00:00Z"}'
  : '{"schema_version":1,"window":{"days":28},"totals":{"sessions_all":200,"messages_total":2000},"tool_mix":{"by_category":{"Bash":100,"Task":10},"total_calls":110},"adoption":{"subagents_per_session":0.05,"plan_mode_rate":0.01,"distinct_skills":7},"generated_at":"2026-04-18T00:00:00Z"}');
process.exit(0);
`,
  );
  process.env.AGENTSVIEW_BIN = process.execPath;
  process.env.NODE_OPTIONS = `--require=${preload}`;
}

test("collectSessionStats folds an extra home's data dir into the blob", () => {
  usePerDataDirAgentsview();
  const { collectSessionStats } = require("../reporter/session-stats");
  const out = collectSessionStats({
    sinceDays: 28,
    extraHomes: [{ name: "acct", dataDir: "/tmp/extra-home-acct" }],
  });
  assert.ok(out);
  // Counts are summed across both homes.
  assert.equal(out.totals.sessions_all, 250);
  assert.equal(out.totals.messages_total, 2500);
  assert.equal(out.tool_mix.by_category.Bash, 120);
  assert.equal(out.tool_mix.by_category.Task, 12);
  assert.equal(out.tool_mix.total_calls, 132);
  // Rates are RECOMPUTED from recovered denominators, not averaged and not
  // taken from either home. 0.045 would be the naive mean; 0.05 / 0.04 the
  // unmerged inputs — all three are wrong and all three are excluded here.
  assert.equal(out.adoption.subagents_per_session, 12 / 250);
  assert.equal(out.adoption.plan_mode_rate, 3 / 250);
  assert.notEqual(out.adoption.subagents_per_session, 0.05);
  assert.notEqual(out.adoption.subagents_per_session, 0.045);
  // distinct_skills is a count, not a name list — max is the honest bound.
  assert.equal(out.adoption.distinct_skills, 7);
  assert.equal(out.adoption.adoption_scope, "merged:2");
  assert.equal(out.extra_homes_merged, 1);
});

test("collectSessionStats without extra homes returns the primary blob untouched", () => {
  usePerDataDirAgentsview();
  const { collectSessionStats } = require("../reporter/session-stats");
  const out = collectSessionStats({ sinceDays: 28 });
  assert.ok(out);
  assert.equal(out.totals.sessions_all, 200);
  assert.equal(out.adoption.subagents_per_session, 0.05);
  // No merge happened, so no merge bookkeeping is invented.
  assert.equal(out.extra_homes_merged, undefined);
  assert.equal(out.adoption.adoption_scope, undefined);
});

test("an unreadable extra home is skipped, and the primary blob survives intact", () => {
  // The resilience claim: unlike the usage path (where a missing home is fatal
  // because a partial TOTAL would post as success), a stats home that cannot be
  // read must degrade to exactly the blob returned before extraHomes existed.
  // Losing a whole report over a best-effort field would be the worse trade.
  usePerDataDirAgentsview();
  const { collectSessionStats } = require("../reporter/session-stats");
  const out = collectSessionStats({
    sinceDays: 28,
    extraHomes: [{ name: "broken", dataDir: "/tmp/broken-home-acct" }],
  });
  assert.ok(out, "a failed extra home must not null out the whole blob");
  // Identical to the no-extras case: nothing merged, nothing invented.
  assert.equal(out.totals.sessions_all, 200);
  assert.equal(out.tool_mix.total_calls, 110);
  assert.equal(out.adoption.subagents_per_session, 0.05);
  assert.equal(out.extra_homes_merged, undefined);
  assert.equal(out.adoption.adoption_scope, undefined);
});

test("a good extra home is still merged when a sibling home fails", () => {
  // One broken, one fine: the working home must still reach the blob, or a
  // single bad store would silently erase every other configured one.
  usePerDataDirAgentsview();
  const { collectSessionStats } = require("../reporter/session-stats");
  const out = collectSessionStats({
    sinceDays: 28,
    extraHomes: [
      { name: "broken", dataDir: "/tmp/broken-home-acct" },
      { name: "acct", dataDir: "/tmp/extra-home-acct" },
    ],
  });
  assert.ok(out);
  assert.equal(out.extra_homes_merged, 1, "only the readable home merged");
  assert.equal(out.totals.sessions_all, 250);
  assert.equal(out.adoption.subagents_per_session, 12 / 250);
});

test("recoverSessionCount inverts the rate, and refuses when it cannot", () => {
  const { recoverSessionCount } = require("../reporter/session-stats");
  // The identity: subagents_per_session === tool_mix.by_category.Task / N.
  assert.equal(
    recoverSessionCount({
      schema_version: 1,
      tool_mix: { by_category: { Task: 467 } },
      adoption: { subagents_per_session: 0.0313254628387443 },
    }),
    14908,
  );
  // No Task calls, a zero rate, or missing blocks are all unrecoverable —
  // null, never a guess, and never totals.sessions_all (a different set).
  assert.equal(recoverSessionCount({ schema_version: 1, tool_mix: { by_category: { Task: 0 } }, adoption: { subagents_per_session: 0.5 } }), null);
  assert.equal(recoverSessionCount({ schema_version: 1, tool_mix: { by_category: { Task: 5 } }, adoption: { subagents_per_session: 0 } }), null);
  assert.equal(recoverSessionCount({ schema_version: 1, totals: { sessions_all: 999 } }), null);
  assert.equal(recoverSessionCount(null), null);
});

test("mergeSessionStats labels adoption primary-only when a denominator is unrecoverable", () => {
  const { mergeSessionStats } = require("../reporter/session-stats");
  const primary = {
    schema_version: 1,
    totals: { sessions_all: 200 },
    tool_mix: { by_category: { Task: 10 }, total_calls: 10 },
    adoption: { subagents_per_session: 0.05, plan_mode_rate: 0.01 },
  };
  // This extra home has an adoption block but no Task calls, so its session
  // count cannot be recovered. Publishing the primary's rate as if it covered
  // both homes would be the original bug wearing a merge label.
  const extra = {
    schema_version: 1,
    totals: { sessions_all: 50 },
    tool_mix: { by_category: { Bash: 4 }, total_calls: 4 },
    adoption: { subagents_per_session: 0, plan_mode_rate: 0 },
  };
  const out = mergeSessionStats(primary, [extra]);
  assert.equal(out.adoption.adoption_scope, "primary-only");
  assert.equal(out.adoption.subagents_per_session, 0.05);
  // Counts still merge — they are additive regardless of the rate problem.
  assert.equal(out.totals.sessions_all, 250);
  assert.equal(out.tool_mix.total_calls, 14);
  assert.equal(out.tool_mix.by_category.Bash, 4);
});
