## Progress Update as of 2026-08-31 17:45 PDT
*(Most recent updates at top)*

### Summary of changes since last update
The reporter now diffs its badge lists (TOOLS / PROJECTS / COMMUNITIES) against the profile the
server already holds and says what it is about to ADD — flagging anything that reads as a
duplicate of a badge already there — instead of silently minting new chips
(builder-index-client-fgm). Stacked on the branch behind PR 82, which it shares
`reporter/report.ts` with.

### Detail of changes made:
- `reporter/tag-diff.ts` (new): pure diff. Two deliberately different normalizations — exact
  (lowercase+trim) mirrors the server's dedupe, so a match there is a no-op worth no warning;
  loose (letters+digits only, Unicode-aware) does NOT mirror the server, which is the point:
  "WisprFlow" vs "Wispr Flow" is two chips server-side and one tool to a human. Also catches
  self-collisions — two entries in one machine's own .env that collide with each other, which a
  diff against the server alone cannot see.
- `reporter/report.ts`: best-effort GET of the stored profile (reusing `buildListUrl` from
  untag.ts, cache-buster included — the profile read is `cache-control: public` with no max-age)
  and prints the diff BEFORE the POST, because the union is applied the instant the request
  lands. Explicit 5s timeout: the default is no timeout, and a hung read would stall a
  launchd/systemd job indefinitely. Every failure path returns null and the report proceeds.
- Skips the fetch entirely when this machine configures none of the three lists — it posts no
  badges, so there is nothing to warn about and no reason to spend a request.
- Tests: `test/tag-diff.test.ts` (15 unit cases incl. the accented-lookalike false positive and
  the "near-duplicate must not also be listed as a plain addition" shape) plus 4 e2e rows
  driving the real reporter against a stub profile. The e2e stub grew `profileJson` and
  `profileStatus` so "the server holds no badges" and "the client could not find out" are
  distinguishable — they must behave differently.
- The e2e rows pin the ORDER, not just the presence: verified by moving the call after the POST,
  which fails 2 rows with "must be printed BEFORE the report is posted".

### Beads activity:
- Claimed: builder-index-client-fgm

### Potential concerns to address:
- A typo that is not a spacing/punctuation variant ("WhsprFlow" vs "WisprFlow") is still not
  detectable — no automatic rule calls that a duplicate without also flagging unrelated names.
  It is reported as a plain addition, which at least makes it visible before it lands.
- Suite: 296 tests, 291 pass, 5 fail — the same pre-existing host-dependent failures as main
  (builder-index-client-trk, fixed by PR 70). Baseline on this branch's parent: 277/272/5.
