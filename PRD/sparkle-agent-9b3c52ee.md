# sparkle/agent-9b3c52ee-b077-45c6-8b0a-aa716928aa8f

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
