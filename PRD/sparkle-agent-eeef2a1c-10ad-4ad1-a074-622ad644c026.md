## Progress Update as of 2026-09-02 14:35 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Corrected a factual error in a comment this branch wrote. The `.gitignore` block
above the `.sparkle/*` rule called merge-policy.json "hand-written repo policy, not
app runtime state." Roborev doubted that and the doubt was right -- the desktop app
regenerates the file per worktree. The rule is still correct; only its stated reason
was wrong.

### Detail of changes made:
- Rewrote the comment to say what is actually true: the app writes the file, it is
  tracked anyway so a plain clone with no desktop app can see the repo is
  merge-protected, and a change to the app's serialization would show every worktree
  as modified at once (builder-index-client-kgb).
- Re-verified the ignore mechanics in a throwaway repo, since this machine's
  `.git/info/exclude` blanket-excludes `.sparkle/` and shadows the committed rules the
  same way it shadows `.beads/`: merge-policy.json not ignored, other `.sparkle/`
  content ignored. Correct in both directions.
- Established that `main` has NO `.sparkle` ignore rule and tracks nothing under
  `.sparkle/`, so every agent worktree cut from `main` carries a permanently untracked
  marker. That is a problem this PR fixes and PR #69 does not, which strengthens the
  carry-over case if #69 is the one that lands.
- Refreshed the carry-over patch offered on #69: it predated b2470c3/c07f845 and would
  have landed the superseded `/tmp` version of the installer snippet.

### Beads activity:
- No new beads. builder-index-client-kgb now referenced from the corrected comment.

### Potential concerns to address:
- None new.

## Progress Update as of 2026-09-02 14:15 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Roborev reviewed b2470c3 and found a hazard that commit had itself introduced:
`installer=$(mktemp) || exit 1` is meant to be pasted into an interactive shell,
where `exit 1` closes the operator's terminal rather than aborting an install.
Dropped the guard and trimmed the comment it flagged as bloat.

### Detail of changes made:
- Removed `|| exit 1`. Verified the guard was unnecessary as well as harmful: with an
  empty `$installer`, `curl -o "" URL` fails, so the `&&` chain already stops before
  `bash` ever runs. Confirmed by executing that exact case.
- Cut the threat-model comment from 8 lines to 4. Roborev's point was that the snippet
  had been rewritten in three consecutive commits and each round added prose, until the
  comment was longer than the instruction it guarded. It now states the two reasons
  (branch-tracking URL, swappable fixed path) in one sentence.
- Re-verified: `sh -n` on the extracted snippet passes; typecheck clean; suite 271/276
  with the same 5 pre-existing agentsview failures.
- This is the last iteration on this snippet. Roborev flagged the churn itself, and
  this round removes lines and a hazard rather than adding more.

### Beads activity:
- Opened builder-index-client-kgb (tracked .sparkle/merge-policy.json is app-regenerated,
  so a serialization change would dirty every worktree at once).

### Potential concerns to address:
- None new. The merge-policy coupling (kgb) stays latent and deliberately unfixed on
  this branch.

## Progress Update as of 2026-09-02 13:45 Pacific
*(Most recent updates at top)*

### Summary of changes since last update
Roborev's quota reset, so the two commits on this branch that had gone unreviewed
for two days (5ae44f6, 75e754f) finally got a review. Three Low findings came back;
this commit applies the one that was unambiguously right, and closes the other two
with evidence.

### Detail of changes made:
- Applied roborev 78208 finding 1: the installer sequence in `.beads/README.md` was
  downloading to a fixed `/tmp/beads-install.sh`. A predictable path can already
  exist as a symlink for curl to follow, and the file can be swapped in the gap
  between `less` and `bash` — which reinstates the "execute unreviewed bytes"
  problem the sequence exists to prevent. Now uses `installer=$(mktemp)`, chains
  fetch/review/run with `&&`, and cleans up.
- Chose plain `$(mktemp)` over `mktemp -t beads-install`: GNU mktemp rejects a `-t`
  template with no `X` placeholders, so the `-t` form works on macOS and fails on
  Linux. Verified the final snippet with `sh -n`.
- REJECTED roborev 78208 finding 2 (drop `post-commit.bak-*` from `.beads/.gitignore`
  as dead). The claim was that the preceding `hooks/` rule already covers it. It does
  not cover a bak file at `.beads/` ROOT — only inside `hooks/`. Verified by copying
  both .gitignore files into a throwaway `git init` repo and probing, which was
  necessary because this machine's `.git/info/exclude` blanket-excludes `.beads/` and
  shadows the repo rules (bead builder-index-client-bsx). Keeping the rule.
- DEFERRED roborev 78209 finding 1 (`.sparkle/merge-policy.json` may churn because the
  desktop app regenerates it). Confirmed the premise is TRUE: 19 sibling worktrees all
  carry the file with varying mtimes — several rewritten today — so the app does write
  it. It is byte-identical everywhere right now, so nothing is dirty, but any change to
  the app's serialization would dirty every worktree at once. Not changing it on this
  branch: the tracked marker was a deliberate prior decision (a9f54e4) that this branch
  did not author, and renaming it while a human is choosing between PR #69 and #93 would
  be a unilateral semantic change to a Low-severity latent risk. Filed instead.

