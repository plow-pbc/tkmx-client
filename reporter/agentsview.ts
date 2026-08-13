import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { errMessage } from "./errors";
import Database from "better-sqlite3";
import type { DailyUsage, ModelBreakdown } from "./usage";

interface RawMoney {
  microdollars: number;
}

// Raw breakdown shape from `agentsview usage daily --json`. Token counters
// may be omitted (agentsview elides zeros) and totalTokens is always
// computed downstream — this is the wire shape, not the internal one.
// Kept private to this module: only parseAgentsviewOutput sees it.
interface RawModelBreakdown {
  modelName: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cost?: number | RawMoney;
  source?: string;
}

// Raw shape we accept from `agentsview usage daily --json`. Tolerant on
// purpose — agentsview occasionally omits the modelBreakdowns array on
// empty days.
interface RawDailyEntry {
  date: string;
  modelBreakdowns?: RawModelBreakdown[];
}

// Resolve agentsview binary — launchd/systemd don't inherit user shell PATH,
// so we can't rely on execvp's default search. Resolution order:
//   1. $AGENTSVIEW_BIN (explicit override for nix, asdf, custom installs)
//   2. Hard-coded install-location candidates (matches the quickstart)
//   3. $PATH (covers interactive runs)
// agentsview ships a native binary: `agentsview.exe` on Windows (its installer
// drops it in %USERPROFILE%\.agentsview\bin and adds that dir to PATH), bare
// `agentsview` elsewhere. We deliberately don't probe `.cmd`/`.bat` shims — the
// installer never writes one, and execFileSync can't run a command shim on
// Windows without a shell, so resolving to one would only hand the caller a
// path it can't exec. Parameterized over { platform, env, isExecutable } (with
// target-platform path semantics) so the Windows branch is testable on any host.
interface ResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable: (p: string) => boolean;
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "agentsview.exe" : "agentsview";
}

function agentsviewCandidates(deps: ResolveDeps): string[] {
  const p = pathFor(deps.platform);
  const name = binaryName(deps.platform);
  const candidates: string[] = [];
  for (const home of uniqueDefined([deps.env.HOME, deps.env.USERPROFILE])) {
    candidates.push(p.join(home, ".local", "bin", name));
    candidates.push(p.join(home, ".agentsview", "bin", name));
  }
  candidates.push("/opt/homebrew/bin/agentsview", "/usr/local/bin/agentsview");
  return uniqueDefined(candidates);
}

