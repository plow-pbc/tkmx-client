import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import {
  parseAgentsviewOutput,
  toIsoDate,
  collectAgentsviewUsage,
  collectAgentsviewAgentOnly,
  discoverAgents,
  reportingAgentsviewEnv,
  syncAgentsview,
  resolveAgentsviewWith,
} from "../reporter/agentsview";
import { writeFakeIndex } from "./fake-index";
import { LAUNCHD_LABEL } from "../reporter/install";

// Write an executable fixture (default: a no-op shell stub) and mark it +x.
function writeExec(p, body = "#!/bin/sh\n") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

describe("toIsoDate", () => {
  it("converts YYYYMMDD to YYYY-MM-DD", () => {
    assert.equal(toIsoDate("20260413"), "2026-04-13");
  });

  it("preserves single-digit months and days", () => {
    assert.equal(toIsoDate("20260101"), "2026-01-01");
  });
});

describe("reportingAgentsviewEnv", () => {
  it("uses a dedicated usage-only archive for Builder Index reporting", () => {
    assert.deepEqual(
      reportingAgentsviewEnv({ HOME: "/Users/example" } as NodeJS.ProcessEnv),
      {
        AGENTSVIEW_DATA_DIR: "/Users/example/.agentsview-builder-index",
        AGENTSVIEW_USAGE_ONLY: "1",
      },
    );
  });

  it("allows an explicit reporting archive path", () => {
    assert.deepEqual(
      reportingAgentsviewEnv({
        HOME: "/Users/example",
        AGENTSVIEW_REPORTING_DATA_DIR: "/private/reporting-index",
      } as NodeJS.ProcessEnv),
      {
        AGENTSVIEW_DATA_DIR: "/private/reporting-index",
        AGENTSVIEW_USAGE_ONLY: "1",
      },
    );
  });
});

describe("parseAgentsviewOutput", () => {
  const sample = () => ({
    daily: [
      {
        date: "2026-04-10",
        modelBreakdowns: [
          {
            modelName: "claude-opus-4-6",
            inputTokens: 100,
            outputTokens: 200,
            cacheCreationTokens: 50,
            cacheReadTokens: 300,
            cost: 1.23,
          },
          {
            modelName: "claude-haiku-4-5",
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationTokens: 5,
            cacheReadTokens: 30,
            cost: 0.05,
          },
        ],
      },
    ],
  });
  const parseCost = (cost: number | { microdollars: number }) =>
    parseAgentsviewOutput({
      daily: [{
        date: "2026-07-29",
        modelBreakdowns: [{ modelName: "x", cost }],
      }],
    }, "claude")[0].modelBreakdowns[0].cost;

  it("tags each breakdown with the given source", () => {
    const daily = parseAgentsviewOutput(sample(), "claude");
    for (const day of daily) {
      for (const m of day.modelBreakdowns) {
        assert.equal(m.source, "claude");
      }
    }
  });

  it("computes totalTokens as sum of all token-type fields", () => {
    const daily = parseAgentsviewOutput(sample(), "claude");
    assert.equal(daily[0].modelBreakdowns[0].totalTokens, 100 + 200 + 50 + 300);
    assert.equal(daily[0].modelBreakdowns[1].totalTokens, 10 + 20 + 5 + 30);
  });

  it("preserves the cost field untouched", () => {
    assert.equal(parseCost(1.23), 1.23);
  });

  it("converts schema v3 microdollars to dollars", () => {
    assert.equal(parseCost({ microdollars: 20_061_684 }), 20.061684);
  });

  it("rejects invalid schema v3 microdollar costs", () => {
    for (const microdollars of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => parseCost({ microdollars }),
        /cost\.microdollars must be a non-negative safe integer/,
      );
    }
  });

  it("returns [] for empty daily", () => {
    assert.deepEqual(parseAgentsviewOutput({ daily: [] }, "claude"), []);
  });

  it("returns [] when daily field is missing", () => {
    assert.deepEqual(parseAgentsviewOutput({}, "claude"), []);
  });

  it("treats missing token fields as 0 when computing totalTokens", () => {
    const parsed = {
      daily: [
        {
          date: "2026-04-10",
          modelBreakdowns: [
            { modelName: "x", inputTokens: 100, outputTokens: 50 },
          ],
        },
      ],
    };
    const daily = parseAgentsviewOutput(parsed, "codex");
    assert.equal(daily[0].modelBreakdowns[0].totalTokens, 150);
    assert.equal(daily[0].modelBreakdowns[0].source, "codex");
  });

  it("handles a day with no modelBreakdowns array", () => {
    const parsed = { daily: [{ date: "2026-04-10" }] };
    const daily = parseAgentsviewOutput(parsed, "claude");
    assert.equal(daily.length, 1);
    assert.equal(daily[0].date, "2026-04-10");
  });
});

