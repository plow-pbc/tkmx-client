## Progress Update as of 2026-08-17 16:15 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Cleared the standing deprecation warning the previous entry flagged:
`actions/checkout` and `actions/setup-node` move v4 -> v7. Verified by counting
the warning in the run log — every prior run on this branch emitted it, the run
after this commit emits zero.

### Detail of changes made:
- Both actions targeted the Node 20 action runtime, which the runner already
  forces onto Node 24 while warning on every job. That forcing is temporary; it
  becomes a hard failure once the runner drops the shim.
- Read both v7 release notes before bumping rather than assuming a major is
  drop-in: checkout v7 is security hardening plus dependency updates,
  setup-node v7 adds `cache-primary-key`/`cache-matched-key` outputs and moves
  to ESM internally. Nothing this workflow uses changes.
- Verification is the warning count, not just a green tick: `gh run view --log`
  greps 0 occurrences of "Node.js 20 is deprecated" after the bump. A green run
  proved nothing here, since the warning never failed the build in the first
  place.

### Beads activity:
- None; no bead store changes on this branch.

### Potential concerns to address:
- setup-node v7's notes reference updated guidance on cache-poisoning risks in
  the npm cache. This workflow uses `cache: npm` on a shared `~/.npm` key across
  both matrix legs. Roborev judged that safe here (the cache holds tarballs, and
  better-sqlite3 ^13 ships Node-API prebuilds rather than per-major binaries),
  but the upstream guidance is worth reading before any future cache change.
- PR #70 remains open with all five checks green and mergeable; the merge is
  still blocked at the permission layer.

## Progress Update as of 2026-08-17 15:30 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Closed the loop on the root cause rather than just the two symptoms: CI now runs
a `current` Node leg alongside the '22' pin. Both legs green, with `current`
resolving to 26.7.0 on the runner — the exact major that was silently broken.

### Detail of changes made:
- `.github/workflows/ci.yml` gains `strategy.matrix.node: ['22', 'current']`.
  Testing only the LTS is what let better-sqlite3 ^11 stay green here while
  failing to build on Node 26 locally (26 of 272 tests dead at module load,
  invisible to the workflow). The agentsview resolver tests were the same blind
  spot mirrored: green only on hosts unlike a developer's.
- `fail-fast: false`, so one major's failure does not cancel the other —
  distinguishing a version-specific break from a universal one is the point.
- Checked before renaming the job: `main` has no branch protection (the
  protection API 404s), so no required-check context named "typecheck + test"
  exists to be orphaned by the matrix suffix.
- Verified from the run log that the `current` leg downloaded v26.7.0, so the
  leg genuinely exercises a newer major rather than re-running the pin.
- All six roborev jobs on the branch are now `done` with zero open findings;
  the three later ones each returned "No issues found".

### Beads activity:
- None; no bead store changes on this branch.

### Potential concerns to address:
- `current` is a moving target by design: a future Node major can redden CI
  without any change in this repo. That is the intended tradeoff — it surfaces
  ecosystem breaks at the moment they appear rather than months later on a
  developer's machine — but it does mean a red `current` leg is not always a
  defect in the PR that happens to be open.
- The runner warns that actions/checkout@v4 and actions/setup-node@v4 target
  the deprecated Node 20 action runtime. Unrelated to this branch, but it is a
  standing warning on every run and will eventually become an error.
- PR #70 is open with all checks green and merges cleanly; the merge itself
  remains blocked at the permission layer.

## Progress Update as of 2026-08-17 14:10 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Drained roborev on the branch. Two of its findings were real and are fixed: the
sandbox I added had quietly copied production's executable predicate (costing
two tests their coverage of the real one), and the better-sqlite3 bump left two
CI comments describing packaging that no longer exists.

### Detail of changes made:
- `resolveSandboxed` inlined `statSync().isFile()` + `accessSync(X_OK)` — which
  is `isExecutableFile` verbatim. "skips non-executable candidates" and "skips
  candidates that are directories" then asserted against the test's own copy, so
  deleting either check in production would have left both green. Exported
  `isExecutableFile` and composed it with the fence instead. Confirmed by
  mutation: dropping the `isFile()` check now fails the directory case, and did
  not before.
- Dropped the bogus `AGENTSVIEW_BIN` assignment in the session-stats case; it
  was dead once the resolver itself was stubbed.
- `.github/workflows/ci.yml` justified the Node 22 pin by "what better-sqlite3
  ^11 ships prebuilds for" and claimed `--ignore-scripts` is impossible because
  the package needs its install script. Neither survives 13.0.3: no install
  script (`hasInstallScript` gone from the lockfile), Node-API prebuilds shipped
  in the tarball under `prebuilds/`. Both comments corrected.

### Beads activity:
- None; no bead store changes on this branch.

### Potential concerns to address:
- PR #70 is open with all checks green; the merge itself is pending human
  approval (the merge command was denied at the permission layer).
- Three roborev jobs on later commits were still queued at the time of writing
  and have not been read.

## Progress Update as of 2026-08-17 13:45 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
First entry for this branch. Cut from `main` after #66 landed. Two fixes, both
found by running the suite on a developer machine rather than in CI: five tests
that silently depended on the host NOT having agentsview installed, and a
`better-sqlite3` pin that cannot build on current Node.

### Detail of changes made:
- `resolveAgentsviewWith` probes `/opt/homebrew/bin/agentsview` and
  `/usr/local/bin/agentsview` as absolute candidates. No amount of HOME /
  USERPROFILE / PATH / AGENTSVIEW_BIN juggling hides those, so both test files'
  "isolated from the host's real install" comments were wrong about their own
  reach. Any case asserting a miss resolved the host binary instead.
- Miss cases in `test/agentsview.test.ts` now call `resolveAgentsviewWith` with
  the real executable check fenced to the sandbox tmpdir. Hit cases still call
  `resolveAgentsview()` unchanged — a candidate under HOME outranks the system
  paths, so those were always host-independent.
- `collectSessionStats returns null when binary missing` set a bogus
  `AGENTSVIEW_BIN` and assumed that was fatal. It isn't: an unusable override
  is ignored and the resolver falls through. The test now stubs
  `resolveAgentsview` on the shared CJS module instance (both files are cleared
  from `require.cache` in `beforeEach`, so the stub cannot leak).
- `better-sqlite3@11.10.0` has no prebuilt for Node 26 (ABI 147) and its source
  fails to compile against that V8. Bumped to `^13.0.3`, which publishes an
  ABI 147 prebuilt and declares `node >= 22` — covering the CI pin and current
  Node both. `@types/better-sqlite3` follows to `^9`.

### Beads activity:
- None; no bead store changes on this branch.

### Potential concerns to address:
- CI pins Node 22 while dev machines run 26, which is what let both problems sit
  unnoticed on a green `main`. A second CI matrix entry on current Node would
  have caught the native-module break at the commit that introduced the skew.
- `better-sqlite3` 11 -> 13 is a two-major jump. The suite (272/272) and
  typecheck pass, and the only usage is the fake-index helper plus the reader,
  but it is worth a look at the v12/v13 changelogs before this lands.
