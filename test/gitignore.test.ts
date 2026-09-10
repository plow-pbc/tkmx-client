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
function checkIgnore(
  relativePath: string,
  opts: { rulesOnly: boolean; cwd?: string; isolated?: boolean },
): boolean {
  // `isolated` cuts the two host-level sources check-ignore would otherwise
  // read: the user's core.excludesFile (falling back to ~/.config/git/ignore).
  const args = opts.isolated ? ["-c", "core.excludesFile=/dev/null"] : [];
  args.push("check-ignore", "--quiet");
  if (opts.rulesOnly) args.push("--no-index");
  args.push(relativePath);

  try {
    execFileSync("git", args, { cwd: opts.cwd ?? REPO_ROOT, stdio: "ignore" });
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

// The `.sparkle/` rule has to do two opposite things at once: exclude the
// per-worktree state the desktop app writes, while keeping the one tracked
// marker committable. Spelling it `.sparkle/` instead of `.sparkle/*` breaks
// the second half INVISIBLY — git never descends into an excluded directory,
// so the `!` negation below it is unreachable and the marker silently drops
// out of the repo. That happened here once, one commit after the marker was
// deliberately added.
//
// These assertions deliberately do NOT run `git check-ignore` in this repo.
// A developer's `.git/info/exclude` is machine-local, is shared across every
// worktree via the common dir, and OVERRIDES the committed rules — this repo's
// own agent tooling writes a blanket `.sparkle/` line into it. An in-repo probe
// therefore reports whatever that local file says and passes in CI while
// failing on the machine of the person who has to fix it.
//
// So: evaluate the COMMITTED .gitignore, and only that, in a throwaway repo
// that has no index, no info/exclude, no init template and no global excludes
// file. Same question, genuinely host-independent answer.
function ignoredByCommittedRules(candidates: string[]): Map<string, boolean> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-rules-"));
  try {
    // --template= stops git copying an info/exclude in from init.templateDir.
    execFileSync("git", ["init", "-q", "--template=", sandbox], { stdio: "ignore" });
    fs.copyFileSync(path.join(REPO_ROOT, ".gitignore"), path.join(sandbox, ".gitignore"));

    const answers = new Map<string, boolean>();
    for (const candidate of candidates) {
      // check-ignore needs the path to be plausible, not to exist, but a
      // directory component must not be mistaken for a file.
      fs.mkdirSync(path.join(sandbox, path.dirname(candidate)), { recursive: true });
      fs.writeFileSync(path.join(sandbox, candidate), "");
      answers.set(
        candidate,
        checkIgnore(candidate, { rulesOnly: true, cwd: sandbox, isolated: true }),
      );
    }
    return answers;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const SPARKLE_APP_STATE = [
  ".sparkle/session-state.json",
  ".sparkle/whatever.log",
  ".sparkle/nested/thing.json",
];

test("the committed .sparkle rules ignore app state but keep the marker", () => {
  const answers = ignoredByCommittedRules([
    ...SPARKLE_APP_STATE,
    ".sparkle/merge-policy.json",
  ]);

  for (const appState of SPARKLE_APP_STATE) {
    assert.ok(
      answers.get(appState),
      `${appState} must be ignored — it is per-worktree app state, not repo content`,
    );
  }

  assert.equal(
    answers.get(".sparkle/merge-policy.json"),
    false,
    ".sparkle/merge-policy.json must NOT be excluded — a bare `.sparkle/` rule would " +
      "make its negation unreachable and silently untrack the marker",
  );
});
