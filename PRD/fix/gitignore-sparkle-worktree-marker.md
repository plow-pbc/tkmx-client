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
