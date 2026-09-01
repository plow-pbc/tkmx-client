import { describe, it } from "node:test";
import assert from "node:assert/strict";

function slashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

import {
  stableNodePath,
  buildLaunchdPlist,
  buildLaunchdInstallCommands,
  buildSystemdService,
  buildSystemdTimer,
  PROJECT_ROOT,
  REPORT_SCRIPT,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_BASENAME,
} from "../reporter/install";

describe("buildLaunchdInstallCommands", () => {
  it("uses the modern logged-in user domain, enables reboot loading, and verifies the job", () => {
    const plistPath = "/Users/alice/Library/LaunchAgents/com.test.reporter.plist";
    const commands = buildLaunchdInstallCommands({
      uid: 501,
      label: "com.test.reporter",
      plistPath,
    });

    assert.deepEqual(commands, [
      {
        file: "/bin/launchctl",
        args: ["bootout", "gui/501/com.test.reporter"],
        tolerateFailure: true,
      },
      {
        file: "/bin/launchctl",
        args: ["enable", "gui/501/com.test.reporter"],
      },
      {
        file: "/bin/launchctl",
        args: ["bootstrap", "gui/501", plistPath],
      },
      {
        file: "/bin/launchctl",
        args: ["kickstart", "-k", "gui/501/com.test.reporter"],
      },
      {
        file: "/bin/launchctl",
        args: ["print", "gui/501/com.test.reporter"],
      },
    ]);

    const commandText = JSON.stringify(commands);
    assert.doesNotMatch(commandText, /sudo|\bload\b|\bunload\b/);
  });

  it("refuses a root-domain install", () => {
    assert.throws(
      () => buildLaunchdInstallCommands({
        uid: 0,
        label: "com.test.reporter",
        plistPath: "/tmp/com.test.reporter.plist",
      }),
      /logged-in user.*root/i,
    );
  });
});

describe("stableNodePath", () => {
  // A brew Cellar path is rewritten to the formula's `opt/` symlink, which
  // survives `brew upgrade`; every other path is passed through untouched.
  const cases: Array<{ name: string; input: string; want?: string }> = [
    {
      name: "rewrites an Apple Silicon cellar path to the opt symlink",
      input: "/opt/homebrew/Cellar/node/25.8.1_1/bin/node",
      want: "/opt/homebrew/opt/node/bin/node",
    },
    {
      name: "rewrites an Intel cellar path to the opt symlink",
      input: "/usr/local/Cellar/node/24.0.0/bin/node",
      want: "/usr/local/opt/node/bin/node",
    },
    {
      // Versioned formulae are keg-only, so `<prefix>/bin/node` is the
      // *unversioned* formula — a different major. Preferring it would
      // silently re-point the service at the wrong node.
      name: "rewrites a keg-only versioned formula to its own opt symlink, not <prefix>/bin",
      input: "/opt/homebrew/Cellar/node@22/22.22.3/bin/node",
      want: "/opt/homebrew/opt/node@22/bin/node",
    },
    {
      name: "leaves nvm paths alone (no stable alias available)",
      input: "/Users/alice/.nvm/versions/node/v24.14.1/bin/node",
    },
    {
      name: "leaves an already-stable opt path alone",
      input: "/opt/homebrew/opt/node/bin/node",
    },
    {
      name: "leaves arbitrary non-brew paths alone",
      input: "/usr/bin/node",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      assert.equal(stableNodePath(c.input), c.want ?? c.input);
    });
  }
});

