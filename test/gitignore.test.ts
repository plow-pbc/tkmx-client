import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

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

// The template is the one .env* file that must stay committable.
const MUST_NOT_BE_IGNORED = [".env.example"];

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

test("backups of .env are git-ignored so a credential can't be committed", () => {
  for (const candidate of MUST_BE_IGNORED) {
    assert.ok(
      checkIgnore(candidate, { rulesOnly: false }),
      `${candidate} must be git-ignored — it contains a live API_KEY and this repo is public`,
    );
  }
});

test(".env.example stays committable despite the broad .env* rule", () => {
  for (const candidate of MUST_NOT_BE_IGNORED) {
    assert.ok(
      !checkIgnore(candidate, { rulesOnly: true }),
      `${candidate} must NOT be excluded by the ignore rules — the .env* rule needs its "!" negation intact`,
    );
  }
});

// Sparkle drops `.sparkle/merge-policy.json` into every agent worktree it cuts.
// Nothing here reads it, and an unignored marker keeps the worktree permanently
// dirty — enough for teardown to refuse and strand it.
//
// This asserts the rule is COMMITTED, not merely that the path is ignored: a
// machine carrying a local `.sparkle/` exclude (this one does, in two places)
// would pass a plain `check-ignore` on a checkout where the fix was never made,
// stranding the next agent behind a green suite. Hence a `.gitignore:` prefix on
// `check-ignore -v` — every override prints a different anchor
// (`.git/info/exclude:`, `/Users/<someone>/.gitignore:`).
test("Sparkle's per-worktree marker is ignored by the committed .gitignore", () => {
  const output = execFileSync(
    "git", ["check-ignore", "-v", "--no-index", ".sparkle/merge-policy.json"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.ok(
    output.startsWith(".gitignore:"),
    `.sparkle/ must be ignored by the committed .gitignore, not by a local override — got "${output.trim()}". A .git/info/exclude or core.excludesFile workaround only helps the machine that made it.`,
  );
});
