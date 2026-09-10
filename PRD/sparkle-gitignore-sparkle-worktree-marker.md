## Progress Update as of 2026-09-10 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
First entry. Splits the one piece of branch sparkle/agent-eeef2a1c-... that is
DISJOINT from the nine-way beads-scaffolding duplicate pile, so it can land without
preempting the open human decision on which scaffolding PR wins (bead
builder-index-client-e5s).

### Detail of changes made:
- `main` has no `.sparkle` ignore rule and tracks nothing under `.sparkle/`. The desktop
  app writes `.sparkle/merge-policy.json` into every agent worktree, so all 19 worktrees
  on this machine currently show a permanently untracked file. None of the nine open
  scaffolding PRs fixes this; PR #69, the one recommended for the scaffolding decision,
  does not touch `.sparkle/` at all.
- Adds `.sparkle/*` plus `!.sparkle/merge-policy.json`. The `/*` spelling is load-bearing:
  git never descends into an excluded directory, so a bare `.sparkle/` makes the negation
  unreachable and silently untracks the marker. That is not hypothetical — it happened on
  the sibling branch, one commit after the marker was deliberately added.
- Tracks `.sparkle/merge-policy.json` so a plain clone with no desktop app can still see
  the repo's merge policy.
- Extends `test/gitignore.test.ts` with both halves of the rule.

### Testing notes valuable to a future agent:
- The obvious version of this test — `git check-ignore` inside this repo — is HOST
  DEPENDENT and must not be used. A developer's `.git/info/exclude` is machine-local,
  shared across worktrees via the common dir, overrides committed rules, and this repo's
  agent tooling writes a blanket `.sparkle/` line into it. The first draft passed in CI
  and failed on this machine for exactly that reason.
- The shipped test evaluates the COMMITTED `.gitignore` in a throwaway `git init` repo
  with no index and no info/exclude. Same question, host-independent answer.
- Mutation-checked: reverting `.sparkle/*` to `.sparkle/` makes the test fail with the
  intended message. Verified on Node 22.23.2 (the version CI resolves).
- Full suite: 277 tests, 272 pass, 5 fail — the 5 being the pre-existing agentsview
  host-leakage failures (builder-index-client-4ed) that already fail on `main` and are
  fixed by PR #70.

### Beads activity:
- References builder-index-client-e5s (scaffolding decision, deliberately not preempted)
  and builder-index-client-kgb (merge-policy.json is app-regenerated; latent churn risk).

### Potential concerns to address:
- kgb remains open: because the app regenerates the marker, a change to its serialization
  would show every worktree as modified at once. Harmless while the bytes are identical.