function resolveFromPath(deps: ResolveDeps): string | null {
  const p = pathFor(deps.platform);
  const name = binaryName(deps.platform);
  // process.env is case-insensitive on Windows, so PATH already resolves a
  // `Path`/`path`-cased var (production passes process.env; tests inject PATH).
  const pathValue = deps.env.PATH || "";
  for (const dir of pathValue.split(p.delimiter)) {
    if (!dir) continue;
    const candidate = p.join(dir, name);
    if (deps.isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveAgentsviewWith(deps: ResolveDeps): string | null {
  const override = deps.env.AGENTSVIEW_BIN;
  if (override && deps.isExecutable(override)) return override;
  for (const candidate of agentsviewCandidates(deps)) {
    if (deps.isExecutable(candidate)) return candidate;
  }
  return resolveFromPath(deps);
}

export function resolveAgentsview(): string | null {
  return resolveAgentsviewWith({
    platform: process.platform,
    env: process.env,
    isExecutable: isExecutableFile,
  });
}

// Parses `agentsview --version` raw output like
//   "agentsview v0.23.0-2-g1b484fb (commit 1b484fb, built 2026-04-19T00:00:00Z)"
// into the bare git-describe core ("0.23.0" / "0.23.0-2-g1b484fb"). The
// server's MIN-version gate compares the leading X.Y.Z, so the wrapper
// prefix and "(commit …, built …)" tail are dropped to keep the wire
// value compact and directly displayable. Returns null if the binary is
// missing or `--version` fails.
export function detectAgentsviewVersion(bin: string | null, timeoutMs: number = 5000): string | null {
  if (!bin) return null;
  let raw: string;
  try {
    raw = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: timeoutMs,
    }).trim();
  } catch (err) {
    console.error(`  agentsview --version failed: ${errMessage(err)}`);
    return null;
  }
  const m = raw.match(/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

export function toIsoDate(sinceStr: string): string {
  return `${sinceStr.slice(0, 4)}-${sinceStr.slice(4, 6)}-${sinceStr.slice(6, 8)}`;
}

interface AgentsviewJson {
  daily?: RawDailyEntry[];
}

export type AgentsviewUsageByAgent = Record<string, DailyUsage[]>;

// Which agents to collect comes from the local index, not a list in this file.
// AgentsView grows parsers between releases — 0.25 already handles copilot,
// gemini, cursor, iflow and amp beyond the four this used to name — and a
// machine can carry an agent no release anticipated (`hermes`, here). A literal
// list drops every one of them the same way: the reporter exits 0, the POST
// succeeds, and the source simply never appears on the profile. Reading the
// index instead means a new agent is collected the first time it writes a
// session, with no client release.
//
// Same better-sqlite3 read pattern as reporter/cursor.ts.
export function discoverAgents(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || env.USERPROFILE || "";
  // Deliberately not AGENT_VIEWER_DATA_DIR: that names the isolated per-home
  // index this reporter hands a child scanning one EXTRA_*_CONFIGS home, which
  // is the opposite of the local index the local agent list comes from.
  const dataDir = env.AGENTSVIEW_DATA_DIR || path.join(home, ".agentsview");
  const dbPath = path.join(dataDir, "sessions.db");

  // Throws rather than returning [] — an empty list collects nothing, and a
  // reporter that POSTs zero usage looks exactly like a quiet day. REVIEW.md
  // asks for loud breaks over silent skips, and this is the skip it means.
  // (cursor.ts loads better-sqlite3 dynamically because it returns null on
  // failure; discovery aborts the run either way, so a catch buys nothing.)
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    throw new Error(`cannot read the AgentsView index at ${dbPath}: ${errMessage(err)}`);
  }
  try {
    const rows = db.prepare(
      "SELECT DISTINCT agent FROM sessions WHERE agent IS NOT NULL AND agent != '' ORDER BY agent",
    ).all() as Array<{ agent: string }>;
    return rows.map((r) => r.agent);
  } finally {
    db.close();
  }
}

function costDollars(cost: RawModelBreakdown["cost"]): number | undefined {
  if (cost === undefined) return undefined;
  if (typeof cost === "number") return cost;
  if (!Number.isSafeInteger(cost.microdollars) || cost.microdollars < 0) {
    throw new Error("agentsview cost.microdollars must be a non-negative safe integer");
  }
  return cost.microdollars / 1_000_000;
}

// Convert `agentsview usage daily --json` output into the normalized
// internal shape. Defaults missing per-token-type counters to 0 and
// computes totalTokens once, so downstream code (merge.ts / report.ts)
// can rely on every counter being a finite number.
export function parseAgentsviewOutput(parsed: AgentsviewJson, source: string): DailyUsage[] {
  const daily = parsed.daily || [];
  return daily.map((day) => {
    const modelBreakdowns: ModelBreakdown[] = (day.modelBreakdowns || []).map((m) => {
      const inputTokens = m.inputTokens || 0;
      const outputTokens = m.outputTokens || 0;
      const cacheCreationTokens = m.cacheCreationTokens || 0;
      const cacheReadTokens = m.cacheReadTokens || 0;
      return {
        modelName: m.modelName,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
        cost: costDollars(m.cost),
        source,
      };
    });
    return { date: day.date, modelBreakdowns };
  });
}

// agentsview's syncing pass (no --no-sync) runs its full parser registry,
// including a Warp parser that reads Warp's sqlite from a macOS App Group
// Container (~/Library/Group Containers/2BBY89MBSN.dev.warp/.../warp.sqlite).
// An unattended launchd/systemd daemon has no Full Disk Access, so that
// open() *blocks* (rather than failing fast) until the timeout, killing the
// run before it can POST. This reporter does not collect Warp usage through
// AgentsView, so syncing calls point WARP_DIR at an always-empty dir: the
// parser finds no warp.sqlite there and skips Warp. --no-sync passes don't run
// the parser, so they're untouched.
// Living on the query (not the OS-unit env) means existing installs get the
// fix on a plain `npm install` rebuild, with no daemon-unit regeneration.
const WARP_SKIP_DIR = "/var/empty";

function queryAgent(
  bin: string,
  since: string,
  agent: string,
  noSync: boolean,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): DailyUsage[] {
  const args = ["usage", "daily", "--json", "--breakdown", "--agent", agent, "--since", since];
  if (noSync) args.push("--no-sync");
  const execOpts: Parameters<typeof execFileSync>[2] = { encoding: "utf-8", timeout: timeoutMs };
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (!noSync) env.WARP_DIR = WARP_SKIP_DIR;
  execOpts.env = env;
  let raw: string;
  try {
    raw = execFileSync(bin, args, execOpts) as string;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() || "";
    const detail = stderr ? `: ${stderr}` : `: ${errMessage(err)}`;
    throw new Error(`agentsview ${agent} query failed${detail}`);
  }
  return parseAgentsviewOutput(JSON.parse(raw), agent);
}

// Sync explicitly before discovery, not as a side effect of the first query:
// discoverAgents reads the index, so an agent whose first session landed since
// the last sync has to be written before we look. agentsview's syncAllLocked
// (internal/sync/engine.go) iterates parser.Registry in one pass, so this
// covers every agent and the per-agent queries then all pass --no-sync.
export function collectAgentsviewUsage(
  bin: string,
  sinceStr: string,
  timeoutMs: number = 180000,
): AgentsviewUsageByAgent {
  try {
    execFileSync(bin, ["sync"], {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env, WARP_DIR: WARP_SKIP_DIR },
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() || "";
    throw new Error(`agentsview sync failed${stderr ? `: ${stderr}` : `: ${errMessage(err)}`}`);
  }

  const since = toIsoDate(sinceStr);
  const usageByAgent: AgentsviewUsageByAgent = {};
  for (const agent of discoverAgents()) {
    usageByAgent[agent] = queryAgent(bin, since, agent, true, timeoutMs);
  }
  return usageByAgent;
}

// Single-agent collection against an isolated agentsview data dir. Used for
// EXTRA_{CLAUDE,CODEX,PI,OPENCODE}_CONFIGS extra homes that live outside the
// local scan — Claude projects, Codex sessions, Pi root data dirs, and OpenCode
// root data dirs — so per-home incremental sync can't contaminate the local
// machine's ~/.agentsview/sessions.db. The caller passes the home's data dir
// and source dir via env (AGENT_VIEWER_DATA_DIR + CLAUDE_PROJECTS_DIR /
// CODEX_SESSIONS_DIR / PIEBALD_DIR / OPENCODE_DIR).
export function collectAgentsviewAgentOnly(bin: string, sinceStr: string, agent: string, env: Record<string, string>, timeoutMs: number = 180000): DailyUsage[] {
  const since = toIsoDate(sinceStr);
  return queryAgent(bin, since, agent, false, timeoutMs, env);
}
