import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { autoUpdateEnabled, maybeAutoUpdateAgentsview } from "../reporter/agentsview-update";

describe("autoUpdateEnabled", () => {
  it("defaults to disabled when unset", () => {
    assert.equal(autoUpdateEnabled({}), false);
  });

  it("requires an explicit enabled value", () => {
    for (const v of ["", " ", "anything", "tru", "false", "FALSE", "0", "no", "No", "off", "OFF", " false "]) {
      assert.equal(autoUpdateEnabled({ AGENTSVIEW_AUTO_UPDATE: v }), false, `value: ${JSON.stringify(v)}`);
    }
  });

  it("accepts true/1/yes/on regardless of case or surrounding whitespace", () => {
    for (const v of ["true", "TRUE", "1", "yes", "Yes", "on", "ON", " true "]) {
      assert.equal(autoUpdateEnabled({ AGENTSVIEW_AUTO_UPDATE: v }), true, `value: ${JSON.stringify(v)}`);
    }
  });
});

describe("maybeAutoUpdateAgentsview", () => {
  function withTmp(fn: (tmp: string) => void) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-av-update-"));
    try {
      fn(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // A fake agentsview that records each invocation's argv to `log`, so tests
  // can assert whether `update` actually ran.
  function writeFakeAgentsview(tmp: string, log: string): string {
    const bin = path.join(tmp, "fake-agentsview");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\n` +
        `printf '%s ' "$@" >> "${log}"\n` +
        `printf '\\n' >> "${log}"\n` +
        `case "$1" in\n` +
        `  --version) echo "agentsview v0.33.1 (commit abc, built 2026-06-12T00:00:00Z)" ;;\n` +
        `  update) exit 0 ;;\n` +
        `  *) exit 0 ;;\n` +
        `esac\n`,
    );
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  it("runs update when no stamp exists and writes the stamp", () => {
    withTmp((tmp) => {
      const log = path.join(tmp, "argv.log");
      const bin = writeFakeAgentsview(tmp, log);
      const stamp = path.join(tmp, ".agentsview-update-check");

      const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: 1_700_000_000_000, env: { AGENTSVIEW_AUTO_UPDATE: "true" } });
      assert.equal(ran, true);
      assert.match(fs.readFileSync(log, "utf-8"), /^update --yes $/m);
      assert.equal(fs.readFileSync(stamp, "utf-8").trim(), "1700000000000");
    });
  });

  it("skips update when last check is within the interval", () => {
    withTmp((tmp) => {
      const log = path.join(tmp, "argv.log");
      const bin = writeFakeAgentsview(tmp, log);
      const stamp = path.join(tmp, ".agentsview-update-check");
      const now = 50 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(stamp, String(now - 60_000)); // checked 1 min ago

      const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: now, env: { AGENTSVIEW_AUTO_UPDATE: "true" } });
      assert.equal(ran, false);
      assert.equal(fs.existsSync(log), false, "update must not have been invoked");
    });
  });

  it("runs again once the interval has elapsed", () => {
    withTmp((tmp) => {
      const log = path.join(tmp, "argv.log");
      const bin = writeFakeAgentsview(tmp, log);
      const stamp = path.join(tmp, ".agentsview-update-check");
      const now = 50 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(stamp, String(now - 25 * 60 * 60 * 1000)); // 25h ago

      const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: now, env: { AGENTSVIEW_AUTO_UPDATE: "true" } });
      assert.equal(ran, true);
      assert.match(fs.readFileSync(log, "utf-8"), /^update --yes $/m);
    });
  });

  for (const value of [undefined, "", "false", "anything"]) {
    it(`does not invoke the binary or write a stamp without opt-in (${JSON.stringify(value)})`, () => {
      withTmp((tmp) => {
        const log = path.join(tmp, "argv.log");
        const bin = writeFakeAgentsview(tmp, log);
        const stamp = path.join(tmp, ".agentsview-update-check");

        const ran = maybeAutoUpdateAgentsview(bin, stamp, {
          nowMs: 1_700_000_000_000,
          env: value === undefined ? {} : { AGENTSVIEW_AUTO_UPDATE: value },
        });
        assert.equal(ran, false);
        assert.equal(fs.existsSync(log), false, "must not invoke the binary without opt-in");
        assert.equal(fs.existsSync(stamp), false, "must not record an update attempt without opt-in");
      });
    });
  }

  it("logs the version change when update bumps the binary", () => {
    withTmp((tmp) => {
      // --version reports 0.1.0 until `update` drops a marker, then 0.2.0 —
      // so the before/after detection sees a real bump.
      const bin = path.join(tmp, "fake-agentsview");
      const marker = path.join(tmp, "updated");
      fs.writeFileSync(
        bin,
        `#!/usr/bin/env bash\n` +
          `case "$1" in\n` +
          `  --version) if [ -f "${marker}" ]; then echo "agentsview v0.2.0"; else echo "agentsview v0.1.0"; fi ;;\n` +
          `  update) touch "${marker}"; exit 0 ;;\n` +
          `  *) exit 0 ;;\n` +
          `esac\n`,
      );
      fs.chmodSync(bin, 0o755);
      const stamp = path.join(tmp, ".agentsview-update-check");

      const logs: string[] = [];
      const orig = console.log;
      console.log = (m?: unknown) => { logs.push(String(m)); };
      try {
        const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: 1_700_000_000_000, env: { AGENTSVIEW_AUTO_UPDATE: "true" } });
        assert.equal(ran, true);
      } finally {
        console.log = orig;
      }
      assert.ok(
        logs.some((l) => /auto-updated: 0\.1\.0 -> 0\.2\.0/.test(l)),
        `expected a version-change log line, got: ${logs.join(" | ")}`,
      );
    });
  });

  it("records the check time before updating so a failing update doesn't retry every run", () => {
    withTmp((tmp) => {
      // agentsview that always fails the update.
      const bin = path.join(tmp, "fake-agentsview");
      fs.writeFileSync(
        bin,
        `#!/usr/bin/env bash\ncase "$1" in\n  --version) echo "agentsview v0.1.0" ;;\n  update) echo boom >&2; exit 1 ;;\n  *) exit 0 ;;\nesac\n`,
      );
      fs.chmodSync(bin, 0o755);
      const stamp = path.join(tmp, ".agentsview-update-check");

      // First run attempts the (failing) update but still stamps.
      const ran = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: 1_700_000_000_000, env: { AGENTSVIEW_AUTO_UPDATE: "true" } });
      assert.equal(ran, true);
      assert.equal(fs.readFileSync(stamp, "utf-8").trim(), "1700000000000");

      // Immediately after, it's throttled — no second attempt.
      const ran2 = maybeAutoUpdateAgentsview(bin, stamp, { nowMs: 1_700_000_000_000 + 60_000, env: { AGENTSVIEW_AUTO_UPDATE: "true" } });
      assert.equal(ran2, false);
    });
  });
});
