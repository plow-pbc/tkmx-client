# Review instructions — tkmx-client

## Cause-first bug fixes

Fix a bug at its cause so the class can't recur. Never fix it with a layer, guard, link, workaround or hand-edit of data around it. A fix that adds net complexity must state why in the PR. When the bug comes from a duplicated source or identity, remove the duplicate rather than bridging the two.

Reviewer-facing policy for this repo. Read it before any other input: it carries
the operating point and the voice posture every finding must satisfy. The
review-loop rules are org policy and are appended by each reviewer from its own
copy, so they are not in this file.

Both reviewers read this. knightwatch stages it from the base branch; roborev
gets it inlined into `.roborev.toml` by `just sync-review-config` in the
`claude-config` repo — so an edit here reaches roborev only after that sync runs.

`standards.md` references below resolve inside the knightwatch bundle only.

## Product context

**Stage:** Internal tool. Small user base. Bias: simplicity over completeness.

**Distribution model:** Internal only; no external customer deployments.

**Architectural commitments:**
- Keep the reporter cron self-contained and restartable; it runs unattended every 2 hours. Source is `reporter/report.ts`; installed units run the compiled `dist/reporter/report.js` (`reporter/report.js` is only a shim for pre-migration installs).
- Fail-fast on config or credential errors — do not silently skip reporting cycles.

**Known near-term migrations / roadmap items:**
- None tracked here yet. Update when roadmap items emerge.

**Review posture:** Architecture specialist should flag anything that adds external-facing surface area (this is an internal tool — treat new public endpoints, new auth surfaces, or new third-party integrations as notable).

**Update cadence:** Quarterly or on major direction change.

## Review priority

**Stage:** Internal tool, single-digit operators, no external user surface. Iteration is rapid and the operator (also the engineer) can re-run anything that fails. Engineer-hours are the bottleneck. Matches § Product context above.

**Cultural emphasis:** RAPID ITERATION + FAIL LOUDLY. The operator notices when the reporter cron silently skips a cycle — much faster than they notice when the code grows a defensive guard for a scenario that won't happen. Loud breaks > silent skips. The universal Broken-Glass posture (questions over prescriptions, cost-naming for additive remedies, declarative voice for high-confidence bugs only) lives in `standards.md` § Broken-Glass Test — apply it here, especially: scope-creep findings must name the cost ("adds complexity and makes PMF iteration harder").

**Repo-specific contrast pairs:** beyond the universal set in `standards.md`:

| Architecture bloat — DON'T (in this repo) | Bugfix — DO |
|---|---|
| Push for retry-with-backoff on the reporter cron — it runs every 2h, the operator notices a missed cycle, re-running is one command. | Catch a real failure mode that drops a cycle silently (swallowed exception, soft fallback that hides a credential error). |
| Suggest a config-validation framework for a config file with five keys read at startup. | Fail loudly on missing/malformed config keys at startup — the operator gets a clear error, not a quiet skip. |
| Add a queue / job runner / abstraction layer for unattended scripts running once every 2h. | Make the script idempotent so a re-run after a partial failure produces the right end state. |
| Push for tests of internal cron mechanics (timer wakeups, tick alignment) where the OS is the actual source of truth. | Add a behavior test for what the script actually emits when given a known input. |
| Recommend wrapping `console.log` / `console.error` in a logger abstraction for a single-process script with one operator. | Make sure failures land somewhere the operator will actually see them (stderr, exit code, not buried in the same logfile as routine output). |

**Voice posture for this repo:** Findings of the form "this could break if we add 100 users / a second operator / a public API" should be reframed as questions. The operating point is one operator, no scale, no public surface. If the finding doesn't survive the question "is this happening today?", down-weight it.
