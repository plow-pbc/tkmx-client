# sparkle/agent-9b3c52ee-b077-45c6-8b0a-aa716928aa8f

## Progress Update as of 2026-09-01 13:05 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Acted on roborev #73871's finding that the previous commit's ignore guarantee was
asserted only by a throwaway scratch run: extended `test/gitignore.test.ts` to lock
the `.claude` pair the same way it already locks the `.env*` pair.

### Detail of changes made:
- `test/gitignore.test.ts`: added `.claude/settings.local.json` (must be ignored) and
  `.claude/settings.json` (must stay trackable) to the file's guarantee lists.
- The naive form of that assertion is VACUOUS on a developer machine, which is the
  interesting part. This clone's `.git/info/exclude` blanket-excludes `.claude/`, and
  an excluded DIRECTORY short-circuits: git never descends into it, so no rule in the
  tracked `.gitignore` is consulted for files underneath. `git check-ignore` in this
  worktree therefore answers "ignored" even with the protecting rule deleted — it
  masks the exact regression the test exists to catch, on the one machine where a
  human would otherwise see it.
- So `ignoredByRepoRules()` replays the repo's TRACKED ignore files into a throwaway
  `git init` repo that has no `info/exclude` and no user config (`core.excludesFile=/dev/null`),
  and asks there. That is the fresh-clone question, which is the one that matters for
  a public repo. Note `check-ignore -v` exits 0 on ANY match including a negation, so
  the verdict is read from the pattern (leading `!` = re-admitted), not the exit code.
- Verified NOT vacuous: with the `.gitignore` line removed the new test FAILS
  (`pass 2 / fail 1`); with it restored, `pass 3 / fail 0`. `.gitignore` was restored
  byte-identical afterwards (`git diff --stat` showed only the test file changed).

### Test baseline (measured, not assumed):
- `origin/main`: 276 tests, 271 pass, **5 fail**.
- This branch: 277 tests, 272 pass, **5 fail** — same 5 pre-existing failures
  (`agentsview.test.js`, `session-stats.test.js`; they depend on a real `~/.agentsview`
  on the host), plus exactly one new passing test. No regression from this branch.

### Beads activity:
- None. Scaffolding branch; no issues opened or closed.

### Potential concerns to address:
- The 5 pre-existing failures are host-environment-dependent and fail on `main` too.
  They pass in CI's fresh checkout, so they are a local-only annoyance, not a gate.
- PR #92 still cannot be merged by an agent (repo is pinned merge-protected).


## Progress Update as of 2026-09-01 (Pacific)
*(Most recent updates at top)*

### Summary of changes since last update
Acted on roborev job #73866's review of the bd-init commit: closed the machine-path
leak it found in `.claude/settings.local.json`, removed a redundant root ignore block,
and pinned the third-party installer URL in `.beads/README.md` to a commit SHA.

### Detail of changes made:
- `.gitignore`: added `.claude/settings.local.json`. This commit newly tracks
  `.claude/settings.json`, and the sibling local override holds 10 absolute
  `/Users/...` paths plus a permission allowlist. It was kept out only by
  `.git/info/exclude`, which is per-clone and inherited by nobody — the same
  non-portable protection this branch removed for `.beads/hooks/`.
- `.gitignore`: dropped the `bd init` beads/Dolt block. `.beads/.gitignore` already
  covers `proxieddb/`, `*.db` and `.beads-credential-key`, and root `.dolt/` never
  exists here (`dolt_mode: embedded` puts storage at `.beads/dolt/`). Root-level
  `*.db` was also unscoped and would swallow future fixtures anywhere in the tree.
- `.beads/README.md`: pinned `raw.githubusercontent.com/steveyegge/beads/main/...`
  to SHA `40b3232456dfcbe621ea66ee55d635ac56634a1e` so a curl|bash in a public repo
  can't execute whatever upstream `main` happens to contain at fetch time.
- Verified in a throwaway `git init` repo with no `.git/info/exclude`, i.e. what a
  fresh clone sees: `settings.local.json` IGNORED, `settings.json` TRACKABLE,
  `.beads/proxieddb/x` and `.beads/test.db` IGNORED by `.beads/.gitignore` alone.
- Earlier on this branch: untracked the `bd init`-generated `.beads/hooks/*` wrappers
  (absolute per-machine paths) and `.beads/interactions.jsonl`, deleted a stray
  `post-commit.bak-<ts>`, kept `.beads/metadata.json` tracked for `refs/dolt/data`
  sync identity, and rebased off a 198-commit-stale base onto `origin/main`.

### Beads activity:
- None. `bd init` scaffolding only; no issues opened or closed on this branch.

### Potential concerns to address:
- PR #92 cannot be merged by an agent: `plow-pbc/tkmx-client` is pinned
  merge-protected, so landing waits on a human.
- `bd init` itself is the upstream defect behind two of these fixes (bakes `$HOME`
  into hook wrappers, ships an unpinned curl|bash, creates rather than appends the
  root `.gitignore`). Worth reporting upstream rather than re-patching per repo.
