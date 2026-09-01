# sparkle/agent-eeef2a1c-10ad-4ad1-a074-622ad644c026

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
