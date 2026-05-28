import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import { parseAgentsviewOutput, toIsoDate, collectAgentsviewUsage, resolveAgentsviewWith } from "../reporter/agentsview";

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
    const daily = parseAgentsviewOutput(sample(), "claude");
    assert.equal(daily[0].modelBreakdowns[0].cost, 1.23);
    assert.equal(daily[0].modelBreakdowns[1].cost, 0.05);
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

describe("collectAgentsviewUsage WARP_DIR scoping", () => {
  // A fake agentsview that records the WARP_DIR it received plus its args,
  // then emits empty daily JSON so the caller parses cleanly. Proves the
  // Warp-skip is scoped to the syncing call (the only one that runs the
  // parser registry that hangs an unattended daemon), not the --no-sync one.
  it("sets WARP_DIR=/var/empty on the syncing claude call but not the --no-sync codex call", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-warp-"));
    try {
      const logPath = path.join(tmp, "calls.log");
      const fakeBin = path.join(tmp, "agentsview");
      writeExec(
        fakeBin,
        `#!/bin/sh\necho "WARP_DIR=\${WARP_DIR}|$*" >> "${logPath}"\necho '{"daily":[]}'\n`,
      );

      collectAgentsviewUsage(fakeBin, "20260501");

      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      const claudeLine = lines.find((l) => l.includes("--agent claude"));
      const codexLine = lines.find((l) => l.includes("--agent codex"));
      assert.match(claudeLine, /WARP_DIR=\/var\/empty\|/);
      assert.ok(codexLine.includes("--no-sync"), "codex call should pass --no-sync");
      assert.doesNotMatch(codexLine, /WARP_DIR=\/var\/empty\|/);
    } finally {
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
