import { execFileSync } from "node:child_process";
import { resolveAgentsview } from "./agentsview";
import { errMessage } from "./errors";

const DEFAULT_TIMEOUT_MS = 180_000;  // 3 minutes — git integration can be slow
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface SessionStatsBlob {
  schema_version: number;
  totals?: { sessions_all?: number };
  [key: string]: unknown;
}

type PrivacyScalar = "number" | "string" | "boolean" | "null";
type PrivacyRule =
  | PrivacyScalar
  | { readonly fields: Readonly<Record<string, PrivacyRule>> }
  | { readonly list: PrivacyRule }
  | { readonly map: PrivacyRule }
  | { readonly oneOf: readonly PrivacyRule[] };

const numberMap = { map: "number" } as const satisfies PrivacyRule;
const nullableNumber = { oneOf: ["number", "null"] } as const satisfies PrivacyRule;
const distributionBucket = {
  fields: {
    count: "number",
    edge: { oneOf: ["null", { list: nullableNumber }] },
  },
} as const satisfies PrivacyRule;
const scopedDistribution = {
  fields: {
    buckets: { oneOf: ["null", { list: distributionBucket }] },
    mean: "number",
  },
} as const satisfies PrivacyRule;
const scopedDistributionPair = {
  fields: {
    scope_all: scopedDistribution,
    scope_human: scopedDistribution,
  },
} as const satisfies PrivacyRule;
const percentiles = {
  fields: { mean: "number", p50: "number", p90: "number" },
} as const satisfies PrivacyRule;
const money = { fields: { microdollars: "number" } } as const satisfies PrivacyRule;

