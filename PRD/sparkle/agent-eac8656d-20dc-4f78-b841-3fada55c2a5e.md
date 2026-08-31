# Branch: sparkle/agent-eac8656d-20dc-4f78-b841-3fada55c2a5e

## Progress Update as of 2026-08-23 14:15 PT
*(Most recent updates at top)*

### Summary of changes since last update
Fifth roborev round: four of its six findings applied, one was already fixed, one
declined with a reason. CI is green on the preceding head; the branch is complete
apart from the merge, which policy reserves for a human.

### Detail of changes made:
- `test/beads-pre-push-hook.test.ts`: the scratch repo now runs with
  `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`, which subsumes the
  `core.hooksPath` line it replaces. A developer with `commit.gpgsign = true` set
  globally would otherwise have every test in the file fail at `git commit`, for a
  reason having nothing to do with the hook.
- `test/beads-pre-push-hook.test.ts`: added the gate's missing branch — a FAIL verdict
  whose `git_ref` is NOT in this push must still allow the push. That is the branch
  with the worst failure mode (a false positive blocks every push with no exit short
  of `--no-verify`), and no existing case reached it.
- `.beads/.gitignore` + `git rm --cached`: stopped tracking `.beads/interactions.jsonl`.
  It is an append-only local runtime log, currently empty; tracked in a public repo it
  would start riding along on `git commit -a` as soon as bd wrote to it.
- `AGENTS.md`: mirrored CLAUDE.md's repo-specific sections (Build & Test, Architecture,
  Conventions — including "this repository is public: never commit an absolute home
  directory path"). Codex-family agents read only AGENTS.md, so they were missing the
  very rule that drove squashing this branch. Appended outside the managed beads block
  so a `bd` rewrite of that block cannot eat it.

### Declined, with reason:
- Roborev asked to drop `.dolt/`, `.beads-credential-key` and `.beads/proxieddb/` from
  the root `.gitignore` as duplicates of `.beads/.gitignore`. Declined: `.beads/.gitignore`
  is bd-generated and a bd upgrade can rewrite it, so the root entry is the durable half
  of a never-commit-a-credential guarantee — and `test/gitignore.test.ts` now asserts it.
  Two sources of truth is the point here, not an oversight.
- Its unquoted `$ROBOREV` finding was already fixed in the previous round (this review
  ran against an earlier amend sha).

### Beads activity:
- None. This branch is the beads scaffolding itself; no issues opened or closed.

### Potential concerns to address:
- The merge is refused by policy (repo pinned merge-protected); a human must perform it.

## Progress Update as of 2026-08-23 13:55 PT
*(Most recent updates at top)*

### Summary of changes since last update
Fourth roborev round (six Low findings) applied in full and folded into the single
commit. Nothing outstanding on this branch except the merge itself, which this agent
is not permitted to perform.

### Detail of changes made:
- `.beads/hooks/pre-push`: quoted `"$ROBOREV"` in the `list --json` call. It was the
  one unquoted use of a variable the same function quotes twice elsewhere, and because
  the gate is fail-open, a resolved path containing a space would have word-split and
  silently passed every push with no sign the FAIL check was skipped.
- `.beads/hooks/pre-push` + test comments: removed the claim that beads' `perl` branch
  exec-replaces the hook shell. It does not — perl is an ordinary child there, which
  is why `_bd_exit=$?` on the next line works — and a maintainer who believed it would
  read the exit-code handling below as dead code. The unlink stays; the real reason is
  that an open fd survives the unlink, so no exit path needs cleanup.
- `test/beads-pre-push-hook.test.ts`: strips `GIT_*` from the child env. git exports
  `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_OBJECT_DIRECTORY` to the hooks it
  runs and this repo installs hooks, so a suite run from under one would have aimed the
  scratch-repo git calls at the REAL repository's index.
- `test/beads-pre-push-hook.test.ts`: the mktemp-failure test now asserts stderr matches
  /mktemp failed/. That branch exists to be loud; without the assertion, deleting the
  `echo` restores the silent skip this hook was rewritten to kill and the suite stays
  green. Also folded the two `tmpLeftovers` duplicates into the existing cases (~22
  lines and two hook invocations less).
- `test/gitignore.test.ts`: added `.beads-credential-key` to `MUST_BE_IGNORED`. This
  commit introduces a never-commit credential to a public repo; the other rule covering
  it lives in bd-generated `.beads/.gitignore`, which a bd upgrade can rewrite, so the
  root entry is the durable half and now something asserts it.

### Beads activity:
- None. This branch is the beads scaffolding itself; no issues opened or closed.

### Potential concerns to address:
- Unchanged: `AGENTS.md`/`CLAUDE.md` duplication is real but belongs in a follow-up,
  and the merge is refused by policy (repo is pinned merge-protected) so a human must
  perform it.

## Progress Update as of 2026-08-23 13:20 PT
*(Most recent updates at top)*

### Summary of changes since last update
Third roborev round on the squashed commit found one genuine leak risk and three
hygiene items; all four are addressed and folded into the single commit. The PR is
green and waiting on a human — Sparkle is forbidden from merging this repo.

