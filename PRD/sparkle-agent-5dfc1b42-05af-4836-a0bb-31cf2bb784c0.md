# Progress — branch `sparkle/agent-5dfc1b42-05af-4836-a0bb-31cf2bb784c0`

## Progress Update as of 2026-09-08 (Pacific)
*(Most recent updates at top)*

### Summary of changes since last update

Branch reduced to one commit: the flaky failed-sync assertion. Everything else it
carried duplicated PR #70, which has been green for 22 days and does the same work
better. The superseded set is preserved on `archive/agent-5dfc1b42-full-set` and in
PR #70 itself; nothing is lost by this reduction.

### Detail of changes made:

- **What remains.** `throws on strict sync errors without querying usage` read the
  fake binary's call log expecting exactly `["sync"]`. In the timeout branch the
  parent kills the fake after 1s, and on a loaded machine that kill lands before
  `/bin/sh` reaches its first write — the log never exists and the case fails with
  `ENOENT`. Measured pass/fail/fail across three runs of an identical build. The
  fake now logs *after* its sync branch, so the log records only a usage call, which
  is the whole claim; the thrown error already proves the sync ran. PR #70 does not
  touch this case, so it is the one thing here that is not a duplicate.
- **What was removed and why.** The branch previously carried a host-independence
  fix for the agentsview resolver (via a new `AGENTSVIEW_SYSTEM_CANDIDATES` env var)
  and a Node-pin plus an error translator for better-sqlite3's ABI mismatch. PR #70
  already does both: the resolver fix by injecting deps into `resolveAgentsviewWith`
  with no new env var — the exact single-knob shape this PR's reviewer asked for —
  and the addon problem by bumping better-sqlite3 11 → 13 onto Node-API prebuilds,
  which actually fixes the 27 failing tests rather than explaining them. #70 is
  −126 LOC net; this branch's version was additive. Both were written from a `main`
  that contained neither.
- **A badge-drift check** was also added here and reverted after review found it
  duplicated PR #89. That feature belongs to #89, which has the findings.

### Beads activity:
- Fixed here, awaiting merge: `builder-index-client-0ux`
- Superseded by PR #70, not by this branch: `builder-index-client-trk` /
  `builder-index-client-4ed`, `builder-index-client-cvq` /
  `builder-index-client-wb0`, `builder-index-client-1xp`
- Opened earlier from this branch: `builder-index-client-fy6` (orphan-root
  branches), `builder-index-client-0ux` (this flake)
- Evidence added: `builder-index-client-uyu` (the merge gate, quantified)

### Potential concerns to address:
- The queue is generating duplicates faster than it drains: 24 of 25 open PRs are
  green and mergeable, median age 8 days, and ten of them are the same
  "initialize beads issue tracking" task. Four distinct duplications are traceable
  to agents branching from a 24-PR-stale `main`. Detail on
  `builder-index-client-uyu`.
- Recommended merge order remains: #70 first (it carries the dependency bump the
  whole suite wants), then this one, which no longer overlaps anything.
