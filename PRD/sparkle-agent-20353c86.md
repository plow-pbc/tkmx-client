# Progress — sparkle/agent-20353c86-ff69-4bd2-bd78-66300b7da550

## Progress Update as of 2026-08-31, late night Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Applied the lesson from the duplicate-PR cleanup before starting anything: checked
open PRs, remote branches and git history for prior art, then picked an
unclaimed bead (cko) and shipped it as PR 88 — green, and deliberately shaped to
collide with nothing.

### Detail of changes made:
- Pre-flight check, which is the part worth repeating: `gh pr list --search`,
  `git log --all --grep`, and `git log --all -- <path>` all came back empty for
  builder-index-client-cko, so it was genuinely unclaimed. That check is what
  PRs 86/87 lacked.
- PR 88: new `docs/merge-verification.md`. GitHub populates `merge_commit_sha`
  on OPEN PRs with its speculative test-merge commit; an agent reading that field
  reports a merged sha for an unmerged PR. Documents the two reliable signals
  (`merged`/`mergedAt`, and `git merge-base --is-ancestor <head-sha> origin/main`
  after a fetch) and prefers the ancestor check, which survives squash and rebase.
- Placement was the real design decision. AGENTS.md is the obvious home, but four
  in-flight branches already edit AGENTS.md/CLAUDE.md and that decision is parked
  in e5s. A fifth variant would have conflicted and buried the guidance behind an
  unrelated call, so PR 88 adds ONE new file and supplies the one-line link for
  whichever guidance file eventually lands.
- All 4 checks green, mergeStateStatus CLEAN. Temp worktree removed.

### Beads activity:
- Claimed builder-index-client-cko; left it in_progress, not closed — the
  acceptance is that agents can READ the guidance, which is false until it merges.
- Added evidence to builder-index-client-9fn: 18 of 25 in_progress beads are
  babysit duplicates of just four PRs (#69 x6, #70 x4, #72 x4, #74 x5). Agents
  duplicate the beads about PRs as readily as the PRs themselves.

### Potential concerns to address:
- Everything I produce now queues behind one human merge gate. Four of my
  outputs are green-and-waiting or withdrawn; none has landed.
- The babysit-bead pile suggests a narrower fix than 9fn's current design: a
  bead whose title names a PR number should attach to an existing open bead for
  that PR rather than create a sibling.

## Progress Update as of 2026-08-31, night Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Opened PRs 86 and 87, then discovered both were duplicates of older agents' work
and CLOSED them. `git worktree list` revealed sibling worktrees already carrying
the same two fixes. The open-PR list holds three separate TRIPLICATES; filed that
as its own bug, because it is a bigger problem than either fix.

### Detail of changes made:
- Opened PR 86 (agentsview test isolation) and PR 87 (.sparkle/ gitignore), both
  green on all 4 checks, both cut clean off origin/main.
- Then listed all open PRs and found the duplication:
  - `.sparkle/` one-liner: PR 83, PR 84, and my 87.
  - agentsview host-independent tests: PR 70 (Aug 17), PR 85, and my 86.
  - beads scaffolding: PR 69 (Aug 17), PR 80, PR 81.
  Nine of fourteen open PRs are three pieces of work.
- Verified PR 70 is strictly broader than my 86 — same `isExecutableFile` export
  plus a host fence, AND a better-sqlite3 bump that unbreaks Node 26, AND a CI
  node-version matrix. That last part fixes the 28 binding failures my PR could
  only document. So mine was a subset, not an alternative.
- Closed 86 and 87 with pointers to the older PRs and deleted both branches.
  Reviewer attention is the scarce resource; a third variant costs more than it
  adds.

### Beads activity:
- Opened builder-index-client-9fn (P1 bug): agents duplicate each other's work
  because nothing in the ramp-up path shows what is already in flight.
- Updated the stored memory for the .sparkle/ worktree-dirtiness issue to point
  at the in-flight PRs rather than restating the problem.

### Potential concerns to address:
- I could not have caught this from `bd ready` alone — it shows unclaimed beads,
  not in-flight branches or open PRs. `git worktree list` is what exposed it, by
  accident. That is the gap 9fn is about.
- Commit c48f97f on this branch is now superseded by PR 70. It is kept only as
  the record behind the trk closure; it should NOT be landed separately.
- scripts/file-retro-pain-point.sh does not exist in this repo, so retro pain
  points cannot be filed by the standard tool here (builder-index-client-080).

## Progress Update as of 2026-08-31, evening Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Fixed builder-index-client-trk. The agentsview resolver probed two ABSOLUTE
system install paths that no amount of HOME/PATH isolation could mask, so any
machine with agentsview installed failed the tests asserting its absence. Made
the system candidate list injectable and pointed the tests at it. Local suite
went 240 pass / 32 fail -> 243 pass / 29 fail; all 29 remaining failures are
better-sqlite3 (builder-index-client-cvq), a single root cause.

### Detail of changes made:
- `reporter/agentsview.ts`: extracted the two quickstart install locations into
  `SYSTEM_CANDIDATES` and added an optional `systemCandidates` field to
  `ResolveDeps`, defaulted via `?? SYSTEM_CANDIDATES`. Production calls omit it,
  so behavior is byte-identical; tests pass `[]` to opt out. Exported
  `isExecutableFile` so tests keep REAL filesystem semantics rather than
  substituting a fake and testing less than production does.
- `test/agentsview.test.ts`: added `resolveIsolated()` and repointed all 7 call
  sites in the `resolveAgentsview` block at it.
- Verified: typecheck clean; the 4 previously-failing `resolveAgentsview` cases
  now pass ON A MACHINE THAT HAS agentsview installed (v0.33.1 at
  /usr/local/bin), which is the exact condition that broke them.

### Beads activity:
- Claimed and closed builder-index-client-trk.
- Commented on builder-index-client-cvq with the exact compiler evidence.

### Potential concerns to address:
- The suite is still red locally, now from ONE cause: better-sqlite3 11.10.0
  will not compile against Node 26.4.0 (node-gyp 12.4.0, `make` exit 2), and
  there is no prebuild for this ABI. 28 of 29 failures are downstream of
  `writeFakeIndex` opening a sqlite DB. Until cvq is resolved, no agent on this
  repo can honestly run the local gate — which is a quality-process problem, not
  just an inconvenience.
- I did NOT bump the dependency: changing package.json/package-lock.json on a
  public repo is a human call, and CI is green on whatever Node it pins.

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
