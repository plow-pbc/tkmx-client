# Verifying that a PR actually merged

An agent asked to merge a PR and report the result can produce a confident,
checkable-looking, completely wrong answer. This page says which signal to
trust.

There are two ways to get this wrong, and they point in opposite directions.
One reports a merge that never happened; the other denies a merge that did.

## Never trust `merge_commit_sha`

On an **open** PR, the GitHub API still returns a populated `merge_commit_sha`.
That value is GitHub's speculative *test-merge* commit — the trial merge it
computes to decide whether the branch conflicts. It is not a commit on `main`,
and it usually does not exist after the PR closes.

It is dangerous precisely because it looks right: a plausible 40-character sha,
in a field whose name reads like an answer.

Observed on PR #72:

```json
{ "merge_commit_sha": "3f9a94c17ac137387024135ea9ab37916c9b177f",
  "merged": false,
  "merged_at": null }
```

An agent reading only the first field reports a merge sha for a PR that is
still open.

## The primary signal: the PR's own merged flag

`merged` / `merged_at` is the authoritative answer. `merged_at` is null until
the merge happens:

```bash
gh api repos/<owner>/<repo>/pulls/<N> -q '"\(.merged) \(.merged_at)"'
```

Prefer the REST call above. `gh pr view --json merged` does **not** work on any
`gh` version, and the reason is narrow: `merged` is missing from the field set
that *this command* accepts. `gh pr view --json` only takes fields present in
`gh`'s own `PullRequest` struct, which carries `mergedAt`, `mergedBy`,
`mergeCommit`, `mergeable`, and `mergeStateStatus` but no boolean `merged`
(verified on `gh` 2.98.0). The field is not REST-only — GitHub's GraphQL
`PullRequest` exposes `merged` too, so `gh api graphql` can read it:

```bash
gh api graphql -f query='query{repository(owner:"O",name:"R"){pullRequest(number:N){merged}}}'
```

It is a permanent gap in one command, not a version gap, so upgrading `gh`
will not fix it. Use the REST call above, or `mergedAt` via `gh pr view`:

```bash
gh pr view <N> --json number,state,mergedAt
```

## Ancestry: corroborating only, and only when it passes

It is tempting to treat "is the work on `main`?" as the real question and check
it directly:

```bash
git fetch origin
git merge-base --is-ancestor <head-sha> origin/main
```

**This check does not survive squash or rebase merges.** Both strategies
rewrite the commit, so the PR's original head sha never becomes an ancestor of
`main` even though the work is fully merged. Any repo with
`allow_squash_merge` or `allow_rebase_merge` enabled will produce false
negatives — and most repos enable them.

Measured in this repository, whose settings allow all three strategies
(`squash=true rebase=true merge=true`), against the three most recently merged
PRs:

| PR  | `merged` | head sha  | ancestor of `origin/main`? |
|-----|----------|-----------|----------------------------|
| #76 | `true`   | `33e7bd6` | **no**                     |
| #77 | `true`   | `5514627` | **no**                     |
| #78 | `true`   | `eba0002` | **no**                     |

All three are genuinely merged. The ancestor check calls all three unmerged.

So the check is only conclusive in one direction:

- ancestor ⇒ **merged** (the work is demonstrably on `main`)
- not an ancestor ⇒ **inconclusive** (says nothing, under squash or rebase)

To corroborate a squash or rebase merge, look at the merge commit GitHub
recorded rather than the head sha:

```bash
gh api repos/<owner>/<repo>/pulls/<N> -q .merge_commit_sha   # valid ONLY when merged is true
git merge-base --is-ancestor <that-sha> origin/main
```

Note the same field from the top of this page: it is trustworthy *after* the
merge and meaningless before it. Check `merged` first, then read it.

## Reporting rule

**Report a PR as merged when, and only when, `merged` is true.**

Ancestry is a corroborating check, not a tie-breaker. If the two disagree —
`merged: true` but the head sha is not an ancestor — the ordinary explanation
is a squash or rebase merge, and the PR is merged. Do not report it as
unmerged. Say what you saw if something still looks off, but do not let a
not-ancestor result override an explicit `merged: true`.
