import { test, describe } from "node:test";
import * as assert from "node:assert";

import {
  diagnose,
  assertSupportedPlatform,
  nodePathFromPlist,
  nodePathFromSystemdUnit,
  formatDiagnosis,
  type DiagnoseInput,
} from "../reporter/doctor";
import { buildLaunchdPlist, buildSystemdService } from "../reporter/install";

// A machine where everything is fine. Each test below breaks exactly one thing,
// so any failure names the condition under test rather than a setup mistake.
function healthyInput(over: Partial<DiagnoseInput> = {}): DiagnoseInput {
  return {
    platform: "darwin",
    unitInstalled: true,
    unitNodePath: "/opt/homebrew/opt/node/bin/node",
    nodePathExists: true,
    unitScheduled: true,
    ...over,
  };
}

function checkNamed(input: DiagnoseInput, name: string) {
  const found = diagnose(input).checks.find((c) => c.name === name);
  assert.ok(found, `expected a check named ${name}`);
  return found!;
}

describe("diagnose — healthy machine", () => {
  test("reports healthy when the unit is installed and scheduled", () => {
    const d = diagnose(healthyInput());
    assert.strictEqual(d.healthy, true);
    assert.ok(d.checks.every((c) => c.status === "ok"), JSON.stringify(d.checks));
  });
});

describe("diagnose — the vanished node binary", () => {
  // The documented cause: `brew upgrade node` deletes the Cellar dir the
  // launchd unit points at, and the reporter then dies silently.
  test("fails when the unit's node binary no longer exists", () => {
    const c = checkNamed(
      healthyInput({
        unitNodePath: "/opt/homebrew/Cellar/node/25.8.1_1/bin/node",
        nodePathExists: false,
      }),
      "node-binary",
    );
    assert.strictEqual(c.status, "fail");
    assert.match(c.detail, /\/opt\/homebrew\/Cellar\/node\/25\.8\.1_1\/bin\/node/);
    assert.match(c.detail, /no longer exists/i);
  });

  test("names the stable path that would have survived, for a Cellar path", () => {
    const c = checkNamed(
      healthyInput({
        unitNodePath: "/opt/homebrew/Cellar/node/25.8.1_1/bin/node",
        nodePathExists: false,
      }),
      "node-binary",
    );
    // stableNodePath() already knows this rewrite — the remedy must cite it.
    assert.match(c.detail, /\/opt\/homebrew\/opt\/node\/bin\/node/);
    assert.match(c.detail, /install-service/);
  });

  test("an unhealthy node path makes the whole diagnosis unhealthy", () => {
    assert.strictEqual(diagnose(healthyInput({ nodePathExists: false })).healthy, false);
  });
});

describe("diagnose — the unit itself", () => {
  test("fails when no unit is installed at all", () => {
    const c = checkNamed(healthyInput({ unitInstalled: false, unitNodePath: null }), "service-installed");
    assert.strictEqual(c.status, "fail");
    assert.match(c.detail, /install-service/);
  });

  // #103: the unit file existed and launchctl reported the label ENABLED, yet
  // macOS had it at `[enabled, disallowed, notified]` in Background Task
  // Management and skipped it at login — twice, for months. Nothing on the
  // launchd side reveals that, so "not loaded" is the only signal we get and it
  // has to carry the macOS operator to the toggle that actually caused it, and
  // say that reinstalling alone will not hold. Login Items is macOS-only, so a
  // systemd box must get none of that advice.
  test("an unscheduled unit reports per-platform recovery guidance", () => {
    const cases = [
      { platform: "darwin" as const, includes: [/not loaded/i, /Login Items/, /node/, /login session only/], excludes: [/systemd/] },
      { platform: "linux" as const, includes: [/not active/i], excludes: [/Login Items/, /login session only/] },
    ];
    for (const row of cases) {
      const c = checkNamed(healthyInput({ platform: row.platform, unitScheduled: false }), "service-scheduled");
      assert.strictEqual(c.status, "fail", row.platform);
      for (const pattern of row.includes) assert.match(c.detail, pattern, `${row.platform}: ${pattern}`);
      for (const pattern of row.excludes) assert.doesNotMatch(c.detail, pattern, `${row.platform}: ${pattern}`);
    }
  });

  // An uninstalled reporter has no unit to inspect, so node-binary and
  // scheduled checks would be noise blaming the wrong thing.
  test("skips downstream unit checks when nothing is installed", () => {
    const names = diagnose(healthyInput({ unitInstalled: false, unitNodePath: null }))
      .checks.map((c) => c.name);
    assert.ok(!names.includes("node-binary"), "node-binary should not run with no unit");
    assert.ok(!names.includes("service-scheduled"), "service-scheduled should not run with no unit");
  });
});

// The parsers read back exactly what install.ts writes. Pairing them against
// the real builders means a change to the plist/unit format fails here rather
// than making doctor quietly blind to a vanished binary.
describe("unit parsers round-trip the real builders", () => {
  test("nodePathFromPlist reads the path buildLaunchdPlist wrote", () => {
    const plist = buildLaunchdPlist({
      label: "com.token-tracking.reporter",
      nodePath: "/opt/homebrew/opt/node@22/bin/node",
      reportScript: "/repo/dist/reporter/report.js",
      workingDir: "/repo",
      logPath: "/tmp/x.log",
    });
    assert.strictEqual(nodePathFromPlist(plist), "/opt/homebrew/opt/node@22/bin/node");
  });

  test("nodePathFromSystemdUnit reads the path buildSystemdService wrote", () => {
    const unit = buildSystemdService({
      nodePath: "/usr/bin/node",
      reportScript: "/repo/dist/reporter/report.js",
      workingDir: "/repo",
    });
    assert.strictEqual(nodePathFromSystemdUnit(unit), "/usr/bin/node");
  });

  test("both parsers return null on junk rather than throwing", () => {
    assert.strictEqual(nodePathFromPlist("<plist></plist>"), null);
    assert.strictEqual(nodePathFromSystemdUnit("[Unit]\n"), null);
  });
});

describe("formatDiagnosis", () => {
  test("a failing report names the failing check and is non-empty", () => {
    const out = formatDiagnosis(diagnose(healthyInput({ nodePathExists: false })));
    assert.match(out, /node-binary/);
    assert.match(out, /FAIL/);
  });

  test("a healthy report says so without any FAIL line", () => {
    const out = formatDiagnosis(diagnose(healthyInput()));
    assert.ok(!/FAIL/.test(out), out);
  });
});

// The bug this replaced: collectInput picked the systemd path for every
// non-darwin platform, so on Windows it looked for a unit install-service
// refuses to write, failed to find it, and called a machine that never had a
// reporter broken. Rejecting up front is the only honest answer there.
describe("platforms doctor cannot answer for", () => {
  test("refuses a platform install-service will not install on", () => {
    assert.throws(() => assertSupportedPlatform("win32"), /not supported on win32/);
  });

  test("accepts exactly the two platforms install-service handles", () => {
    for (const p of ["darwin", "linux"] as NodeJS.Platform[]) {
      assert.doesNotThrow(() => assertSupportedPlatform(p));
    }
  });
});
