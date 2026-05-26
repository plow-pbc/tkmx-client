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
  process.env.AGENTSVIEW_BIN = "/definitely/not/here";
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
