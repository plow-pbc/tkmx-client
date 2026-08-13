import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { parseAgentsviewOutput, toIsoDate, collectAgentsviewUsage, discoverAgents, resolveAgentsviewWith } from "../reporter/agentsview";
import { writeFakeIndex } from "./fake-index";

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

describe("collectAgentsviewUsage local agents", () => {
  it("collects whatever agents the index holds, syncing once first", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-agents-"));
    const origDataDir = process.env.AGENTSVIEW_DATA_DIR;
    try {
      // `hermes` is the point: it's not one of the four this used to name, and
      // a real machine had it. Discovery has to reach it with no code change.
      writeFakeIndex(tmp, ["claude", "codex", "hermes"]);
      process.env.AGENTSVIEW_DATA_DIR = tmp;

      const logPath = path.join(tmp, "calls.log");
      const fakeBin = path.join(tmp, "agentsview");
      writeExec(
        fakeBin,
        `#!/bin/sh
agent=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--agent" ]; then agent="$arg"; fi
  prev="$arg"
done
echo "$*" >> "${logPath}"
if [ "$1" = "sync" ]; then exit 0; fi
printf '{"daily":[{"date":"2026-05-01","modelBreakdowns":[{"modelName":"%s-model","inputTokens":10,"outputTokens":2}]}]}\\n' "$agent"
`,
      );

      const usageByAgent = collectAgentsviewUsage(fakeBin, "20260501") as any;

      assert.deepEqual(Object.keys(usageByAgent).sort(), ["claude", "codex", "hermes"]);
      assert.equal(usageByAgent.hermes[0].modelBreakdowns[0].source, "hermes");
      assert.equal(usageByAgent.claude[0].modelBreakdowns[0].source, "claude");

      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      assert.equal(lines[0], "sync", "sync runs before discovery reads the index");
      const agents = lines.slice(1).map((line) => line.match(/--agent ([^ ]+)/)?.[1]);
      assert.deepEqual(agents.sort(), ["claude", "codex", "hermes"]);
      for (const line of lines.slice(1)) {
        assert.ok(line.includes("--no-sync"), `usage call should skip sync: ${line}`);
      }
    } finally {
      if (origDataDir === undefined) delete process.env.AGENTSVIEW_DATA_DIR;
      else process.env.AGENTSVIEW_DATA_DIR = origDataDir;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

describe("collectAgentsviewUsage WARP_DIR scoping", () => {
  // A fake agentsview that records the WARP_DIR it received plus its args,
  // then emits empty daily JSON so the caller parses cleanly. Proves the
  // Warp-skip is scoped to the sync call (the only one that runs the
  // parser registry that hangs an unattended daemon), not the usage ones.
  it("sets WARP_DIR=/var/empty on the sync call but not the per-agent usage calls", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-warp-"));
    const origDataDir = process.env.AGENTSVIEW_DATA_DIR;
    try {
      writeFakeIndex(tmp, ["claude", "codex"]);
      process.env.AGENTSVIEW_DATA_DIR = tmp;

      const logPath = path.join(tmp, "calls.log");
      const fakeBin = path.join(tmp, "agentsview");
      writeExec(
        fakeBin,
        `#!/bin/sh\necho "WARP_DIR=\${WARP_DIR}|$*" >> "${logPath}"\necho '{"daily":[]}'\n`,
      );

      collectAgentsviewUsage(fakeBin, "20260501");

      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      assert.match(lines[0], /^WARP_DIR=\/var\/empty\|sync$/);

      for (const agent of ["claude", "codex"]) {
        const line = lines.find((l) => l.includes(`--agent ${agent}`));
        assert.ok(line, `missing ${agent} call`);
        assert.ok(line.includes("--no-sync"), `${agent} call should pass --no-sync`);
        assert.doesNotMatch(line, /WARP_DIR=\/var\/empty\|/);
      }
    } finally {
      if (origDataDir === undefined) delete process.env.AGENTSVIEW_DATA_DIR;
      else process.env.AGENTSVIEW_DATA_DIR = origDataDir;
      fs.rmSync(tmp, { recursive: true, force: true });
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
