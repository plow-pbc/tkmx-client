import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const REPO_ROOT = path.join(__dirname, "..", "..");

// A single `.env*` rule covers `.env` itself and every backup spelling of it,
// and `!.env.example` re-admits the tracked template. Both halves matter: this
// repo is public, so an untracked `.env*` holding a live API_KEY is one
// `git add -A` away from publishing a credential — while over-broad ignoring
// would quietly drop the template from the repo.
//
// The lists below assert those halves. They test real `git check-ignore`
// behaviour rather than matching literal .gitignore lines, so reformatting the
// file cannot silently drop either guarantee.
const MUST_BE_IGNORED = [
  ".env",
  ".env.bak-20260724",
  ".env.bak-concierge-20260806-021701",
  // Hand-rolled backups don't follow one convention, so cover the class.
  ".env.bak",
  ".env.backup",
  ".env.old",
  ".env.2",
  ".env.save",
];

// The same two halves, for the other secret-shaped pair this repo tracks.
// `.claude/settings.json` is committed, so its sibling local override is one
// `git add -A` from following it in: settings.local.json holds absolute
// per-machine paths and a permission allowlist. Nothing but a per-clone
// `.git/info/exclude` used to keep it out, and no other clone inherits that.
const MUST_BE_IGNORED_BY_REPO_RULES = [".claude/settings.local.json"];

// The template is the one .env* file that must stay committable, and
// settings.json is the half of the .claude pair the repo means to track.
const MUST_NOT_BE_IGNORED = [".env.example", ".claude/settings.json"];

// "Would this file escape into a commit?" — asked of this working tree, index
// and all. A *tracked* path reports as not-ignored whatever the rules say, so a
// backup that somehow got staged trips the alarm rather than hiding behind its
// own ignore rule. That index-awareness is the point for the secret files.
//
// `git check-ignore` exits 0 when the path is ignored, 1 when it is not.
function checkIgnore(relativePath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", relativePath], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch (err) {
    // Exit 1 is the real answer "not ignored". Anything else is git failing
    // (128 when there's no work tree, for instance), and swallowing that would
    // make the NEGATIVE assertions below pass vacuously — they cannot otherwise
    // tell "the rules re-admit this file" from "git never ran".
    if ((err as { status?: number }).status !== 1) throw err;
    return false;
  }
}

// A different question: "what would a FRESH CLONE do with this path?" — do the
// ignore rules this repo actually ships decide its fate, with no help from
// local state?
//
// Asking git in this working tree can't answer that, and fails silently when it
// can't. This clone's `.git/info/exclude` blanket-excludes `.claude/`, and an
// excluded DIRECTORY short-circuits: git never descends into it, so no rule in
// the tracked `.gitignore` is ever consulted for a file underneath. The local
// answer would be "ignored" even with the protecting rule deleted — masking, on
// the one machine where a human would otherwise notice, exactly the regression
// these assertions exist to catch.
//
// So replay the tracked ignore files into a throwaway repo that has no
// `info/exclude` and no user config, and ask there. Rules-only (`--no-index`)
// because nothing is tracked in that repo; the exit status handles negations on
// its own, since a negated match is reported as not-ignored.
function ignoredByRepoRules(relativePath: string): boolean {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-rules-"));
  try {
    execFileSync("git", ["init", "-q", "--template=", scratch], { stdio: "ignore" });

    const tracked = execFileSync("git", ["ls-files", "--", ".gitignore", "*/.gitignore"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    for (const ignoreFile of tracked) {
      const dest = path.join(scratch, ignoreFile);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, ignoreFile), dest);
    }

    try {
      execFileSync(
        "git",
        ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--quiet", relativePath],
        { cwd: scratch, stdio: "ignore" },
      );
      return true;
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err;
      return false;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test("backups of .env are git-ignored so a credential can't be committed", () => {
  for (const candidate of MUST_BE_IGNORED) {
    assert.ok(
      checkIgnore(candidate),
      `${candidate} must be git-ignored — it contains a live API_KEY and this repo is public`,
    );
  }
});

test("files the repo means to track are not excluded by its own rules", () => {
  for (const candidate of MUST_NOT_BE_IGNORED) {
    assert.ok(
      !ignoredByRepoRules(candidate),
      `${candidate} must NOT be excluded by the repo's ignore rules — .env.example needs the "!" negation intact, and .claude/settings.json must not be caught by the settings.local.json rule`,
    );
  }
});

test("machine-specific .claude settings are ignored by the repo's own rules", () => {
  for (const candidate of MUST_BE_IGNORED_BY_REPO_RULES) {
    assert.ok(
      ignoredByRepoRules(candidate),
      `${candidate} must be ignored by a rule this repo ships, not by a per-clone .git/info/exclude — it holds absolute machine paths and this repo is public`,
    );
  }
});