### Detail of changes made:
- `.gitignore`: added `.claude/settings.local.json`. This commit is what makes
  `.claude/` a tracked directory for the first time, and that file holds ten
  machine-absolute path lines while being kept out of `git status` ONLY by this
  machine's personal `~/.config/git/ignore`. On any other clone a `git add -A`
  would have published it — exactly the leak the squash exists to prevent.
- `.beads/hooks/pre-push`: the spool file is unlinked as soon as its fd is open
  rather than on an EXIT trap. Roborev's stated reason (the beads block's `perl`
  branch exec-replacing the shell) is wrong — perl is a child there, so the trap
  does fire, and a leak test passes against both forms. Kept anyway: it survives
  exit paths a trap does not, and two tests now assert an empty private TMPDIR.
- `test/beads-pre-push-hook.test.ts`: the scratch repo sets
  `core.hooksPath=/dev/null`, so the suite stops running this machine's global git
  hooks against five throwaway repos per run. Side effect: the tests got ~6x faster
  (roughly 5s to under 1s each).
- `CLAUDE.md`: replaced the "_Add your build and test commands here_" placeholders
  with the real commands, the environment-dependent-test warning, and the actual
  layout. First draft said `src/reporter/`; the code is at `reporter/` — corrected
  after checking rather than shipping the guess.

### Beads activity:
- None. This branch is the beads scaffolding itself; no issues opened or closed.

### Potential concerns to address:
- Roborev's fourth finding — `AGENTS.md` and `CLAUDE.md` duplicate ~70 lines and have
  already drifted — is real but deliberately NOT fixed here. Both files are partly
  regenerated by beads tooling, so symlinking them is a change to how that tooling
  is used, not to this scaffolding PR. Worth a follow-up.
- The merge itself is not available to this agent: the repo is pinned
  merge-protected, so `gh pr merge` is refused by policy and a human must merge.

## Progress Update as of 2026-08-23 12:45 PT
*(Most recent updates at top)*

### Summary of changes since last update
Squashed the branch to a single commit so the personal absolute home path that the
original `bd init` commit wrote into three hook files never lands in this PUBLIC
repo's permanent `main` history — the `$HOME` fix existed only as a later commit, so
merging would have preserved the path in history forever. Also closed a second
roborev round on the pre-push hook: a failed `mktemp` was silently skipping beads.

### Detail of changes made:
- `git reset --soft origin/main` + one commit. The pre-squash tip is kept locally on
  `backup-pre-squash-b2789ea` in case the intermediate history is ever wanted. The
  landed tree is identical to what the 4-commit version produced.
- `.beads/hooks/pre-push`: `mktemp` failure no longer exits 0. The roborev gate is
  fail-open by design, but beads' lifecycle is not; an unwritable `$TMPDIR` now prints
  a message, skips only the roborev gate, and still hands stdin to `bd hooks run
  pre-push`. Covered by a test that stubs a failing `mktemp` (it fails against the
  `|| exit 0` variant).

### Beads activity:
- None. This branch is the beads scaffolding itself; no issues opened or closed.

### Potential concerns to address:
- The already-pushed commits `1962166`/`b2789ea` remain reachable on GitHub via the
  PR's refs, so the squash keeps the path out of `main`'s history but does not unpublish
  it. Nothing further is possible from this side without deleting the PR.

## Progress Update as of 2026-08-23 12:20 PT
*(Most recent updates at top)*

### Summary of changes since last update
Triaged the roborev FAIL review that was blocking the push of `d0a3ae4`. One of its
two findings was real and is fixed (the hook's stdin replay had no test coverage);
the other — a claimed command injection through the heredoc — was checked and does
not reproduce, but the hook now spools stdin to a file anyway, which is simpler and
byte-exact.

### Detail of changes made:
- `.beads/hooks/pre-push`: stdin is spooled to a `mktemp` file (`cat > "$_hook_stdin"`,
  cleaned up on a trap) instead of captured into a shell variable and replayed through
  two unquoted heredocs. Both gates now read the same file; the beads block gets it via
  `exec 0< "$_hook_stdin"`.
- Verified directly that an unquoted heredoc does NOT rescan the expanded value of
  `$_hook_stdin`, so the reviewer's `refs/heads/a$(touch x)` injection never executed.
  Recorded here so a future reader doesn't re-litigate it. The file round-trip is kept
  on its own merits: `$(cat)` drops trailing newlines and cannot carry NULs.
- `test/beads-pre-push-hook.test.ts`: the `bd` stub now records its stdin as well as its
  argv, and the tests assert the pushed sha actually reaches beads. Added a fourth test
  asserting a ref line containing `$( )` and backticks arrives at beads unchanged.
  Confirmed the new assertions have teeth: deleting the `exec 0<` line fails 3 of 4 tests.

### Beads activity:
- None. This branch is the beads scaffolding itself; no issues opened or closed.

### Potential concerns to address:
- The full local suite has 77 failures, but an `origin/main` worktree run produces the
  same 77 — they are environment-dependent (real agentsview binary / real agent homes on
  this machine), pre-existing, and CI is green. Not introduced by this branch.
