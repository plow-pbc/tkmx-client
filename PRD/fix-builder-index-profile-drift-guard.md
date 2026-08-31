# fix/builder-index-profile-drift-guard

## Progress Update as of 2026-08-20 18:45 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Third review round, both findings Low and both taken. The attribution sentence now renders
a missing `client_id` with the same `(no client_id)` fallback the machine list above it
uses, instead of printing `from undefined` and contradicting its own output one line later.
The four type casts on the fixture are gone — typing `CANONICAL` as `Canonical` made them
redundant, and a cast the declaration already covers is what hides a real shape mismatch
later.

### Detail of changes made:
- `whoWroteThis` was the one remaining unguarded render of `client_id`; every other site
  already had the fallback. Pinned by a test that fails without it.
- Dropped `as Record<string, string>` on `strict` / `strict_case_insensitive`,
  `as string[]` on `non_empty.fields`, and `as string[] | undefined` on `known_bad?.[key]`.
  Net-negative LOC; the loops read straight off the typed fixture.

### Verification
- `npm run typecheck` — clean.
- `npm test` — 287 tests, 252 pass, 31 fail; the same 31 pre-existing, unrelated failures
  in `report-e2e` / `agentsview` / `session-stats` documented in the entry below.
- Reverting the fallback turns the new test red; restored, 14/14 pass in the offline file.

## Progress Update as of 2026-08-20 18:20 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Answered the second review round on the drift guard. The guard's judgement calls —
status classification, the freeze tripwire, and the attribution report — moved into
`test/helpers/profile-drift.ts` and are now covered offline by
`test/profile-drift-report.test.ts`. Three defects the review named are fixed: a 401/403
no longer reddens unrelated PRs, the freeze tripwire measures against the live
`machines[].client_version` instead of this repo's `package.json`, and the report no
longer contradicts itself or collapse its own blank lines.

### Detail of changes made:
- **Why the helpers exist at all.** Every branch the review found broken fires only on a
  condition the live profile does not produce (a WAF block, a deleted profile, an empty
  machines array, a risen minimum). Against the real API they are dead code, which is how
  two rendering bugs and a mis-aimed version comparison survived a full round of review.
  Splitting them out is what made them testable without a network call.
- **CI posture, restated.** The line is now drawn at what a GitHub-hosted runner's
  datacenter IP can tell apart. 5xx/429/401/403 skip — a Cloudflare challenge and a
  profile gone private wear the same status from outside, and only one of them is drift.
  404/410 fail hard: the profile is GONE, no access-control story explains it, and that is
  the case the guard exists for. The previous revision failed on 401/403 and would have
  reddened every unrelated PR in the repo the first time the host's edge disliked CI.
- **The freeze tripwire no longer pins a version in this repo.** It compares the server
  minimum against each live `machines[].client_version`. The declared prose owner is
  Sparkle's native reporter, pinned in another repo (`protocol.also_pinned_in`) and
  unreadable from here — so the old `package.json` comparison covered every machine except
  the one whose freeze actually stalls the prose. The failure now names the frozen box and
  flags it when it is the owner.
- **Attribution report.** `null` is now the omit-this-line sentinel; `""` was doing double
  duty as both that and the blank separator, so every deliberate spacer was filtered out
  and the report rendered as one block. Nobody-reporting is its own branch instead of
  falling through to "the newest report is from the declared owner".
- **Proof, not assertion.** Reverting the helpers to the pre-fix semantics turns exactly
  five of the new tests red, one per defect; restored, all 14 pass.

### Verification
- `npm run typecheck` — clean.
- `npm test` — 286 tests, 251 pass, 31 fail. Those 31 are pre-existing and confined to
  `report-e2e`, `agentsview`, and `session-stats`; the identical 31 fail on this branch
  with the change reverted, they depend on local machine state, and CI is green on the PR.
  Nothing in this change is imported by any of them.
- `node --test dist/test/profile-drift.test.js dist/test/profile-drift-report.test.js` —
  14/14 pass against the live profile.

### Potential concerns to address:
- An outage, or an edge that blocks CI, still hides drift for that run. This is a ratchet
  against a value changing silently, not an uptime monitor, and the header says so — but
  a profile that is 403 to CI indefinitely would be a guard that never runs and never
  says so.
- Attribution remains "newest REPORTER", not "writer". The server records the exact
  answer as a `profile_update` event (field/old_value/new_value) and exposes no route to
  read it. Exposing that feed is still the single highest-value server change for this
  class of bug.
