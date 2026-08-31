# Verifying that a PR actually merged

An agent asked to merge a PR and report the result can produce a confident,
checkable-looking, completely wrong answer. This page says which signal to
trust.

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

## Trust one of these instead

**The PR's own merged flag.** `merged_at` is null until the merge happens:

```bash
gh pr view <N> --json merged,mergedAt,state
```

**Ancestry on the real branch.** This answers the question that actually
matters — is the work on `main`? — and it stays correct no matter how the PR
was closed, squashed, or rebased:

```bash
git fetch origin
git merge-base --is-ancestor <head-sha> origin/main && echo merged || echo "not merged"
```

Both checks were run against PR #72 above, and both correctly said not merged.

## Reporting rule

Report a PR as merged only when `merged` is true or the ancestor check passes.
If the two disagree, believe the ancestor check and say what you saw — a
disagreement is worth surfacing, not smoothing over.
