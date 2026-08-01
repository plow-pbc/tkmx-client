import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";

// config-stack reads from fixed paths, so we test the individual helpers
// by checking they return sane types and don't crash on missing data
import {
  collectMcpServers,
  collectHooks,
  collectClaudeMdStats,
  collectEnvironment,
} from "../reporter/config-stack";

describe("config-stack", () => {
  describe("collectMcpServers", () => {
    it("returns an array", () => {
      const result = collectMcpServers();
      assert.ok(Array.isArray(result));
    });

    it("never includes credentials or URLs", () => {
      const result = collectMcpServers();
      const serialized = JSON.stringify(result);
      // Should only contain server names, not URLs or tokens
      assert.ok(!serialized.includes("http"));
      assert.ok(!serialized.includes("Bearer"));
      assert.ok(!serialized.includes("sk-"));
    });
  });

  describe("collectHooks", () => {
    it("returns events array and count", () => {
      const result = collectHooks();
      assert.ok(Array.isArray(result.events));
      assert.equal(typeof result.count, "number");
    });
  });

  describe("collectClaudeMdStats", () => {
    it("returns global_loc and project_count", () => {
      const result = collectClaudeMdStats();
      assert.equal(typeof result.global_loc, "number");
      assert.equal(typeof result.project_count, "number");
    });

    it("never includes file content", () => {
      const result = collectClaudeMdStats();
      const serialized = JSON.stringify(result);
      // Only numbers, no actual CLAUDE.md content
      assert.ok(!serialized.includes("NEVER"));
      assert.ok(!serialized.includes("git"));
    });
  });

  describe("collectEnvironment", () => {
    it("reports the shell as a bare name, not the full path", () => {
      const origShell = process.env.SHELL;
      process.env.SHELL = "/usr/bin/fish";
      try {
        assert.equal(collectEnvironment().shell, "fish");
      } finally {
        if (origShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = origShell;
      }
    });

    it("never includes HOME or sensitive env vars", () => {
      const result = collectEnvironment();
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(os.homedir()));
      assert.ok(!serialized.includes("API_KEY"));
    });

    it("falls back to COMSPEC for shell when SHELL is unset (Windows)", () => {
      const origShell = process.env.SHELL;
      const origComspec = process.env.COMSPEC;
      delete process.env.SHELL;
      process.env.COMSPEC = "cmd.exe"; // separator-free so basename is host-independent
      try {
        assert.equal(collectEnvironment().shell, "cmd.exe");
      } finally {
        if (origShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = origShell;
        if (origComspec === undefined) delete process.env.COMSPEC;
        else process.env.COMSPEC = origComspec;
      }
    });
  });
});
