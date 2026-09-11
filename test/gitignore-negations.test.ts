import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: __dirname,
  encoding: "utf8",
}).trim();

// A negation (`!path`) is unreachable if an earlier rule excludes a PARENT
// DIRECTORY outright: git does not descend into an excluded directory, so it
// never sees the file the negation is trying to re-admit. Nothing errors. The
// file is simply never tracked, and the rule still reads as though it works.
//
// This is not hypothetical. Three open PRs proposed
//   .sparkle/
//   !.sparkle/merge-policy.json
// which silently keeps merge-policy.json out. The working spelling excludes the
// directory's CONTENTS, leaving the negation reachable:
//   .sparkle/*
//   !.sparkle/merge-policy.json

/** A `!` line, resolved to the repo-relative path it re-admits. */
function negatedPaths(gitignore: string, rules: string): string[] {
  const dir = path.posix.dirname(gitignore);
  const prefix = dir === "." ? "" : dir + "/";
  return rules
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("!") && line.length > 1)
    .map((line) => prefix + line.slice(1).replace(/^\/+/, ""));
}

/**
 * Evaluate one .gitignore's own rules in ISOLATION, in a throwaway repo.
 *
 * Deliberately not `git check-ignore` against this checkout. That answers "is
 * this path ignored here", which folds in $GIT_DIR/info/exclude — and this
 * repo's shared git dir carries a bare `.sparkle/` there, so the live check
 * reports a correctly-written negation as shadowed and fails on exactly the
 * machine whose configuration motivated the rule. The question worth asking is
 * narrower: taken on their own, do the committed rules leave the negation
 * reachable?
 *
 * A fresh `git init` still reads the operator's global ignore, so
 * `core.excludesFile=/dev/null` is what actually makes this machine-independent
 * — without it a personal `.env*` or `.sparkle/` there fails this test on one
 * machine only, which is the same false failure the isolation exists to prevent.
 *
 * The rules are written at their real path inside the scratch repo so anchored
 * patterns (a leading or interior slash) resolve against the same directory
 * they do here; writing a nested file's rules at the root would silently
 * re-anchor them and let a genuinely unreachable negation pass.
 */
function isIgnoredByRulesAlone(gitignore: string, rules: string, relativePath: string): boolean {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ignore-neg-"));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    const target = path.join(scratch, gitignore);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, rules);

    const result = spawnSync(
      "git",
      ["-c", "core.excludesFile=/dev/null", "check-ignore", "-q", "--no-index", "--", relativePath],
      { cwd: scratch },
    );
    // 0 = ignored, 1 = not ignored; anything else is a real failure.
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git check-ignore failed on ${relativePath}: status ${result.status}`);
    }
    return result.status === 0;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function trackedGitignores(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "*.gitignore", ".gitignore"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

test("the reachability check can tell the two spellings apart", () => {
  // A positive control on THE HELPER, not on git. Without it the repo scan below
  // passes just as happily on a repo with no negations at all, or if the helper
  // silently stopped working — a wrong cwd, rules written to the wrong path, an
  // inverted status check. It queries a path that does not exist on disk, which
  // is what every real call does.
  assert.equal(isIgnoredByRulesAlone(".gitignore", "sub/\n!sub/keep.json\n", "sub/keep.json"), true);
  assert.equal(
    isIgnoredByRulesAlone(".gitignore", "sub/*\n!sub/keep.json\n", "sub/keep.json"),
    false,
  );

  // Anchoring survives for a nested .gitignore: an interior slash anchors to the
  // file's own directory, so the rules must be written there and not at the root.
  assert.equal(
    isIgnoredByRulesAlone("pkg/.gitignore", "/cache/\n!/cache/keep\n", "pkg/cache/keep"),
    true,
  );
  assert.equal(
    isIgnoredByRulesAlone("pkg/.gitignore", "/cache/*\n!/cache/keep\n", "pkg/cache/keep"),
    false,
  );
});

test("every .gitignore negation is reachable", () => {
  const unreachable: string[] = [];

  for (const gitignore of trackedGitignores()) {
    const rules = fs.readFileSync(path.join(REPO_ROOT, gitignore), "utf8");
    for (const negated of negatedPaths(gitignore, rules)) {
      if (isIgnoredByRulesAlone(gitignore, rules, negated)) {
        unreachable.push(`${gitignore} -> !${negated}`);
      }
    }
  }

  assert.deepEqual(
    unreachable,
    [],
    `A .gitignore negation is unreachable because a parent directory is excluded ` +
      `outright. git never descends into an excluded directory, so the negated path ` +
      `is silently never tracked. Exclude the directory's contents instead — ` +
      `"dir/*" rather than "dir/" — which leaves the negation reachable:\n  ` +
      unreachable.join("\n  "),
  );
});
