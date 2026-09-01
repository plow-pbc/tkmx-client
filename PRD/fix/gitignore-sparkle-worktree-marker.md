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