describe("install paths", () => {
  it("REPORT_SCRIPT points at the compiled report.js inside dist/", () => {
    // Catches a typo in the dist/reporter/report.js path that would
    // otherwise install a daemon that can't even start.
    const reportScript = slashPath(REPORT_SCRIPT);
    const projectRoot = slashPath(PROJECT_ROOT);
    assert.ok(
      reportScript.endsWith("/dist/reporter/report.js"),
      `REPORT_SCRIPT should end with /dist/reporter/report.js, got: ${REPORT_SCRIPT}`,
    );
    assert.ok(
      reportScript.startsWith(projectRoot + "/"),
      "REPORT_SCRIPT should be inside PROJECT_ROOT",
    );
  });

  it("PROJECT_ROOT is the repo root (parent of dist/), not dist/ itself", () => {
    // Daemon WorkingDirectory must be the repo root so .env loading and
    // .machine_config_hash writes land alongside source, not under dist/.
    assert.ok(
      !PROJECT_ROOT.endsWith("/dist") && !PROJECT_ROOT.endsWith("/dist/reporter"),
      `PROJECT_ROOT must not be a dist/ subdir, got: ${PROJECT_ROOT}`,
    );
  });
});

describe("buildLaunchdPlist", () => {
  const inputs = {
    label: "com.test.reporter",
    nodePath: "/opt/homebrew/bin/node",
    reportScript: "/Users/alice/tkmx-client/dist/reporter/report.js",
    workingDir: "/Users/alice/tkmx-client",
    logPath: "/Users/alice/Library/Logs/test.log",
  };

  it("interpolates the node binary into ProgramArguments", () => {
    const plist = buildLaunchdPlist(inputs);
    assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  });

  it("interpolates the compiled report.js into ProgramArguments", () => {
    const plist = buildLaunchdPlist(inputs);
    assert.match(plist, /<string>\/Users\/alice\/tkmx-client\/dist\/reporter\/report\.js<\/string>/);
  });

  it("sets WorkingDirectory to the repo root, not dist/", () => {
    const plist = buildLaunchdPlist(inputs);
    assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/alice\/tkmx-client<\/string>/);
  });

  it("includes the node binary's parent in PATH so child processes resolve", () => {
    const plist = buildLaunchdPlist(inputs);
    assert.match(plist, /<string>\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
  });

  it("uses the supplied label", () => {
    const plist = buildLaunchdPlist(inputs);
    assert.match(plist, /<key>Label<\/key>\s*<string>com\.test\.reporter<\/string>/);
  });
});

describe("buildSystemdService", () => {
  const inputs = {
    nodePath: "/usr/bin/node",
    reportScript: "/home/alice/tkmx-client/dist/reporter/report.js",
    workingDir: "/home/alice/tkmx-client",
  };

  it("ExecStart points at node + the compiled report.js", () => {
    const unit = buildSystemdService(inputs);
    assert.match(unit, /^ExecStart=\/usr\/bin\/node \/home\/alice\/tkmx-client\/dist\/reporter\/report\.js$/m);
  });

  it("WorkingDirectory is the repo root, not dist/", () => {
    const unit = buildSystemdService(inputs);
    assert.match(unit, /^WorkingDirectory=\/home\/alice\/tkmx-client$/m);
  });

  it("PATH includes the node binary's parent dir", () => {
    const unit = buildSystemdService(inputs);
    assert.match(unit, /^Environment=PATH=\/usr\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  });
});

describe("buildSystemdTimer", () => {
  it("triggers every 2 hours with a 5-min boot delay", () => {
    const timer = buildSystemdTimer();
    assert.match(timer, /^OnUnitActiveSec=2h$/m);
    assert.match(timer, /^OnBootSec=5min$/m);
    assert.match(timer, /^Persistent=true$/m);
  });
});

describe("install constants", () => {
  it("LAUNCHD_LABEL and SYSTEMD_UNIT_BASENAME are stable identifiers", () => {
    // Renaming these would orphan running daemons on existing installs —
    // the uninstall script would lookup the new name and find nothing,
    // leaving the old one running indefinitely. Guard against accidental
    // edits.
    assert.equal(LAUNCHD_LABEL, "com.token-tracking.reporter");
    assert.equal(SYSTEMD_UNIT_BASENAME, "token-tracking-reporter");
  });
});
