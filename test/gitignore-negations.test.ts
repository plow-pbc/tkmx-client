import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: __dirname,
  encoding: "utf8",
}).trim();

// A negation (`!path`) is unreachable if any earlier rule excludes a PARENT
// DIRECTORY outright: git does not descend into an excluded directory, so it
// never sees the file the negation is trying to re-admit. The rule still reads
// as if it works, and nothing fails — the file is simply never tracked.
//
// This is not hypothetical. Three open PRs proposed
//   .sparkle/
//   !.sparkle/merge-policy.json
// which silently keeps merge-policy.json out. The working spelling excludes the
// directory's CONTENTS instead, leaving the negation reachable:
//   .sparkle/*
//   !.sparkle/merge-policy.json
//
// Rather than re-implement gitignore matching, ask git: for every negated path,
// git must agree the path is NOT ignored. `--no-index` so a path that does not
// exist on disk still answers.

function negatedPaths(gitignore: string): string[] {
  const dir = path.posix.dirname(gitignore) === "." ? "" : path.posix.dirname(gitignore) + "/";
  return fs
    .readFileSync(path.join(REPO_ROOT, gitignore), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("!") && line.length > 1)
    .map((line) => dir + line.slice(1).replace(/^\/+/, ""));
}

/**
 * Evaluate a .gitignore's own rules in ISOLATION, in a throwaway repo.
 *
 * Deliberately not `git check-ignore` against this checkout: that answers
 * "is this path ignored here", which folds in `$GIT_DIR/info/exclude` and any
 * global excludesFile. This repo's shared git dir carries a bare `.sparkle/`
 * in info/exclude, so the live check reports a correctly-written negation as
 * shadowed and the test fails on a rule that is fine. What we want to know is
 * narrower and machine-independent: taken on their own, do the committed rules
 * leave each negation reachable?
 */
function isIgnoredByRulesAlone(rules: string, relativePath: string): boolean {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ignore-neg-"));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    fs.writeFileSync(path.join(scratch, ".gitignore"), rules);
    const result = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", relativePath], {
      cwd: scratch,
    });
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

test("every .gitignore negation is reachable", () => {
  const unreachable: string[] = [];

  for (const gitignore of trackedGitignores()) {
    const rules = fs.readFileSync(path.join(REPO_ROOT, gitignore), "utf8");
    for (const negated of negatedPaths(gitignore)) {
      // A negation that git still reports as ignored has been shadowed by a
      // parent-directory exclusion earlier in the file.
      if (isIgnoredByRulesAlone(rules, negated)) unreachable.push(`${gitignore} -> !${negated}`);
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

test("the check can actually fail", () => {
  // A positive control. Without this, the test above passes just as happily on a
  // repo with no negations at all, or if `isIgnored` silently stopped working.
  const scratch = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ignore-neg-"));
  try {
    execFileSync("git", ["init", "-q", scratch]);
    fs.mkdirSync(path.join(scratch, "sub"));
    fs.writeFileSync(path.join(scratch, "sub", "keep.json"), "{}\n");

    const check = (rules: string) => {
      fs.writeFileSync(path.join(scratch, ".gitignore"), rules);
      return spawnSync("git", ["check-ignore", "-q", "--no-index", "--", "sub/keep.json"], {
        cwd: scratch,
      }).status;
    };

    // Bare directory exclusion shadows the negation: git still calls it ignored.
    assert.equal(check("sub/\n!sub/keep.json\n"), 0);
    // Excluding the contents leaves the negation reachable.
    assert.equal(check("sub/*\n!sub/keep.json\n"), 1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