// Every collectAgentsviewUsage case needs the same scaffold: a temp dir
// standing in for the AgentsView data dir, a fake index inside it, a fake
// agentsview binary, and AGENTSVIEW_REPORTING_DATA_DIR pointed there for the
// duration.
// `script` takes the dir so a fake that logs its calls can write inside it.
function withFakeAgentsview(
  agents: string[],
  script: (tmp: string) => string,
  fn: (fakeBin: string, tmp: string) => void,
): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-agentsview-"));
  const origDataDir = process.env.AGENTSVIEW_REPORTING_DATA_DIR;
  const origNoDaemon = process.env.AGENTSVIEW_NO_DAEMON;
  try {
    writeFakeIndex(tmp, agents);
    process.env.AGENTSVIEW_REPORTING_DATA_DIR = tmp;
    // Reproduce agent shells that globally disable daemon autostart. Sync
    // needs direct mode, while read commands need that ambient override
    // removed so AgentsView can open its supported query transport.
    process.env.AGENTSVIEW_NO_DAEMON = "1";
    const fakeBin = path.join(tmp, "agentsview");
    writeExec(fakeBin, script(tmp));
    fn(fakeBin, tmp);
  } finally {
    if (origDataDir === undefined) {
      delete process.env.AGENTSVIEW_REPORTING_DATA_DIR;
    } else {
      process.env.AGENTSVIEW_REPORTING_DATA_DIR = origDataDir;
    }
    if (origNoDaemon === undefined) {
      delete process.env.AGENTSVIEW_NO_DAEMON;
    } else {
      process.env.AGENTSVIEW_NO_DAEMON = origNoDaemon;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function withLaunchdEnvironment(fn: () => void): void {
  const previous = process.env.XPC_SERVICE_NAME;
  process.env.XPC_SERVICE_NAME = LAUNCHD_LABEL;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.XPC_SERVICE_NAME;
    else process.env.XPC_SERVICE_NAME = previous;
  }
}

describe("collectAgentsviewUsage local agents", () => {
  it("collects whatever agents the index holds, syncing once first", () => {
    // `hermes` is the point: it's not one of the four this used to name, and
    // a real machine had it. Discovery has to reach it with no code change.
    withFakeAgentsview(
      ["claude", "codex", "hermes"],
      (tmp) => `#!/bin/sh
agent=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--agent" ]; then agent="$arg"; fi
  prev="$arg"
done
printf 'NO_DAEMON=%s|DATA=%s|USAGE_ONLY=%s|%s\n' "$AGENTSVIEW_NO_DAEMON" "$AGENTSVIEW_DATA_DIR" "$AGENTSVIEW_USAGE_ONLY" "$*" >> "${path.join(tmp, "calls.log")}"
if [ "$1" = "sync" ]; then exit 0; fi
printf '{"daily":[{"date":"2026-05-01","modelBreakdowns":[{"modelName":"%s-model","inputTokens":10,"outputTokens":2}]}]}\\n' "$agent"
`,
      (fakeBin, tmp) => {
        const usageByAgent = collectAgentsviewUsage(fakeBin, "20260501") as any;

        assert.deepEqual(Object.keys(usageByAgent).sort(), ["claude", "codex", "hermes"]);
        assert.equal(usageByAgent.hermes[0].modelBreakdowns[0].source, "hermes");
        assert.equal(usageByAgent.claude[0].modelBreakdowns[0].source, "claude");

        const lines = fs.readFileSync(path.join(tmp, "calls.log"), "utf-8").trim().split("\n");
        assert.equal(
          lines[0],
          `NO_DAEMON=1|DATA=${tmp}|USAGE_ONLY=1|sync`,
          "direct sync uses the dedicated compact archive before discovery",
        );
        const agents = lines.slice(1).map((line) => line.match(/--agent ([^ ]+)/)?.[1]);
        assert.deepEqual(agents.sort(), ["claude", "codex", "hermes"]);
        for (const line of lines.slice(1)) {
          assert.ok(line.startsWith("NO_DAEMON=|"), `usage read should allow daemon transport: ${line}`);
          assert.ok(line.includes("--no-sync"), `usage call should skip sync: ${line}`);
          assert.ok(line.includes(`DATA=${tmp}|USAGE_ONLY=1|`), `usage call should use compact archive: ${line}`);
        }
      },
    );
  });

  // The launchd deadlock, end to end: sync fails (or is SIGKILLed at the
  // timeout) and the run must still report the last-synced snapshot. Before
  // this, the sync's failure was rethrown and the whole 2-hourly report died
  // — on the affected Macs, 100% of runs, forever. Fail-soft is bounded on
  // the other side by discoverAgents, which still throws when the index can't
  // be read at all, so "never synced" stays a loud abort rather than a POST
  // of zero usage dressed up as a quiet day.
  it("still reports last-synced data when a launchd sync fails", () => {
    withLaunchdEnvironment(() => {
      withFakeAgentsview(
        ["claude"],
        (tmp) => `#!/bin/sh
printf 'NO_DAEMON=%s|%s\n' "$AGENTSVIEW_NO_DAEMON" "$*" >> "${path.join(tmp, "calls.log")}"
if [ "$1" = "sync" ]; then echo "spawnSync ETIMEDOUT" >&2; exit 1; fi
echo '{"daily":[{"date":"2026-05-01","modelBreakdowns":[{"modelName":"m","inputTokens":10,"outputTokens":2}]}]}'
`,
        (fakeBin, tmp) => {
          const usageByAgent = collectAgentsviewUsage(fakeBin, "20260501") as any;

          assert.equal(usageByAgent.claude[0].date, "2026-05-01");

          const lines = fs.readFileSync(path.join(tmp, "calls.log"), "utf-8").trim().split("\n");
          assert.equal(
            lines[0],
            "NO_DAEMON=|sync",
            "launchd sync must use daemon transport even when the parent shell disables it",
          );
          assert.ok(lines.length > 1, "reads continue after the sync failed");
        },
      );
    });
  });

  it("fails instead of reading stale data when direct sync fails outside launchd", () => {
    withFakeAgentsview(
      ["claude"],
      (tmp) => `#!/bin/sh
echo "$*" >> "${path.join(tmp, "calls.log")}"
if [ "$1" = "sync" ]; then echo "rebuild failed" >&2; exit 1; fi
echo '{"daily":[]}'
`,
      (fakeBin, tmp) => {
        assert.throws(
          () => collectAgentsviewUsage(fakeBin, "20260501"),
          /agentsview sync failed: rebuild failed/,
        );
        assert.equal(
          fs.readFileSync(path.join(tmp, "calls.log"), "utf-8").trim(),
          "sync",
          "a failed direct sync must not reach stale reads",
        );
      },
    );
  });
});

describe("collectAgentsviewUsage large sync output", () => {
  // Regression: sync's progress output scales with history, so on a large
  // machine it runs past execFileSync's 1 MiB default maxBuffer and the run
  // dies with ENOBUFS before any usage is collected. Observed on a
  // 96k-session host after an agentsview upgrade forced a full resync, where
  // sync wrote 4.5 MB to stdout and nothing to stderr.
  it("survives a sync that writes more than the default maxBuffer", () => {
    withFakeAgentsview(
      ["claude"],
      () => `#!/bin/sh
if [ "$1" = "sync" ]; then
  awk 'BEGIN { line = sprintf("%1023s", ""); for (i = 0; i < 2048; i++) print line }'
  exit 0
fi
echo '{"daily":[{"date":"2026-05-01","modelBreakdowns":[{"modelName":"m","inputTokens":10,"outputTokens":2}]}]}'
`,
      (fakeBin) => {
        const usageByAgent = collectAgentsviewUsage(fakeBin, "20260501") as any;
        assert.equal(usageByAgent.claude[0].date, "2026-05-01");
      },
    );
  });
});

describe("discoverAgents", () => {
  it("throws on an unreadable index rather than reporting an empty agent list", () => {
    // The failure that matters isn't the crash, it's the alternative: [] means
    // zero agents collected, a POST of no usage, and a profile that reads as a
    // quiet day. Loud beats silent — REVIEW.md § Review priority.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-discover-"));
    try {
      assert.throws(
        () => discoverAgents({ AGENTSVIEW_DATA_DIR: tmp } as NodeJS.ProcessEnv),
        /cannot read the AgentsView index/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("syncAgentsview", () => {
  it("returns true when `agentsview sync` exits 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-sync-"));
    try {
      const bin = path.join(tmp, "fake-agentsview");
      writeExec(bin, "#!/bin/sh\nexit 0\n");
      assert.equal(syncAgentsview(bin), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false (best-effort, no throw) when sync fails", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-sync-"));
    try {
      const bin = path.join(tmp, "fake-agentsview");
      writeExec(bin, "#!/bin/sh\necho boom >&2\nexit 1\n");
      assert.equal(syncAgentsview(bin), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("waits through transient daemon contention and returns the fresh sync", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-sync-"));
    try {
      const bin = path.join(tmp, "fake-agentsview");
      const attempts = path.join(tmp, "attempts");
      writeExec(bin, `#!/bin/sh
attempt=0
if [ -f "${attempts}" ]; then attempt=$(cat "${attempts}"); fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > "${attempts}"
if [ "$attempt" -eq 1 ]; then
  echo '{"error":"sync already in progress"}' >&2
  exit 1
fi
exit 0
`);

      assert.equal(syncAgentsview(bin, 2500), true);
      assert.equal(fs.readFileSync(attempts, "utf-8"), "2");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false (no throw) when sync hangs past the timeout", () => {
    // Mirrors the macOS launchd deadlock: the sync never returns, so the
    // timeout must SIGKILL it and we fall through to a read instead of
    // hanging the whole report.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-sync-"));
    try {
      const bin = path.join(tmp, "fake-agentsview");
      writeExec(bin, "#!/bin/sh\nsleep 30\n");
      assert.equal(syncAgentsview(bin, 300), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("collectAgentsviewUsage WARP_DIR scoping", () => {
  // A fake agentsview that records the WARP_DIR it received plus its args,
  // then emits empty daily JSON so the caller parses cleanly. Proves the
  // Warp-skip is scoped to the sync call (the only one that runs the
  // parser registry that hangs an unattended daemon), not the usage ones.
  it("sets WARP_DIR=/var/empty on the sync call but not the per-agent usage calls", () => {
    withFakeAgentsview(
      ["claude", "codex"],
      (tmp) =>
        `#!/bin/sh\necho "WARP_DIR=\${WARP_DIR}|DATA=\${AGENTSVIEW_DATA_DIR}|USAGE_ONLY=\${AGENTSVIEW_USAGE_ONLY}|$*" >> "${path.join(tmp, "calls.log")}"\necho '{"daily":[]}'\n`,
      (fakeBin, tmp) => {
        collectAgentsviewUsage(fakeBin, "20260501");

        const lines = fs.readFileSync(path.join(tmp, "calls.log"), "utf-8").trim().split("\n");
        assert.equal(
          lines[0],
          `WARP_DIR=/var/empty|DATA=${tmp}|USAGE_ONLY=1|sync`,
        );

        for (const agent of ["claude", "codex"]) {
          const line = lines.find((l) => l.includes(`--agent ${agent}`));
          assert.ok(line, `missing ${agent} call`);
          assert.ok(line.includes("--no-sync"), `${agent} call should pass --no-sync`);
          assert.match(line, new RegExp(`^WARP_DIR=\\|DATA=${tmp}\\|USAGE_ONLY=1\\|`));
        }
      },
    );
  });
});

describe("collectAgentsviewAgentOnly strict isolated sync", () => {
  it("direct-syncs the isolated home before reading it with --no-sync", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-extra-sync-"));
    try {
      const calls = path.join(tmp, "calls.log");
      const bin = path.join(tmp, "fake-agentsview");
      writeExec(bin, `#!/bin/sh
printf 'NO_DAEMON=%s|WARP_DIR=%s|DATA=%s|SOURCE=%s|%s\n' "$AGENTSVIEW_NO_DAEMON" "$WARP_DIR" "$AGENT_VIEWER_DATA_DIR" "$CODEX_SESSIONS_DIR" "$*" >> "${calls}"
if [ "$1" = "sync" ]; then sleep 0.5; exit 0; fi
echo '{"daily":[{"date":"2026-08-29","modelBreakdowns":[{"modelName":"gpt-5.6-sol","inputTokens":10,"outputTokens":2}]}]}'
`);
      const dataDir = path.join(tmp, "index");
      const sourceDir = path.join(tmp, "codex", "sessions");

      const result = collectAgentsviewAgentOnly(
        bin,
        "20260829",
        "codex",
        {
          AGENT_VIEWER_DATA_DIR: dataDir,
          CODEX_SESSIONS_DIR: sourceDir,
        },
        250,
      );

      assert.equal(result[0].modelBreakdowns[0].totalTokens, 12);
      const lines = fs.readFileSync(calls, "utf-8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(
        lines[0],
        `NO_DAEMON=1|WARP_DIR=/var/empty|DATA=${dataDir}|SOURCE=${sourceDir}|sync`,
      );
      assert.match(lines[1], new RegExp(
        `^NO_DAEMON=\\|WARP_DIR=\\|DATA=${dataDir}\\|SOURCE=${sourceDir}\\|usage daily `,
      ));
      assert.match(lines[1], /--agent codex/);
      assert.match(lines[1], /--no-sync$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails immediately without syncing under reporter launchd", () => {
    withLaunchdEnvironment(() => {
      assert.throws(
        () => collectAgentsviewAgentOnly("/must-not-run", "20260829", "codex", {}),
        /configured extra homes require an out-of-launchd AgentsView refresh/,
      );
    });
  });

  it("throws on strict sync errors without querying usage", () => {
    const cases = [
      { name: "non-zero exit", syncBody: "echo boom >&2; exit 1", timeoutMs: 180000, errorPattern: /agentsview sync failed: boom/ },
      { name: "timeout", syncBody: "exec sleep 30", timeoutMs: 1000, errorPattern: /agentsview sync failed: .*ETIMEDOUT/ },
    ];
    for (const testCase of cases) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-extra-sync-"));
      try {
        const calls = path.join(tmp, "calls.log");
        const bin = path.join(tmp, "fake-agentsview");
        writeExec(bin, `#!/bin/sh
echo "$*" >> "${calls}"
if [ "$1" = "sync" ]; then ${testCase.syncBody}; fi
echo '{"daily":[]}'
`);

        assert.throws(
          () => collectAgentsviewAgentOnly(
            bin,
            "20260829",
            "codex",
            {},
            180000,
            testCase.timeoutMs,
          ),
          testCase.errorPattern,
          testCase.name,
        );
        assert.deepEqual(fs.readFileSync(calls, "utf-8").trim().split("\n"), ["sync"]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
});

describe("resolveAgentsview", () => {
  // Isolate each case from the host's real agentsview install and any
  // ambient AGENTSVIEW_BIN env var. Tests that need $PATH to find
  // something set PATH explicitly; the default empty PATH makes
  // `which agentsview` miss.
  function withIsolatedEnv(fn) {
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const origPath = process.env.PATH;
    const origBin = process.env.AGENTSVIEW_BIN;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-resolve-"));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.PATH = "";
    delete process.env.AGENTSVIEW_BIN;
    try {
      return fn(tmp);
    } finally {
      process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
      process.env.PATH = origPath;
      if (origBin === undefined) delete process.env.AGENTSVIEW_BIN;
      else process.env.AGENTSVIEW_BIN = origBin;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  function localBinCandidate(tmp) {
    return path.join(tmp, ".local", "bin", process.platform === "win32" ? "agentsview.exe" : "agentsview");
  }

  it("returns null when no candidate path exists", () => {
    withIsolatedEnv(() => {
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), null);
    });
  });

  it("returns the first existing executable candidate", () => {
    withIsolatedEnv((tmp) => {
      const fake = localBinCandidate(tmp);
      writeExec(fake);
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), fake);
    });
  });

  it("skips non-executable candidates", { skip: process.platform === "win32" }, () => {
    withIsolatedEnv((tmp) => {
      const fake = localBinCandidate(tmp);
      fs.mkdirSync(path.dirname(fake), { recursive: true });
      fs.writeFileSync(fake, "#!/bin/sh\n");
      fs.chmodSync(fake, 0o644); // not executable
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), null);
    });
  });

  it("skips candidates that are directories, not files", () => {
    withIsolatedEnv((tmp) => {
      fs.mkdirSync(path.join(tmp, ".local", "bin", "agentsview"), { recursive: true });
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), null);
    });
  });

  it("respects AGENTSVIEW_BIN override", () => {
    withIsolatedEnv((tmp) => {
      const override = path.join(tmp, "nix", "store", process.platform === "win32" ? "agentsview.exe" : "agentsview");
      writeExec(override);
      const candidate = localBinCandidate(tmp);
      writeExec(candidate);
      process.env.AGENTSVIEW_BIN = override;
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), override);
    });
  });

  it("ignores AGENTSVIEW_BIN override when it points at nothing", () => {
    withIsolatedEnv((tmp) => {
      const candidate = localBinCandidate(tmp);
      writeExec(candidate);
      process.env.AGENTSVIEW_BIN = "/nonexistent/agentsview";
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), candidate);
    });
  });

  it("falls back to PATH when no hard-coded candidate exists", () => {
    withIsolatedEnv((tmp) => {
      const pathDir = path.join(tmp, "custom", "bin");
      const fake = path.join(pathDir, process.platform === "win32" ? "agentsview.exe" : "agentsview");
      writeExec(fake);
      process.env.PATH = [pathDir, "/usr/bin", "/bin"].join(path.delimiter);
      const { resolveAgentsview } = require("../reporter/agentsview");
      assert.equal(resolveAgentsview(), fake);
    });
  });

});

// The Windows branch runs on any host by injecting platform/env/isExecutable,
// so CI (Linux) actually exercises it instead of skipping. Paths are built
// with path.win32 semantics regardless of the host separator.
describe("resolveAgentsviewWith — Windows branch (host-independent)", () => {
  const winEnv = (overrides = {}) => ({ USERPROFILE: "C:\\Users\\dev", PATH: "", ...overrides });

  it("finds agentsview.exe in the installer location under USERPROFILE", () => {
    const expected = path.win32.join("C:\\Users\\dev", ".agentsview", "bin", "agentsview.exe");
    const found = resolveAgentsviewWith({
      platform: "win32",
      env: winEnv(),
      isExecutable: (p) => p === expected,
    });
    assert.equal(found, expected);
  });

  it("resolves agentsview.exe from a ;-separated PATH", () => {
    const dir = "C:\\tools\\bin";
    const expected = path.win32.join(dir, "agentsview.exe");
    const found = resolveAgentsviewWith({
      platform: "win32",
      env: winEnv({ PATH: ["C:\\other", dir].join(path.win32.delimiter) }),
      isExecutable: (p) => p === expected,
    });
    assert.equal(found, expected);
  });

  it("never resolves a .cmd/.bat shim — execFileSync can't run one on Windows", () => {
    // Even if a shim is the only thing on disk, the resolver must not hand it
    // back: it only ever probes agentsview.exe, so a shim is never a candidate.
    const shim = path.win32.join("C:\\Users\\dev", ".local", "bin", "agentsview.cmd");
    const found = resolveAgentsviewWith({
      platform: "win32",
      env: winEnv(),
      isExecutable: (p) => p === shim,
    });
    assert.equal(found, null);
  });
});
