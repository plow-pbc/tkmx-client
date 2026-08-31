# Progress — sparkle/agent-20353c86-ff69-4bd2-bd78-66300b7da550

## Progress Update as of 2026-08-31, later Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Ran the project's quality gates for the first time on this branch. Typecheck is
clean; the test suite is NOT — 32 of 276 fail on current main, independent of
this branch (which touches no source). Narrowed the cause and recorded it on the
existing bead. Also made the `.sparkle/` worktree-dirtiness workaround durable.

### Detail of changes made:
- `npm run typecheck` — PASSES clean (`tsc --noEmit` + test project).
- `npm test` — tests 276, pass 240, **fail 32**, cancelled 4. Pre-existing: this
  branch's diff vs main is only `.gitignore`, `AGENTS.md`, `CLAUDE.md` and
  scaffolding dirs, so no source is implicated.
- Disproved the obvious PATH-leak theory for builder-index-client-trk: re-running
  with agentsview stripped from PATH gave pass 239 / fail 33 — no improvement.
  Real mechanism is `reporter/agentsview.ts:81`, which hard-codes the absolute
  candidates `/opt/homebrew/bin/agentsview` and `/usr/local/bin/agentsview`.
  These cannot be overridden by env, so any machine with agentsview installed
  fails the four `resolveAgentsview` tests that assert absence. Recorded on trk.
- Committed `.sparkle/` into `.gitignore` (`c357dd0`). It was only covered by a
  machine-local `.git/info/exclude`, which no fresh clone inherits.

### Beads activity:
- Commented on builder-index-client-trk with the reproduction, the disproved
  theory, the real mechanism, and a suggested injectable-candidates fix.

### Potential concerns to address:
- A red suite on main means no agent on this repo can honestly claim "tests pass"
  before committing. That undercuts the standing quality gate for everyone, not
  just this branch.
- The `collectCursorStats` failures look like the same class (real local Cursor
  DB leaking in) — `reporter/cursor.ts:9` `getCursorDbPath` is worth the same
  injectability check.

## Progress Update as of 2026-08-31, Pacific
*(Most recent updates at top)*

### Summary of changes since last update
No feature work was assigned to this branch. Its only content is the `bd init`
scaffolding commit. That commit was rebased from a 198-commit-stale base onto
current `origin/main`, and then hardened: the bd-init generator had baked an
absolute personal home path into four tracked hook scripts, which would have
entered permanent public history on merge. Landing remains a human decision
already tracked as builder-index-client-e5s; no competing PR was opened.

### Detail of changes made:
- Rebased onto `origin/main` (was 198 behind). One add/add conflict, `.gitignore`:
  resolved by keeping main's full ignore list AND appending the beads/Dolt block,
  rather than choosing one side.
- Hardened the scaffolding commit (now `bf4a021`): rewrote 5 absolute-home-path
  references to `$HOME` in `.beads/hooks/{post-checkout,post-merge,post-rewrite}`,
  and untracked `.beads/hooks/post-commit.bak-1783612946` (stray bd-init backup,
  carried a 6th copy of the path).
- Verified: `bash -n` passes on all 8 `.beads/hooks` scripts; `git grep` finds no
  absolute personal home path in the tracked tree (remaining `/Users/` hits are
  `alice`/`someone` test fixtures in `test/`).
- Deliberately did NOT open a PR. PR 69 already carries this exact scaffolding
  decision; a second PR would split a human call across two branches.

### Beads activity:
- Opened builder-index-client-gy3 (P1 bug): bd init bakes an absolute personal
  home path into committed hooks — a generator defect that every new agent
  worktree reproduces, not a one-off. Blocks builder-index-client-e5s.
- Commented on builder-index-client-e5s recording the second independent sighting
  and noting the `.bak` deletion should be carried into PR 69 as well.

### Potential concerns to address:
- The leaked hooks are not just a privacy issue: on any machine whose home dir
  differs, the `-x` gate fails and the roborev review hook silently never runs.
  A gate that looks installed but does nothing is the worse half of this bug.
- Per-branch `sed` fixes do not stop the next `bd init` from reintroducing it;
  the fix belongs in the generator (builder-index-client-gy3).
- `npm ci` / the test suite cannot run in this worktree (better-sqlite3 vs the
  local Node), tracked as builder-index-client-cvq. This commit touches only
  shell scripts, which were verified with `bash -n` instead.
