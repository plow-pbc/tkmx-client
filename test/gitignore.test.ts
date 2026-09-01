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
// The two lists below assert those halves. They test real `git check-ignore`
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

// The same two halves, for the other secret-shaped file this repo tracks.
// `.claude/settings.json` is committed, so its sibling local override is one
// `git add -A` from following it in: settings.local.json holds absolute
// per-machine paths and a permission allowlist. Nothing but a per-clone
// `.git/info/exclude` used to keep it out, and no other clone inherits that.
const MUST_BE_IGNORED_BY_REPO_RULES = [".claude/settings.local.json"];

// The template is the one .env* file that must stay committable, and
// settings.json is the half of the .claude pair the repo means to track.
const MUST_NOT_BE_IGNORED = [".env.example", ".claude/settings.json"];

// `git check-ignore` exits 0 when the path is ignored, 1 when it is not.
//
// The two call sites want DIFFERENT questions answered, which is why the
// --no-index flag is a per-case decision rather than a constant:
//
//   index-aware (default) — "would this file escape into a commit?" A *tracked*
//     path is reported as not-ignored regardless of the rules, so a backup that
//     somehow got staged trips the alarm. This is what the secret files need.
//
//   rules-only (--no-index) — "do the ignore rules exclude this?" Needed for a
//     file that is already tracked, where the index-aware answer is a foregone
//     "not ignored" and would make the assertion vacuous.
function checkIgnore(relativePath: string, opts: { rulesOnly: boolean }): boolean {
  const args = ["check-ignore", "--quiet"];
  if (opts.rulesOnly) args.push("--no-index");
  args.push(relativePath);

  try {
    execFileSync("git", args, { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch (err) {
    // Exit 1 is the real answer "not ignored". Anything else is git failing
    // (128 when there's no work tree, for instance), and swallowing that would
    // make the NEGATIVE assertion below pass vacuously — it cannot otherwise
    // tell "the rules re-admit this file" from "git never ran".
    if ((err as { status?: number }).status !== 1) throw err;
    return false;
  }
}

// A third question the two modes above can't answer: "what would a FRESH CLONE
// do with this path?" — i.e. do the ignore rules this repo actually ships
// decide its fate, with no help from local state?
//
// The local answer is untrustworthy here, and silently so. This clone's
// `.git/info/exclude` blanket-excludes `.claude/`, and an excluded DIRECTORY
// short-circuits: git never descends into it, so no rule in the tracked
// `.gitignore` is ever consulted for a file underneath. Asking git in this
// working tree would report `.claude/settings.local.json` ignored even if the
// rule protecting it were deleted — masking, on the one machine where it would
// otherwise show up, exactly the regression this file exists to catch.
//
// So replay the tracked ignore files into a throwaway repo that has no
// `info/exclude` and no user config, and ask there. Rules-only (`--no-index`),
// because nothing is tracked in that repo. `-v` exits 0 on ANY match including
// a negation, so the verdict is in the pattern: a leading "!" re-admits.
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

    let output: string;
    try {
      output = execFileSync(
        "git",
        ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-v", relativePath],
        { cwd: scratch, encoding: "utf8" },
      );
    } catch (err) {
      // Exit 1 is "no rule matched", i.e. not ignored. Anything else is git
      // failing, and swallowing that would make these assertions vacuous.
      if ((err as { status?: number }).status !== 1) throw err;
      return false;
    }

    // "<source>:<line>:<pattern>\t<path>"
    const pattern = output.split("\t")[0]!.split(":")[2]!;
    return !pattern.startsWith("!");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test("backups of .env are git-ignored so a credential can't be committed", () => {
  for (const candidate of MUST_BE_IGNORED) {
    assert.ok(
      checkIgnore(candidate, { rulesOnly: false }),
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
