## Progress Update as of 2026-08-18 12:40 PT
*(Most recent updates at top)*

### Summary of changes since last update
Addressed all three roborev findings on 80a159b. One was a real first-run bug:
a freshly installed reporter indicted itself.

### Detail of changes made:
- `reporter/doctor.ts`: a null/unparseable `last_success_at` is now `warn`, not
  `fail`. launchd's `RunAtLoad` fires a cycle the instant the unit is installed,
  before any success can have been stamped — the old behaviour printed
  "BROKEN" into the log of a reporter that was working, and put
  `healthy: false` on the very POST that proved it worked, which would have
  handed the server-side gone-quiet list a false positive for every new
  builder. A genuinely dead reporter is still caught by the unit checks and by
  the staleness branch once it has ever worked. Verified: a fresh install with
  a good unit and no success now reports `healthy: true` with one warn.
- `test/report-e2e.test.ts`: asserts `reporter_health` actually reaches the POST
  body (`healthy:false`, `failing_checks` containing `service-installed`).
  Nothing covered the new wire field, so a never-firing `if (health)` guard or
  a renamed key would have gone green.
- `test/reporting-state.test.ts`: converted from per-test
  `require("../reporter/reporting-state")` to typed top-level imports plus a
  `tmpStateFile()` helper. The `require()` results were `any`, which is exactly
  why the restored `computeTransitionMarkers` literals could omit
  `last_success_at` unnoticed; they are now typed `ReportingState`.

### Beads activity:
- No status changes. builder-index-client-85j stays open pending
  builder-index-client-4k7 (server half).

### Potential concerns to address:
- Suite is 297 tests, 292 passing; the same 5 pre-existing failures
  (builder-index-client-trk) remain and are unrelated to this work.

## Progress Update as of 2026-08-18 12:20 PT
*(Most recent updates at top)*

### Summary of changes since last update
First entry. Landed the client half of builder-index-client-85j (P0, silent
churn): this machine now records when the server last accepted a report, and a
new `npm run doctor` diagnoses the three ways a reporter dies quietly — no unit
installed, the unit pointing at a node binary that no longer exists, and a unit
that exists but is not scheduled. The same check runs inside every report cycle,
because the failure mode is that nobody looks.

### Detail of changes made:
- The branch started as an ORPHAN — `git merge-base HEAD origin/main` was empty
  and the tree held only `AGENTS.md`/`CLAUDE.md`. It was re-cut with
  `git checkout -B <branch> origin/main`, discarding a `bd init` scaffolding
  commit that shared no history with main. Any future agent seeing an empty
  merge-base should re-cut rather than attempt a rebase.
- `reporter/reporting-state.ts`: `ReportingState` gains `last_success_at`
  (`string | null`). `loadState` treats a non-string as null so a state file
  written before this field, or hand-edited, reads as "never succeeded" rather
  than manufacturing freshness. New `recordSuccess(filePath, nowIso)` reloads
  and rewrites only that field.
- `reporter/report.ts`: `currentState` carries `last_success_at` forward from
  `priorState` — rebuilding it from env alone would erase the stamp every run.
  `recordSuccess` is called after a successful POST and OUTSIDE the
  `!profile_frozen` gate: a frozen profile still proves the collector ran and
  reached the server, which is what staleness is about. The body now carries a
  `reporter_health` block for the server half to read.
- `reporter/doctor.ts` (new): pure `diagnose()` over an injected `DiagnoseInput`
  plus thin impure probes (`collectInput`, `probeScheduled`, plist/systemd
  parsers). Threshold is 48h — a laptop shut for a long weekend must not be
  called broken. A future-dated stamp warns instead of passing as fresh.
- `reporter/install.ts`: exported `launchdPlistPath`/`systemdServicePath`/
  `systemdTimerPath`, replacing the same paths built inline in install and
  uninstall. Doctor must read the file install wrote, not one it recomputed.
- `test/report-e2e.test.ts`: the frozen-profile test asserted "the state file
  does not exist" as a proxy for "the transition edge was not consumed". That
  proxy died the moment the file also held `last_success_at`, so it now asserts
  the invariant directly — the persisted toggles stay put AND the stamp lands —
  and was mutation-checked to confirm it still fails if `saveState` moves
  outside the freeze gate.

### Beads activity:
- Claimed and implemented (client half): builder-index-client-85j
- Opened: builder-index-client-4k7 (server half; 85j now depends on it, so 85j
  stays open until the profile/operator/email signal exists)
- Opened: builder-index-client-trk (test isolation — a real agentsview binary
  on the machine leaks into tests that assume none)
- Opened: builder-index-client-cvq (better-sqlite3 will not build on Node 26)
- Closed: builder-index-client-mxk (repo already has its origin remote)

### Potential concerns to address:
- The suite has 5 PRE-EXISTING failures on this machine, unrelated to this work
  (builder-index-client-trk). Baseline was 267/272 passing; after this change it
  is 282/287 with the same 5 failing. Anyone verifying should compare against
  the baseline, not expect green.
- Tests must be run under Node 22 (`nvm use 22`) until
  builder-index-client-cvq is fixed; Node 26 cannot build better-sqlite3.
- `reporter_health` is sent but nothing consumes it. Until 4k7 lands, the
  builder-facing half of 85j's acceptance criteria is unmet — detection exists,
  notification does not.
- The systemd probe path is untested on a real Linux box, matching the existing
  caveat already noted in `reporter/uninstall.ts`.
