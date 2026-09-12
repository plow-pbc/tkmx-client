// Offline coverage for the branches profile-drift.test.ts cannot reach.
//
// That guard talks to a live third-party profile, so the only path it ever exercises is
// the happy one: four machines reporting, all current, HTTP 200. Every judgement it makes
// about anything else — a WAF block, a deleted profile, nobody reporting, a risen
// minimum_client_version — is a branch the real API never takes. Two rendering bugs and a
// mis-aimed version comparison lived in exactly those branches, each one invisible for as
// long as the live data stayed healthy.
//
// So the branches are driven here with fixed inputs. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  statusOutcome,
  cmpVersion,
  freezeFailures,
  whoWroteThis,
  type Canonical,
} from "./helpers/profile-drift";

const OWNER = "174d238d9bdd6da534becd7d47556e1e";

const CANONICAL: Canonical = {
  profile: "DROdio",
  api_url: "https://example.invalid/api/user/DROdio",
  human_url: "https://example.invalid/u/DROdio",
  owner: { client_id: OWNER },
  protocol: { also_pinned_in: "sparkle: some/other/repo.rs CONST" },
  strict: {},
  strict_case_insensitive: {},
  non_empty: { fields: [] },
};

// ── status classification ─────────────────────────────────────────────────────
//
// The line is drawn at what a datacenter IP can tell apart, because this runs on every
// pull_request from a GitHub-hosted runner.

test("a WAF block and a profile gone private are the same status, so both skip", () => {
  // 403 from a runner IP is Cloudflare's opinion of CI far more often than it is a
  // profile going private. Asserting on it would redden every unrelated PR in the repo.
  assert.equal(statusOutcome(403), "skip");
  assert.equal(statusOutcome(401), "skip");
});

test("an unwell host skips", () => {
  assert.equal(statusOutcome(500), "skip");
  assert.equal(statusOutcome(503), "skip");
  assert.equal(statusOutcome(429), "skip");
});

test("a GONE profile fails — nothing else wears 404", () => {
  // This is the one non-200 with no access-control story to confuse it with, and it is
  // the drift the guard exists to catch, so it is the one that reddens the build.
  assert.equal(statusOutcome(404), "fail-gone");
  assert.equal(statusOutcome(410), "fail-gone");
});

test("a 200 is the only ok, and anything unexplained fails rather than skipping", () => {
  assert.equal(statusOutcome(200), "ok");
  assert.equal(statusOutcome(418), "fail-other");
  assert.equal(statusOutcome(302), "fail-other");
});

// ── the freeze tripwire ───────────────────────────────────────────────────────

test("cmpVersion orders bare dotted versions, and pads missing parts", () => {
  assert.ok(cmpVersion("1.4.0", "1.3.0") > 0);
  assert.ok(cmpVersion("1.3.0", "1.4.0") < 0);
  assert.equal(cmpVersion("1.3.0", "1.3.0"), 0);
  assert.equal(cmpVersion("1.3", "1.3.0"), 0);
  assert.ok(cmpVersion("1.10.0", "1.9.0") > 0);
});

test("the freeze tripwire names the DECLARED OWNER when it is the frozen box", () => {
  // The reason the comparison moved off this repo's package.json: the prose owner is a
  // reporter pinned in another repo entirely, so a package.json comparison covered every
  // machine except the only one whose freeze actually stalls the prose.
  const failures = freezeFailures(
    {
      minimum_client_version: "1.4.0",
      machines: [
        { client_id: OWNER, hostname: "founder-mac", client_version: "1.3.0" },
        { client_id: "other", hostname: "imac", client_version: "1.5.0" },
      ],
    },
    CANONICAL,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /1\.4\.0/);
  assert.match(failures[0], /1\.3\.0 — 174d238d9bdd6da534becd7d47556e1e \(founder-mac\)/);
  assert.match(failures[0], /DECLARED PROSE OWNER, its freeze stalls the prose/);
  // The current box is not implicated.
  assert.doesNotMatch(failures[0], /imac/);
});

test("the freeze tripwire is silent while every reporting machine is current", () => {
  const failures = freezeFailures(
    {
      minimum_client_version: "1.2.0",
      machines: [
        { client_id: OWNER, client_version: "1.3.0" },
        { client_id: "other", client_version: "1.2.0" },
      ],
    },
    CANONICAL,
  );
  assert.deepEqual(failures, []);
});