### Beads activity:
- Commented on builder-index-client-gy3 (leak scan + the verified CI guard),
  builder-index-client-e5s (the nine-PR duplicate pile), builder-index-client-1xp
  (corrected its "32 failing tests" figure to 5).
- Opened a bead for the merge-policy.json churn risk (id noted in the PR comment).

### Potential concerns to address:
- The `.sparkle/merge-policy.json` coupling above is latent, not active. It only bites
  when Sparkle changes how it serializes that file.
- The suite still ships 5 failing agentsview tests on the default branch
  (builder-index-client-4ed); this commit does not change that count.

# sparkle/agent-eeef2a1c-10ad-4ad1-a074-622ad644c026

## Progress Update as of 2026-08-31 20:52 PDT
*(Most recent updates at top)*

### Summary of changes since last update
Restored `.sparkle/merge-policy.json`, which this branch had deleted from itself:
commit `a9f54e4` deliberately added the merge-protection marker, and the very next
commit `68589e0` added a bare `.sparkle/` ignore that swallowed it. The marker is
the record that tells agents not to retry merges here, so losing it re-opens the
exact loop it was written to end.

### Detail of changes made:
- Re-added the marker with its original content and changed the ignore from
  `.sparkle/` to `.sparkle/*` plus `!.sparkle/merge-policy.json`. Git never
  descends into an excluded DIRECTORY, so a negation under a bare `.sparkle/`
  is unreachable -- ignoring the contents is what makes the re-admit work.
- Verified with a scratch `.sparkle/probe.json`: probe ignored, marker not.
- Note for anyone reproducing this: on this machine the repo's local
  `.git/info/exclude` also carries a bare `.sparkle/`, which still shadows the
  directory. The marker is safe regardless because it is now TRACKED, and no
  ignore rule at any level applies to a tracked file. `info/exclude` is
  machine-local and is not part of the PR.

### Beads activity:
- None.

### Potential concerns to address:
- The stale `.sparkle/` line in the local `.git/info/exclude` will keep hiding
  future files in that directory for this checkout only. Harmless for the marker,
  but worth knowing before adding a second tracked file there.


## Progress Update as of 2026-08-31 20:35 PDT
*(Most recent updates at top)*

### Summary of changes since last update
Rebased this branch onto `origin/main` (it was 198 commits stale) and removed the
non-portable, machine-specific artifacts that a default `bd init` had staged into
this **public** repo: the generated `.beads/hooks/*` wrappers (four of which bake
in the generating developer's absolute home path), the leftover
`post-commit.bak-<timestamp>` file, and the per-machine `.beads/interactions.jsonl`
runtime log. Also replaced the `curl | bash` installer line in `.beads/README.md`
with a fetch-review-run sequence.

### Detail of changes made:
- Rebase resolved one `add/add` conflict in the root `.gitignore` by unioning both
  sides: the repo's existing rules (`node_modules/`, the `.env*` credential class
  with `!.env.example`, `dist/`, `*.tsbuildinfo`, …) plus the beads/Dolt block
  (`.dolt/`, `*.db`, `.beads-credential-key`, `.beads/proxieddb/`). Nothing was
  dropped from either side.
- `git rm -r --cached .beads/hooks .beads/interactions.jsonl` — untracked, not
  deleted, so local hook wrappers keep working. `.beads/metadata.json` and
  `.beads/config.yaml` stay TRACKED on purpose: `project_id` / `dolt_database` are
  shared identity needed for `refs/dolt/data` sync.
- Added matching ignores to `.beads/.gitignore` (`hooks/`, `post-commit.bak-*`,
  `interactions.jsonl`), inserted above that file's "do NOT add negation patterns"
  note so the fork-protection warning still reads correctly.
- `.beads/README.md`: the install snippet piped a branch-tracking
  `raw.githubusercontent.com/.../main/scripts/install.sh` straight into `bash`,
  executing whatever upstream `main` holds at that moment. It now downloads,
  invites review, then runs. No SHA was pinned — picking one would mean inventing
  a commit id that has not been verified against upstream.

### Beads activity:
- None. No bead was claimed for this work; it is branch hygiene discovered while
  checking why the branch had not landed.

### Potential concerns to address:
- The upstream installer URL still tracks `main`. Pinning it to a reviewed SHA is
  the real fix; that needs a human to choose and verify the commit.
- No verification was run for this change: the worktree has no `node_modules`, and
  the diff touches only `.gitignore`, `.beads/.gitignore`, and `.beads/README.md` —
  zero TypeScript. `npm run typecheck` / `npm test` were NOT executed.
- Per the recorded merge-protection policy, agents do not merge PRs in this repo.
  The PR from this branch needs a human to land it.
- The suite has a known red baseline on `main` (~32 local failures); measure before
  attributing any failure to this branch.
