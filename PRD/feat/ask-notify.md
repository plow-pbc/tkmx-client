# feat/ask-notify

## Progress Update as of 2026-08-28 03:20 Pacific
*(Most recent updates at top)*

### Summary of changes since last update

Removed a `node_modules` symlink that the first commit had tracked by accident. It was a mode
120000 blob pointing at an absolute path inside an ephemeral agent worktree, so it resolved on
exactly one machine and would have landed on `main` as a dangling link where the dependency tree
belongs. No feature code changed.

### Detail of changes made:
- `git rm --cached node_modules` drops the tracked symlink; the working tree keeps an untracked
  one, which is what it always should have been.
- `.gitignore` already had `node_modules/`, with the trailing slash. That pattern matches a
  DIRECTORY and does not match a symlink of the same name, which is precisely how this slipped
  past the ignore file and into a commit. Added a bare `node_modules` line beside it so both
  spellings are covered.
- Verified before pushing, against a trial merge of this branch onto `origin/main` (2f37bf6):
  `npm run typecheck` clean; suite 248 pass / 31 fail vs a pristine-`main` baseline of
  237 pass / 31 fail. The failing-test NAME SETS are byte-identical between the two, so this
  branch adds 11 passing tests and zero failures. The 31 are pre-existing environment breakage
  on `main` (better-sqlite3 will not build against local Node v26; agentsview is not installed).
- PR #74 is otherwise CLEAN and MERGEABLE with four green checks, including a real
  `typecheck + test` CI job — not only preview-deploy builds.

### Beads activity:
- None. No bead exists for this branch; the fix is a defect in the branch's own first commit.

### Potential concerns to address:
- The merge itself is not an agent's to make: `plow-pbc/tkmx-client` is pinned merge-protected,
  so `gh pr merge` is refused by policy and a human has to land #74.

## Progress Update as of 2026-08-22 06:15 Pacific
*(Most recent updates at top)*

### Summary of changes since last update

First entry. The client half of the Ask-a-Builder loop, deliberately the small half: every two
hours the reporter tells the builder how many questions are waiting and where to answer them.
Answering stays on the web. Branched from `origin/main`, NOT from the branch carrying PR #71,
so it lands independently.

### Detail of changes made:

- New `reporter/questions.ts`. `pendingLine()` is pure and returns null when there is nothing
  to say; `fetchPendingCount()` returns `number | null`, where null means "could not find out".
  Keeping null distinct from 0 is the point — they look identical on screen, and collapsing
  them in the type is how a confident "0 questions" gets printed from a failed request.
- `reporter/report.ts` prints the line just after the profile URL. Every failure is swallowed:
  a usage report must not go red because a courtesy line could not load.
- No new endpoint was needed. `GET /api/user/:username/questions` already returns `pending`
  (server `ask_routes.ts`), unauthenticated, public answers only.
- `test/questions.test.ts` — 11 tests. Singular/plural, trailing-slash normalisation on
  SERVER_URL, username encoding, and five separate ways a lookup can fail, each asserting null
  rather than zero.

### Beads activity:
- None; no bead tracker on this branch.

### Potential concerns to address:
- **The full suite cannot run natively on this machine.** `better-sqlite3@11.10.0` does not
  build against the local Node v26 (NODE_MODULE_VERSION 147 vs 127), and `agentsview` is not on
  PATH. 31 tests in `agentsview`, `report-e2e` and `session-stats` fail for that reason. Verified
  as pre-existing: a pristine `origin/main` worktree fails the identical 8 / 22 / 1. The 11 new
  tests and the rest of the suite pass.
- The line's link is built from `SERVER_URL`, which serves `/ask/:username`, not from the
  aiworthusing profile host. If those hosts ever diverge for the ask page, this needs revisiting.
