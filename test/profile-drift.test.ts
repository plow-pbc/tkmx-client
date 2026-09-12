// Drift guard for the Builder Index profile — the checked-in tripwire behind
// test/fixtures/profile-canonical.json.
//
// WHY THIS TEST EXISTS
//
// The profile's prose fields have silently reverted to a stale value four separate
// times. Every previous fix was a data-level correction posted against the API, and
// every one was undone within about two hours by a machine nobody had identified.
// Each recurrence started the same investigation from zero, because the profile
// records WHAT it holds and never WHO put it there.
//
// So the expensive part was never the correction. It was attribution. This test's
// real product is its failure message: on any assertion failure it prints every
// client_id that reports under this profile, sorted newest-report-first, so the
// question "which machine should I go look at?" is answered by reading the output
// instead of by a fifth investigation.
//
// WHAT IT DOES NOT CLAIM. `machines[].updated_at` is when that client last REPORTED,
// not when it last wrote the field that drifted. The server does record the real
// answer — buildApiKeyFieldOps emits a profile_update event carrying field, old_value
// and new_value — but no GET route exposes it, so the newest reporter is the best
// attribution available from outside. The output says so rather than implying more
// precision than it has. Exposing that event feed would make this exact, and is the
// single highest-value change to the server for this class of bug.
//
// AND IT IS NOT A RANKING. Do not read "most recent reporter" as "the culprit" — the
// output says REPORTER throughout, never writer, because reporting is the only thing
// updated_at measures. On 2026-08-20 the CORRECT value sat on a box that had not
// reported in six days while a box reporting every two hours kept overwriting it: the
// freshest reporter was the wrong machine. The line names somewhere to start looking;
// ownership is declared in the fixture, never inferred here.
//
// CI POSTURE: this runs on every pull_request from a GitHub-hosted runner, so the line
// is drawn at what a DATACENTER IP can be told apart from. Skip (exit 0) on a transport
// failure, on 5xx/429 (the host is unwell), and on 401/403 — a WAF challenging a runner
// IP and a profile that went private are the SAME status from out here, and reddening
// every unrelated PR in the repo on Cloudflare's mood is precisely the cry-wolf failure
// this file is trying not to become. Fail hard on 404/410: the profile is GONE, which is
// unambiguous and is the drift case the guard exists for. Fail hard on any other non-200
// and on a 200 whose body breaks the contract; see fetchProfile.
//
// The residual trade is stated plainly: an outage or a block hides drift for that run, so
// this is a ratchet against a value changing SILENTLY, not an uptime monitor.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
// The judgement calls live in helpers/ so they can be driven offline. Every one of them
// fires only on a condition the live profile does not produce — a WAF block, a deleted
// profile, an empty machines list, a risen minimum — so against the real API they are
// dead branches, and that is how their bugs survived. See
// test/profile-drift-report.test.ts, which exercises each with a fixed input.
import {
  statusOutcome,
  freezeFailures,
  whoWroteThis,
  type Canonical,
} from "./helpers/profile-drift";

const CANONICAL: Canonical = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "profile-canonical.json"), "utf8"),
);

const TIMEOUT_MS = 15_000;

/// Either the profile, or the reason this run is skipping — never a bare null. The
/// reason is carried rather than reconstructed at the call site, because the two skip
/// causes look nothing alike to an operator: "the host never answered" and "the host
/// answered 503" are different problems and the message must not claim the first when
/// it was the second.
///
/// A reachable API that answers WRONGLY is not automatically a skip. The earlier
/// revision of this file collapsed a transport error, a non-200 and a 200 carrying an
/// HTML error page into one "unreachable" branch, so a genuine contract break exited 0
/// while the header claimed it asserted hard. The outcomes, deliberately:
///   * transport error / timeout — SKIP. Never reached the host.
///   * 5xx / 429 — SKIP. Reached it; it is unwell. Not this repo's regression.
///   * 401 / 403 — SKIP. Indistinguishable from out here: a WAF challenging a GitHub
///     runner's datacenter IP and a profile that went private both answer this way, and
///     only one of them is drift. Failing would redden every unrelated PR in the repo
///     the first time the host's edge decides it dislikes CI.
///   * 404 / 410 — FAIL. The profile is GONE. No access-control story explains it, so
///     there is nothing to confuse it with; this is the drift the guard exists to catch.
///   * any other non-200 — FAIL. The endpoint answered something nobody has a story for.
///   * 200 whose body is not JSON, or carries no machines array — FAIL. It answered, and
///     the answer does not satisfy the contract.
type ProfileFetch =
  | { profile: Record<string, unknown>; skip?: undefined }
  | { profile?: undefined; skip: string };