// This is intentionally a static v1 allowlist rather than a generic JSON
// scrubber. If Agentsview adds a field, it stays local until this client has
// reviewed that field. Transcript, prompt, message, tool input/output and file
// content have no route through this schema.
const SESSION_STATS_V1_RULE = {
  fields: {
    schema_version: "number",
    window: {
      fields: { days: "number", since: "string", until: "string" },
    },
    filters: {
      // Project include/exclude arrays are intentionally omitted: local
      // project names are not needed to render public aggregate statistics.
      fields: { agent: "string", timezone: "string" },
    },
    totals: {
      fields: {
        messages_total: "number",
        sessions_all: "number",
        sessions_automation: "number",
        sessions_human: "number",
        sessions_subagent: "number",
        user_messages_total: "number",
      },
    },
    agent_portfolio: {
      fields: {
        by_messages: numberMap,
        by_messages_human: numberMap,
        by_sessions: numberMap,
        by_sessions_human: numberMap,
        by_tokens: numberMap,
        by_tokens_human: numberMap,
        primary: "string",
        primary_human: "string",
      },
    },
    archetypes: {
      fields: {
        automation: "number",
        deep: "number",
        marathon: "number",
        primary: "string",
        primary_human: "string",
        quick: "number",
        standard: "number",
      },
    },
    velocity: {
      fields: {
        first_response_seconds: percentiles,
        messages_per_active_hour: "number",
        turn_cycle_seconds: percentiles,
      },
    },
    temporal: {
      fields: {
        hourly_utc: {
          oneOf: [
            "null",
            { list: { fields: { sessions: "number", ts: "string", user_messages: "number" } } },
          ],
        },
        reporter_timezone: "string",
      },
    },
    cache_economics: {
      fields: {
        cache_hit_ratio: {
          fields: {
            buckets: { oneOf: ["null", { list: distributionBucket }] },
            overall: "number",
          },
        },
        claude_only: "boolean",
        saved_vs_uncached: money,
        spent: money,
      },
    },
    distributions: {
      fields: {
        duration_minutes: scopedDistributionPair,
        peak_context_tokens: {
          fields: {
            claude_only: "boolean",
            null_count: "number",
            scope_all: scopedDistribution,
            scope_human: scopedDistribution,
          },
        },
        tools_per_turn: scopedDistributionPair,
        user_messages: scopedDistributionPair,
      },
    },
    model_mix: { fields: { by_tokens: numberMap } },
    tool_mix: { fields: { by_category: numberMap, total_calls: "number" } },
    adoption: {
      fields: {
        adoption_scope: "string",
        claude_only: "boolean",
        distinct_skills: "number",
        plan_mode_rate: "number",
        subagents_per_session: "number",
      },
    },
    outcomes: {
      fields: {
        avg_edit_churn: "number",
        claude_only: "boolean",
        compactions_per_session: "number",
        failure: "number",
        grade_distribution: numberMap,
        success: "number",
        tool_retry_rate: "number",
        unknown: "number",
      },
    },
    outcome_stats: {
      fields: {
        commits: "number",
        files_changed: "number",
        loc_added: "number",
        loc_removed: "number",
        prs_merged: "number",
        prs_opened: "number",
        repos_active: "number",
      },
    },
    code_attribution: {
      fields: {
        sources: {
          oneOf: [
            "null",
            {
              list: {
                fields: {
                  provider: "string",
                  scope: "string",
                  status: "string",
                  metrics: {
                    fields: {
                      ai_authored_pct: "number",
                      blank_lines_added: "number",
                      blank_lines_deleted: "number",
                      composer_lines_added: "number",
                      composer_lines_deleted: "number",
                      conversation_counts: {
                        oneOf: [
                          "null",
                          { list: { fields: { count: "number", mode: "string", model: "string" } } },
                        ],
                      },
                      human_lines_added: "number",
                      human_lines_deleted: "number",
                      lines_added: "number",
                      lines_deleted: "number",
                      scored_commits: "number",
                      tab_lines_added: "number",
                      tab_lines_deleted: "number",
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
    generated_at: "string",
    extra_homes_merged: "number",
  },
} as const satisfies PrivacyRule;

function safeShortText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function sanitizeWithRule(value: unknown, rule: PrivacyRule): unknown {
  if (typeof rule === "string") {
    if (rule === "null") return value === null ? null : undefined;
    if (rule === "number") return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    if (rule === "boolean") return typeof value === "boolean" ? value : undefined;
    return safeShortText(value) ? value : undefined;
  }
  if ("oneOf" in rule) {
    for (const candidate of rule.oneOf) {
      const sanitized = sanitizeWithRule(value, candidate);
      if (sanitized !== undefined) return sanitized;
    }
    return undefined;
  }
  if ("list" in rule) {
    if (!Array.isArray(value) || value.length > 1_000) return undefined;
    const out: unknown[] = [];
    for (const item of value) {
      const sanitized = sanitizeWithRule(item, rule.list);
      if (sanitized !== undefined) out.push(sanitized);
    }
    return out;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if ("map" in rule) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (!safeShortText(key, 128)) continue;
      const sanitized = sanitizeWithRule(item, rule.map);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, childRule] of Object.entries(rule.fields)) {
    const sanitized = sanitizeWithRule(record[key], childRule);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

export function sanitizeSessionStats(value: unknown): SessionStatsBlob | null {
  const record = asRecord(value);
  if (!record || record.schema_version !== 1) return null;
  return sanitizeWithRule(record, SESSION_STATS_V1_RULE) as SessionStatsBlob;
}

// One extra agentsview home to fold into the stats blob. `dataDir` is the
// isolated AGENT_VIEWER_DATA_DIR the usage path already synced for this home
// (see collectExtraAgentsviewHomes in report.ts) — this only ever RE-READS it.
// It must never sync: agentsview's write path deadlocks under launchd (see
// syncAgentsview in agentsview.ts) and session stats must not be able to hang
// the report.
export interface ExtraStatsHome {
  name: string;
  dataDir: string;
}

type Adoption = Record<string, unknown> & {
  subagents_per_session?: number;
  plan_mode_rate?: number;
  distinct_skills?: number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Recover the session count agentsview divided by to produce its adoption
// rates. The blob publishes RATES but not that denominator, and it is NOT
// totals.sessions_all — agentsview narrows the set, measured at 14,908 against
// a sessions_all of 15,492 — so the two must never be substituted.
//
// The identity that makes this recoverable: subagents_per_session is exactly
// tool_mix.by_category.Task divided by that count. Verified against two
// independent real windows on a 15k-session install:
//   467 / 0.0313254628387443 = 14908.0   (28d)
//    82 / 0.06628940986257073 = 1237.0   (1d)
// both integral, and plan_mode_rate x N came out integral in both cases too
// (14 and 8 sessions).
//
// Returns null when it cannot be recovered (no Task calls, or a zero rate).
// The caller treats null as "do not merge adoption" rather than guessing.
export function recoverSessionCount(blob: SessionStatsBlob | null): number | null {
  const task = num(asRecord(asRecord(blob?.tool_mix)?.by_category)?.Task);
  const rate = num((asRecord(blob?.adoption) as Adoption | null)?.subagents_per_session);
  if (task === null || rate === null || task <= 0 || rate <= 0) return null;
  const n = task / rate;
  if (!Number.isFinite(n) || n <= 0) return null;
  // ROUNDED, because this is a session COUNT. agentsview computed the rate as
  // Task/N and serialized it as a float, so inverting it lands next to the
  // integer rather than on it — 467/0.0313254628387443 comes back as
  // 14907.999999999998. Carrying that noise into a sum of denominators is
  // pointless precision about a quantity that cannot be fractional.
  return Math.round(n);
}

function sumNumericInto(target: Record<string, unknown>, src: Record<string, unknown> | null): void {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    const add = num(v);
    if (add === null) continue;
    const cur = num(target[k]);
    target[k] = cur === null ? add : cur + add;
  }
}

// Fold extra homes' blobs into the primary one.
//
// WHAT IS MERGED, and what deliberately is not. The server stores
// session_stats WHOLESALE, so a field merged wrongly is not a smaller number —
// it is a wrong one on a public profile. Same reasoning that makes a missing
// usage home fatal in the token path.
//
//   • totals.*             summed (session and message counts are additive)
//   • tool_mix.by_category
//     and total_calls      summed
//   • adoption rates       RECOMPUTED from recovered numerators and
//                          denominators (see recoverSessionCount), never
//                          averaged: the mean of two rates over different
//                          session counts is a different quantity.
//   • distinct_skills      MAX, not sum. The blob carries a count, not the
//                          skill names, so a skill used in two homes cannot be
//                          de-duplicated; max is an honest lower bound and
//                          summing would inflate it.
//   • everything else      the primary home's value, unchanged. Distributions,
//                          archetypes, velocity and temporal shapes do not
//                          publish the weighting they were built from, so
//                          there is nothing to combine them on.
//
// If any contributing home's denominator cannot be recovered, adoption is left
// as the primary's and `adoption_scope` records that, rather than presenting a
// partial merge as a whole-machine figure.
export function mergeSessionStats(
  primary: SessionStatsBlob,
  extras: SessionStatsBlob[],
): SessionStatsBlob {
  if (extras.length === 0) return primary;
  const out: SessionStatsBlob = { ...primary, extra_homes_merged: extras.length };

  const totals: Record<string, unknown> = { ...(asRecord(primary.totals) ?? {}) };
  for (const e of extras) sumNumericInto(totals, asRecord(e.totals));
  if (Object.keys(totals).length > 0) out.totals = totals as SessionStatsBlob["totals"];

  const pmix = asRecord(primary.tool_mix);
  if (pmix) {
    const byCat: Record<string, unknown> = { ...(asRecord(pmix.by_category) ?? {}) };
    let calls = num(pmix.total_calls) ?? 0;
    for (const e of extras) {
      const emix = asRecord(e.tool_mix);
      if (!emix) continue;
      sumNumericInto(byCat, asRecord(emix.by_category));
      calls += num(emix.total_calls) ?? 0;
    }
    out.tool_mix = { ...pmix, by_category: byCat, total_calls: calls };
  }

  const padopt = asRecord(primary.adoption) as Adoption | null;
  if (padopt) {
    const contributors = [primary, ...extras.filter((e) => asRecord(e.adoption))];
    const counts = contributors.map((b) => recoverSessionCount(b));
    if (counts.every((n): n is number => n !== null)) {
      let sessions = 0;
      let subagents = 0;
      let planSessions = 0;
      let skills = 0;
      contributors.forEach((b, i) => {
        const n = counts[i] as number;
        const a = asRecord(b.adoption) as Adoption;
        sessions += n;
        subagents += num(asRecord(asRecord(b.tool_mix)?.by_category)?.Task) ?? 0;
        // plan_mode_rate x N is the session count behind the rate. Rounded
        // because it is an integer count recovered through a float division.
        planSessions += Math.round((num(a.plan_mode_rate) ?? 0) * n);
        skills = Math.max(skills, num(a.distinct_skills) ?? 0);
      });
      out.adoption = {
        ...padopt,
        subagents_per_session: subagents / sessions,
        plan_mode_rate: planSessions / sessions,
        distinct_skills: skills,
        adoption_scope: `merged:${contributors.length}`,
      };
    } else {
      out.adoption = { ...padopt, adoption_scope: "primary-only" };
    }
  }

  return out;
}

function runStats(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string,
): SessionStatsBlob | null {
  let raw: string;
  try {
    raw = execFileSync(bin, args, {
      encoding: "utf-8" as const,
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: DEFAULT_TIMEOUT_MS,
      env,
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() || "";
    const detail = stderr ? `: ${stderr}` : `: ${errMessage(err)}`;
    console.error(`[session-stats] agentsview failed${label}${detail}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[session-stats] JSON parse failed${label}: ${errMessage(err)}`);
    return null;
  }

  const sanitized = sanitizeSessionStats(parsed);
  if (!sanitized) {
    console.error(`[session-stats] unsupported or unsafe output shape${label}`);
    return null;
  }
  return sanitized;
}

// collectSessionStats runs `agentsview stats --format json` and returns
// the parsed blob, or null on any error (missing binary, non-zero exit,
// non-JSON output). Errors are logged but never propagate — the reporter
// treats session stats as a best-effort addition and must keep working.
//
// GH_TOKEN / GITHUB_TOKEN are passed through the child env (execFileSync
// inherits process.env by default) rather than on argv, so the token
// doesn't show up in `ps` output.
//
// `extraHomes` are the EXTRA_CLAUDE_CONFIGS / EXTRA_CODEX_CONFIGS homes the
// usage path already collects. They used to reach the token totals ONLY: this
// function took no data-dir argument, so it always read the default
// ~/.agentsview DB and every stats panel silently excluded them. On a machine
// whose agents run under per-account stores that is a structural blind spot —
// the operator configures the home, its tokens ARE counted, and the subagent /
// plan-mode / tool-mix panels quietly describe a subset of the machine while
// looking authoritative.
//
// A home that fails to read is skipped and logged rather than fatal. That is
// the opposite of the usage path (where a missing home aborts the run, because
// a partial TOTAL posts as success) and it is deliberate: the worst case here
// degrades to exactly the blob this function returned before the argument
// existed, whereas aborting would throw away a whole report over a best-effort
// field.
export function collectSessionStats({
  sinceDays = 28,
  timezone,
  extraHomes = [],
}: {
  sinceDays?: number;
  timezone?: string;
  extraHomes?: ExtraStatsHome[];
} = {}): SessionStatsBlob | null {
  const bin = resolveAgentsview();
  if (!bin) {
    console.error("[session-stats] agentsview binary not found; skipping");
    return null;
  }
  const args = ["stats", "--format", "json", "--since", `${sinceDays}d`];
  if (timezone) args.push("--timezone", timezone);

  const primary = runStats(bin, args, process.env, "");
  if (!primary) return null;

  const extras: SessionStatsBlob[] = [];
  for (const home of extraHomes) {
    const blob = runStats(
      bin,
      args,
      { ...process.env, AGENT_VIEWER_DATA_DIR: home.dataDir },
      ` (${home.name})`,
    );
    if (blob) extras.push(blob);
    else console.error(`[session-stats] ${home.name}: skipped — the stats blob excludes it`);
  }

  return mergeSessionStats(primary, extras);
}
