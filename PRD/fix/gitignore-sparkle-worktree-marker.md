## Progress Update as of 2026-09-01 09:40 PDT
*(Most recent updates at top)*

### Summary of changes since last update
Collapsed the test's rationale block from 20 lines to 10 (roborev 73878). Comment only; the
assertion and its behaviour are untouched.

### Detail of changes made:
- Roborev's point was not that the text was wrong — job 73877 reviewed the same commit and found
  no issues, and 73878 agreed the corrected claim is accurate. It was that the block had been
  rewritten twice in three commits and was 20 lines guarding a 4-line assertion whose failure
  message already says the same thing. Churn, not convergence.
- Kept the two load-bearing sentences: the assertion must prove the rule is COMMITTED (a machine
  with a local `.sparkle/` exclude passes a plain `check-ignore` on a checkout missing the fix,
  stranding the next agent behind a green suite), and therefore a `.gitignore:` prefix, since
  every override prints a different anchor. Dropped the output-format restatement, the exit-1
  aside and the tilde-expansion example — all inferable from the four lines beneath them, and all
  of them what kept attracting edits.
- This is the consolidation the reviewer asked for, done once. The comment is now closed to
  further wording passes on this branch.
- Verified: `npm run typecheck` clean; `node --test dist/test/gitignore.test.js` 3/3.

### Beads activity:
- No bead state change; branch work refs builder-index-client-wfe.

### Potential concerns to address:
- Three review-driven edits to one comment is a signal in itself: a rationale block long enough
  to restate what the code below it already says will keep drawing findings. Prefer the short
  form on the first pass.

## Progress Update as of 2026-09-01 09:05 PDT
*(Most recent updates at top)*

### Summary of changes since last update
Corrected the new test comment's account of how `git check-ignore -v` reports its source
(roborev 73868). Comment only — no behaviour change.

### Detail of changes made:
- The comment claimed git reports "every other source" as an absolute path. False for the most
  likely override, and the one the docstring itself names: a rule in `.git/info/exclude` prints
  the RELATIVE `.git/info/exclude:1:`. My own scratch-clone probe had already printed exactly
  that (`.git/info/exclude:7:.sparkle/`) and I wrote the comment past it.
- What actually holds: git reports the source relative to cwd when it lives inside the worktree
  (`.gitignore`, `.git/info/exclude`) and absolute only for `core.excludesFile`. So the thing
  separating the committed file from either override is where the match is ANCHORED — which is
  why the prefix shape is right. The assertion was already correct; only its stated reason was
  not.
- Worth noting this is the SECOND instance on this branch of the same defect class, and the
  first one's fix is what surfaced it: a rationale comment asserting an observation the
  behaviour contradicts. The fix carries more weight than the wording, because the reason is
  what the next agent edits against.
- Verified: `npm run typecheck` clean; `node --test dist/test/gitignore.test.js` 3/3.

### Beads activity:
- No bead state change; branch work refs builder-index-client-wfe.
- `bd remember` key `verify-negative-cases-in-a-scratch-clone-not-the-working-tree` records the
  probe-commit lesson and the assert-the-source rule for future agents on this repo.

### Potential concerns to address:
- PR #84 is CLEAN / APPROVED with all checks green but cannot be merged by an agent:
  `plow-pbc/tkmx-client` is pinned merge-protected, so landing waits on a human.

## Progress Update as of 2026-08-31 18:45 PDT
*(Most recent updates at top)*

### Summary of changes since last update
Closed a real hole roborev found in the source assertion, and corrected a comment that claimed a
causal chain this checkout contradicts.

### Detail of changes made:
- `test/gitignore.test.ts`: the assertion was `assert.match(output, /(?:^|[\\/])\.gitignore:/)`,
  which accepts an ABSOLUTE path ending `/.gitignore` — precisely what `core.excludesFile` set to
  `~/.gitignore` produces. That is a per-machine override, the one thing the test exists to
  reject, so the test was looser than its own docstring. Git reports the in-tree top-level file
  as the literal relative path `.gitignore`, and every other source as an absolute path, so the
  assertion is now a `.gitignore:` PREFIX (`output.startsWith`).
- `.gitignore`: the comment asserted the marker "left every agent worktree permanently dirty".
  Not true on this checkout — both `.git/worktrees/<id>/info/exclude:5` and the common
  `.git/info/exclude:17` already carry `.sparkle/`. Reworded to what is actually load-bearing:
  the in-tree rule is what makes the exclusion PORTABLE to a machine without those local
  excludes. CI is that machine, and it is why the missing rule failed there and not here.