async function fetchProfile(): Promise<ProfileFetch> {
  // Read off globalThis rather than calling `fetch` directly: the tsconfig lib is
  // ES2022, which does not declare it, and this file must compile without pulling a
  // DOM lib in for one call.
  const fetchFn = (globalThis as { fetch?: (...a: unknown[]) => Promise<unknown> }).fetch;
  if (typeof fetchFn !== "function") {
    return { skip: "this runtime has no global fetch, so the profile cannot be read" };
  }

  let res: any;
  try {
    res = await fetchFn(CANONICAL.api_url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    return {
      skip: `never reached ${CANONICAL.api_url} (${(err as Error)?.message || "transport error"})`,
    };
  }

  const outcome = statusOutcome(res.status);
  if (outcome === "skip") {
    return {
      skip:
        `${CANONICAL.api_url} answered ${res.status} — either the host is unwell or its edge is ` +
        `blocking this IP, and from out here a WAF challenge and a profile gone private wear the ` +
        `same status. Not assertable from a CI runner.`,
    };
  }
  assert.notEqual(
    outcome,
    "fail-gone",
    `${CANONICAL.api_url} answered ${res.status} — the profile is GONE (deleted, or renamed away ` +
      `from ${CANONICAL.profile}). That is not an outage and not an access block; restore the ` +
      `profile or update the fixture.`,
  );
  assert.equal(res.status, 200, `${CANONICAL.api_url} answered ${res.status} — the profile is not readable`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    assert.fail(`${CANONICAL.api_url} answered 200 with a body that is not JSON`);
  }
  assert.ok(
    body && typeof body === "object" && Array.isArray((body as any).machines),
    `${CANONICAL.api_url} answered 200 but the body carries no machines array`,
  );
  return { profile: body as Record<string, unknown> };
}

test("builder index profile has not drifted from canonical", async (t) => {
  const { profile, skip } = await fetchProfile();
  if (!profile) {
    t.skip(`${skip} — skipping rather than reddening the build on something this repo did not cause`);
    return;
  }

  const who = whoWroteThis(profile, CANONICAL);
  const failures: string[] = [];

  // ── scalar fields, pinned exactly ────────────────────────────────────────────
  //
  // These are SCALAR_API_KEY_FIELDS on the server: an empty string is a string, so it
  // passes the only type guard and BLANKS the stored value. They are the fields a
  // misconfigured client can actually destroy, so nothing less than exact is enough.
  for (const [key, want] of Object.entries(CANONICAL.strict)) {
    if (key.startsWith("_")) continue;
    const got = profile[key];
    if (got === want) continue;

    const bad = CANONICAL.known_bad?.[key] || [];
    const recurrence = bad.includes(got as string)
      ? `\n  THIS IS A KNOWN RECURRENCE — ${JSON.stringify(got)} is a value this profile has reverted to before.\n  It is not new drift; it is the same regression again.`
      : "";
    const blanked = got === ""
      ? "\n  The live value is the EMPTY STRING. Per server/db.ts buildApiKeyFieldOps, only an\n  explicit empty string can do this — a client that OMITS the key is ignored. So some\n  client sent \"\" rather than sending nothing."
      : "";

    failures.push(
      `${key} drifted\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}${recurrence}${blanked}`,
    );
  }

  // ── scalar fields pinned by identity, not by casing ──────────────────────────
  //
  // Same destroy-by-empty-string exposure as above, so still pinned — but compared
  // case-insensitively, because the casing carries no meaning and changes for
  // reasons that are not regressions. See the fixture's note.
  for (const [key, want] of Object.entries(CANONICAL.strict_case_insensitive)) {
    if (key.startsWith("_")) continue;
    const got = profile[key];
    if (typeof got === "string" && got.toLowerCase() === want.toLowerCase()) continue;
    const blanked = got === ""
      ? "\n  The live value is the EMPTY STRING — only an explicit \"\" can do that; an omitted key is ignored."
      : "";
    failures.push(
      `${key} drifted (compared case-insensitively)\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}${blanked}`,
    );
  }

  // ── fields that must merely be present and non-blank ─────────────────────────
  //
  // Pinning these exactly would fail on every legitimate edit, and a guard that cries
  // wolf gets deleted. Blanking is the failure that costs something, so that is what
  // is caught.
  for (const key of CANONICAL.non_empty.fields) {
    const got = profile[key];
    if (typeof got === "string" && got.trim() !== "") continue;
    failures.push(
      `${key} is blank or missing (got ${JSON.stringify(got)}) — it is expected to carry content.`,
    );
  }

  // ── the silent-freeze tripwire ───────────────────────────────────────────────
  //
  // Not prose, but the same class of bug: a state where the profile stops tracking
  // reality and nothing says so. The server freezes any profile whose client_version is
  // below minimum_client_version, answers the POST 200/ok:true anyway, and the profile
  // simply stops moving. Catching the minimum RISING is the only warning available
  // before that happens. Measured against the live machines, not a version pinned here —
  // see freezeFailures for why that distinction is the whole point.
  failures.push(...freezeFailures(profile, CANONICAL));

  // A profile the server itself considers stale is frozen right now.
  if (profile.versions_outdated === true) {
    failures.push(
      "server reports versions_outdated: true — this profile is FROZEN on its last snapshot\n" +
      "  and is no longer tracking reality, regardless of what the values above say.",
    );
  }

  assert.equal(
    failures.length,
    0,
    `Builder Index profile drifted from test/fixtures/profile-canonical.json\n\n` +
      failures.map((f, i) => `  ${i + 1}. ${f}`).join("\n\n") +
      `\n${who}\n\n` +
      `  If the LIVE value is the correct one, update the fixture — that diff is the record.\n`,
  );
});
