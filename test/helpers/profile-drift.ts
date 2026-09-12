// The pure, testable half of test/profile-drift.test.ts.
//
// These three functions encode the judgements the drift guard makes, and every one of
// them fires only under a condition the LIVE profile does not currently produce: a WAF
// block, a deleted profile, an empty machines array, a risen minimum_client_version. Run
// against the real API they are all dead branches, which is exactly how their bugs
// survived — a contradictory report and a stripped-blank-line report both render fine
// when there are four machines and nothing is frozen. Split out here so
// test/profile-drift-report.test.ts can drive each branch with a fixed input, offline.

export interface Machine {
  client_id?: string;
  hostname?: string;
  os?: string;
  cpu?: string;
  memory_gb?: number;
  client_version?: string;
  agentsview_version?: string;
  updated_at?: string;
}

/// The shape of test/fixtures/profile-canonical.json that code actually reads. Keys
/// beginning with "_" are prose for the human reading the fixture and are skipped by the
/// assertion loops, so they are not modelled here.
export interface Canonical {
  profile: string;
  api_url: string;
  human_url: string;
  owner: { client_id: string };
  protocol: { also_pinned_in: string };
  strict: Record<string, string>;
  strict_case_insensitive: Record<string, string>;
  non_empty: { fields: string[] };
  known_bad?: Record<string, string[]>;
}

/// What a given HTTP status means for this guard, from a DATACENTER IP. The line is
/// drawn at what a GitHub-hosted runner can tell apart; see the header of
/// profile-drift.test.ts for why each one falls where it does.
export type StatusOutcome = "ok" | "skip" | "fail-gone" | "fail-other";

export function statusOutcome(status: number): StatusOutcome {
  if (status === 200) return "ok";
  if (status >= 500 || status === 429) return "skip";   // host unwell
  if (status === 401 || status === 403) return "skip";  // WAF block vs went-private: same status
  if (status === 404 || status === 410) return "fail-gone";
  return "fail-other";
}

/// Semver-ish compare over bare dotted numbers, the same shape tkmx-server parses.
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/// The silent-freeze tripwire, measured against the LIVE machines[].client_version.
///
/// Deliberately NOT measured against this repo's package.json: that is one reporter's
/// version, while the declared prose owner is Sparkle's native reporter, pinned in a
/// different repo (canonical.protocol.also_pinned_in) and unreadable from here. A
/// package.json comparison therefore covered every machine EXCEPT the one whose freeze
/// actually stalls the prose. The response already carries the real number for every
/// reporting client, so no version needs to live in this repo at all — and the failure
/// names the frozen box instead of guessing at it.
export function freezeFailures(profile: Record<string, unknown>, canonical: Canonical): string[] {
  const minimum = profile.minimum_client_version;
  if (typeof minimum !== "string" || minimum.trim() === "") return [];

  // A machine reporting no version at all is a gap in the response, not evidence of a
  // freeze, so it is skipped rather than compared as "0.0.0".
  const frozen = ((profile.machines as Machine[]) || []).filter(
    (m) =>
      typeof m.client_version === "string" &&
      m.client_version.trim() !== "" &&
      cmpVersion(minimum, m.client_version) > 0,
  );
  if (frozen.length === 0) return [];

  const plural = frozen.length !== 1;
  return [
    `server minimum_client_version is now ${minimum}, ABOVE the version ${plural ? "machines" : "a machine"} reporting\n` +
      `  under this profile posts. ${plural ? "They are" : "It is"} being FROZEN — the POST still returns 200 with\n` +
      `  ok:true, so nothing else will tell you:\n` +
      frozen
        .map(
          (m) =>
            `    ${m.client_version} — ${m.client_id || "(no client_id)"} (${m.hostname || "?"})` +
            (m.client_id === canonical.owner.client_id
              ? "  ← DECLARED PROSE OWNER, its freeze stalls the prose"
              : ""),
        )
        .join("\n") +
      `\n  Bump the reporter on ${plural ? "those boxes" : "that box"}: this repo's package.json version is what\n` +
      `  reporter/report.ts posts, and Sparkle's own reporter is pinned in\n` +
      `  ${canonical.protocol.also_pinned_in}.`,
  ];
}

/// The attribution report. This is the point of the whole guard, so it is built
/// unconditionally on failure and appended to every assertion message.
export function whoWroteThis(profile: Record<string, unknown>, canonical: Canonical): string {
  const machines = ((profile.machines as Machine[]) || [])
    .slice()
    // Missing updated_at sorts last rather than throwing — a machine the server has
    // never timestamped is still worth naming.
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));

  const owner = canonical.owner.client_id;
  const lines = machines.map((m, i) => {
    const marks = [
      i === 0 ? "← most recent reporter" : "",
      m.client_id === owner ? "← DECLARED PROSE OWNER" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return [
      `    ${m.updated_at || "(never)"}  ${m.client_id || "(no client_id)"}`,
      `      host ${m.hostname || "?"} | ${m.cpu || "?"} | ${m.memory_gb ?? "?"}GB | ${m.os || "?"}`,
      `      client ${m.client_version || "?"} | agentsview ${m.agentsview_version || "?"} ${marks}`,
    ].join("\n");
  });

  const newest = machines[0];
  const ownerPresent = machines.some((m) => m.client_id === owner);

  // Which single sentence answers "where do I go look?" — and it must not answer twice.
  // With an EMPTY machines array `newest` is undefined, and the old ternary fell through
  // to "the newest report is from the declared owner", printing that directly beneath the
  // warning that the owner has never reported. Nobody-is-reporting is its own outcome.
  const attribution =
    machines.length === 0
      ? "  No machines are reporting under this profile at all, so nothing here wrote the live\n  values. Whatever is setting them is outside the reporting path entirely."
      : newest.client_id !== owner
        ? `  The newest report is from ${newest.client_id || "(no client_id)"} (${newest.hostname || "?"}), which is NOT the\n  owner. Start there — but read the caveat below before concluding it is the culprit.`
        : "  The newest report is from the declared owner.";

  // null is the omit-this-line sentinel, NOT "". The two were the same value once, so the
  // filter that dropped the conditional lines also ate every deliberate blank spacer below
  // and the report rendered as one unbroken block.
  return [
    "",
    "  ── WHICH MACHINE IS WRITING THIS PROFILE ────────────────────────────────",
    `  Machines reporting under ${canonical.profile}, newest report first:`,
    ...(machines.length === 0 ? ["    (none)"] : lines),
    "",
    `  Declared prose owner: ${owner}`,
    ownerPresent ? null : "  WARNING: the declared owner is not in this list at all — it has never reported,",
    ownerPresent ? null : "  or its client_id changed. Prose has no legitimate writer until that is resolved.",
    attribution,
    "",
    "  CAVEAT: updated_at is when that client last REPORTED, not when it last wrote the",
    "  drifted field, and the newest reporter is NOT necessarily the wrong machine — a stale",
    "  box has held the correct value while a busy box overwrote it. The server records",
    "  the exact answer as a profile_update event (field/old_value/new_value) but exposes",
    "  no route to read it; until it does, this is the best attribution available.",
    `  Human-readable profile: ${canonical.human_url}`,
    "  ─────────────────────────────────────────────────────────────────────────",
  ]
    .filter((l) => l !== null)
    .join("\n");
}