- Verified in a throwaway clone under the scratchpad, never in the working tree — the working
  tree is how the probe got committed last time. Four cases, `check-ignore -v` source shown:
  - committed rule present -> `.gitignore:15:` -> passes.
  - rule removed, `.git/info/exclude` override -> `.git/info/exclude:7:` -> fails. Correct.
  - rule removed, `core.excludesFile` pointing at a file literally named `.gitignore` ->
    `/…/fakehome/.gitignore:1:` -> OLD regex matched (would have wrongly PASSED, the hole);
    new prefix check rejects it. Correct.
- `npm run typecheck` clean; `node --test dist/test/gitignore.test.js` 3/3.

### Beads activity:
- No bead state change; branch work refs builder-index-client-wfe.

### Potential concerns to address:
- Roborev's third finding is a general hazard worth remembering: a rationale comment that records
  an OBSERVED causal chain will be trusted by the next agent debugging that symptom. Here the
  observation was wrong (local excludes already covered the path) while the fix was still right,
  so the comment would have sent someone chasing the wrong cause.

## Progress Update as of 2026-08-31 18:20 PDT
*(Most recent updates at top)*

### Summary of changes since last update
Restored the `.sparkle/` rule in `.gitignore`. The previous commit (`2531aaa`, the test
refactor) accidentally committed the *verification probe* along with the refactor: to prove the
new assertion could fail, `.gitignore` was reverted locally — and that revert was staged into
the commit and pushed. CI then failed on exactly the test the commit was meant to strengthen
(`not ok 48 - Sparkle's per-worktree marker is ignored by the committed .gitignore`, `# fail 1`).

### Detail of changes made:
- `.gitignore`: re-added the `.sparkle/` rule and its comment. This is the only change; the
  test in `test/gitignore.test.ts` is untouched and its refactor stands.
- The accidental revert is itself the strongest evidence the test works as designed: it is the
  precise scenario the assertion exists to catch (committed fix missing), and CI caught it on
  the first push rather than letting the branch merge green.
- Verified: `node --test dist/test/gitignore.test.js` → 3/3 pass; `npm run typecheck` clean.
- Note for the next agent: the FULL local suite fails ~30 unrelated cases on a developer machine
  (real `agentsview` binary on PATH, real agent config dirs), while CI runs them green. Judge
  this branch by CI, not by a local `npm test`.

### Beads activity:
- No bead state change; branch work refs builder-index-client-wfe.

### Potential concerns to address:
- Committing a deliberate "make the test fail" probe is an easy foot-gun: the probe and the real
  change touch the same file, so `git commit -a` sweeps it in. Filed as a Sparkle pain point.

## Progress Update as of 2026-08-31 15:30 PDT
*(Most recent updates at top)*

### Summary of changes since last update
Ignored `.sparkle/` and guarded it with a test that insists the rule comes from the committed
`.gitignore` rather than from anyone's local `.git/info/exclude`
(builder-index-client-wfe).

### Detail of changes made:
- `.gitignore`: added `.sparkle/`. The desktop app writes `.sparkle/merge-policy.json` into
  every agent worktree it cuts; nothing here reads it, but while it was unignored it left every
  agent worktree permanently dirty, which is enough for worktree teardown to refuse ("holds
  uncommitted changes") and strand the worktree. Ignored the directory rather than the one file
  — the marker set is the app's to change, not this repo's.
- `test/gitignore.test.ts`: new case asserting the ignore rule's SOURCE, via
  `git check-ignore -v --no-index`, is the committed `.gitignore`. Asserting only "is it
  ignored" would have been vacuous here: an agent that hits this problem is likely to have
  patched its own `.git/info/exclude` as a workaround, and that workaround makes a plain
  `check-ignore` pass on a checkout where the committed fix was never made — the one outcome
  that leaves the next agent stranded with a green suite. Verified: with `.gitignore` reverted
  and the local override still in place, the test fails and names the override in its message.
- Source parsing peels the two fixed trailing fields (`:<line>:<pattern>`) off the front half
  rather than splitting on the first colon, since the source can be an absolute path and on
  Windows that starts `C:\`.

### Beads activity:
- Opened and claimed: builder-index-client-wfe

### Potential concerns to address:
- 5 pre-existing failures on `main` under Node 22 (`resolveAgentsview`, `collectSessionStats
  returns null when binary missing`) are host-dependent — a real agentsview binary installed on
  the dev machine leaks in (builder-index-client-trk, fixed by PR 70). Unchanged by this branch:
  276→277 tests, 271→272 pass, 5→5 fail.