test("a machine reporting no version is a gap in the response, not a freeze", () => {
  // Comparing a missing version as "0.0.0" would accuse every such machine of being
  // frozen, which is a cry-wolf failure on data the server simply did not send.
  const failures = freezeFailures(
    { minimum_client_version: "1.4.0", machines: [{ client_id: "quiet" }, { client_id: "blank", client_version: "" }] },
    CANONICAL,
  );
  assert.deepEqual(failures, []);
});

test("no minimum_client_version means nothing to compare against", () => {
  assert.deepEqual(freezeFailures({ machines: [{ client_version: "0.1.0" }] }, CANONICAL), []);
  assert.deepEqual(
    freezeFailures({ minimum_client_version: "   ", machines: [{ client_version: "0.1.0" }] }, CANONICAL),
    [],
  );
});

// ── the attribution report ────────────────────────────────────────────────────

test("with nobody reporting, the report does not also claim the owner reported newest", () => {
  // The bug this pins: `newest` was undefined, the ternary fell through to the else, and
  // the report printed "The newest report is from the declared owner." directly beneath
  // the warning that the owner has never reported — contradicting itself in the one case
  // that most needs a straight answer.
  const report = whoWroteThis({ machines: [] }, CANONICAL);
  assert.match(report, /No machines are reporting under this profile at all/);
  assert.doesNotMatch(report, /The newest report is from the declared owner/);
  assert.match(report, /it has never reported/);
  assert.match(report, /\(none\)/);
});

test("the report keeps its blank separator lines", () => {
  // The bug this pins: "" was both the omit-this-line sentinel and the blank spacer, so
  // the filter that dropped the conditional lines ate every deliberate blank too and the
  // whole report rendered as one unbroken block.
  const report = whoWroteThis(
    { machines: [{ client_id: OWNER, hostname: "founder-mac", updated_at: "2026-08-20 00:00:00" }] },
    CANONICAL,
  );
  const blanks = report.split("\n").filter((l) => l === "").length;
  assert.ok(blanks >= 3, `expected the deliberate blank separators to survive, saw ${blanks}:\n${report}`);
});

test("the newest reporter is named when it is not the owner, sorted newest first", () => {
  const report = whoWroteThis(
    {
      machines: [
        { client_id: OWNER, hostname: "founder-mac", updated_at: "2026-08-14 00:00:00" },
        { client_id: "busybox", hostname: "imac", updated_at: "2026-08-20 22:00:00" },
      ],
    },
    CANONICAL,
  );
  assert.match(report, /The newest report is from busybox \(imac\), which is NOT the/);
  assert.ok(report.indexOf("busybox") < report.indexOf("founder-mac"), "newest report should sort first");
  assert.match(report, /← most recent reporter/);
  assert.match(report, /← DECLARED PROSE OWNER/);
  // It names somewhere to start looking, and says so — the freshest reporter has been
  // the wrong machine before.
  assert.match(report, /NOT necessarily the wrong machine/);
});

test("a machine the server never timestamped is still named, sorted last", () => {
  const report = whoWroteThis(
    {
      machines: [
        { client_id: "untimestamped", hostname: "ghost" },
        { client_id: OWNER, hostname: "founder-mac", updated_at: "2026-08-20 00:00:00" },
      ],
    },
    CANONICAL,
  );
  assert.match(report, /\(never\)\s+untimestamped/);
  assert.ok(report.indexOf("founder-mac") < report.indexOf("ghost"), "an untimestamped machine sorts last");
});

test("a newest machine with no client_id renders the same fallback the list does", () => {
  // The list already renders a missing client_id as "(no client_id)", so the attribution
  // sentence must not print "from undefined" one line below it and contradict its own
  // output in the case where the field is least legible.
  const report = whoWroteThis(
    { machines: [{ hostname: "imac", updated_at: "2026-08-20 22:00:00" }] },
    CANONICAL,
  );
  assert.doesNotMatch(report, /from undefined/);
  assert.match(report, /The newest report is from \(no client_id\) \(imac\)/);
});
