import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import {
  collectAgentsviewUsage,
  collectAgentsviewAgentOnly,
  resolveAgentsview,
  detectAgentsviewVersion,
} from "./agentsview";
import { collectOpenAIUsage } from "./openai";
import { collectOpenclawUsage, discoverOpenclawSessionsDirs } from "./openclaw";
import { mergeDailyUsage, type DailyUsage } from "./merge";
import { collectClaudeSkills, applyExclusions, dedupeSkills } from "./skills";
import { collectSkillLinks, linksForReportedSkills } from "./skill-links";
import { collectConfigStack } from "./config-stack";
import { collectCursorStats, type CursorStats } from "./cursor";
import { collectSessionStats, type ExtraStatsHome } from "./session-stats";
import { maybeAutoUpdateAgentsview } from "./agentsview-update";
import { loadState, saveState, computeTransitionMarkers, gateOnSnapshotHash } from "./reporting-state";
import { STATS_WINDOW_DAYS, formatSinceStr } from "./window";
import { resolveAvatarUrl } from "./avatar";
import { checkTagDrift, formatTagDrift } from "./tag-drift";
import { buildListUrl } from "./untag";
import { errMessage } from "./errors";

// PROJECT_ROOT is the actual checked-out repo (not dist/). After build, this
// file lives in dist/reporter/report.js — go up two levels to reach the repo.
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const STATE_PATH = path.join(PROJECT_ROOT, ".reporting-state.json");
const AGENTSVIEW_UPDATE_STAMP = path.join(PROJECT_ROOT, ".agentsview-update-check");

import * as dotenv from "dotenv";
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const ENV_FILE = dotenv.config({ path: ENV_PATH }).parsed || {};

import { version as CLIENT_VERSION } from "../package.json";
// USERNAME comes only from TKMX_USERNAME or .env — never the ambient OS
// account name (process.env.USERNAME), which on Windows would silently
// misattribute usage to the logged-in account. Missing config fails the
// startup guard below rather than posting to the wrong profile.
const USERNAME = process.env.TKMX_USERNAME || ENV_FILE.USERNAME;
const SERVER_URL = process.env.SERVER_URL || "https://tokenmaxxing.odio.dev";
const TEAM = process.env.TEAM || "default";
const API_KEY = process.env.API_KEY;
// The profile-prose set, declared once. Everything that has to agree on which
// fields these are — what gets posted, which nudges fire, and the multi-machine
// hint — is driven from this array, so "did I cover all of them?" stops being a
// question you answer by reading several lists and hoping they match.
//
// Each key's env name is DERIVED, not paired alongside it — every one of these
// is just the key uppercased — so there is no second list of names to keep in
// step and no way for a row to read one field's env var under another's key.
// Values are trimmed, so a key left blank in .env (how .env.example ships every
// one of them) reads as "not configured" for the payload and the nudge alike,
// rather than as an empty value worth posting.
//
// hn_username's nudge is null because it has its own two-branch message below
// (set vs. unset); it still belongs here for the payload and the hint.
const PROFILE_NUDGES = {
  tools: "which AI tools you use daily (e.g. superpowers,paperclip)",
  projects: "what you're spending tokens on (e.g. tkmx,plow.co)",
  communities: "which dev communities you're part of",
  about: "a short description for your profile page",
  demo_video_url: "a 3-min demo of your AI workflow",
  hn_username: null,
} as const;
type ProfileKey = keyof typeof PROFILE_NUDGES;
const PROFILE_FIELDS = Object.entries(PROFILE_NUDGES).map(([key, nudge]) => {
  const env = key.toUpperCase();
  return { key: key as ProfileKey, env, nudge, value: (process.env[env] || "").trim() };
});

// The one field also read outside the array, for its set/unset nudge pair.
const HN_USERNAME = PROFILE_FIELDS.find((f) => f.key === "hn_username")!.value;


// Trimmed on read so the nudge below and resolveAvatarUrl (which trims) agree
// on what "not configured" means — AVATAR="   " would otherwise send nothing
// while also suppressing the nudge telling you it sent nothing.
const AVATAR = (process.env.AVATAR || "").trim();
const EXTRA_CLAUDE_CONFIGS = process.env.EXTRA_CLAUDE_CONFIGS || "";
const EXTRA_CODEX_CONFIGS = process.env.EXTRA_CODEX_CONFIGS || "";
const EXTRA_PI_CONFIGS = process.env.EXTRA_PI_CONFIGS || "";
const EXTRA_OPENCODE_CONFIGS = process.env.EXTRA_OPENCODE_CONFIGS || "";

if (!USERNAME || !API_KEY) {
  console.error("USERNAME and API_KEY must be set in .env");
  process.exit(1);
}

// Resolved at startup, alongside the USERNAME/API_KEY guard above, so a typo'd
// AVATAR fails the run loudly rather than being quietly dropped. Nothing is
// lost by aborting: `data` covers the last REPORT_DAYS (28 by default), so the
// next run after the fix re-sends the same window. Resolved at the top of
// main() rather than here so a bad value reaches the `Fatal:` handler and the
// operator gets the message instead of a module-load stack trace.

function readMachineId(): string | null {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } else if (process.platform === "linux") {
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        if (fs.existsSync(p)) {
          const id = fs.readFileSync(p, "utf8").trim();
          if (id) return id;
        }
      }
    } else if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8" });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

function deriveClientId(username: string): string {
  const machineId = readMachineId();
  if (!machineId) return crypto.randomUUID();
  return crypto.createHash("sha256").update(machineId + "|" + username).digest("hex").slice(0, 32);
}

let CLIENT_ID = process.env.CLIENT_ID;
if (!CLIENT_ID) {
  CLIENT_ID = deriveClientId(USERNAME);
  fs.appendFileSync(ENV_PATH, `CLIENT_ID=${CLIENT_ID}\n`);
  console.log(`Generated CLIENT_ID=${CLIENT_ID}`);
}

function parseExtraConfigs(raw: string): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function agentsviewDataDirFor(absConfigDir: string): string {
  const hash = crypto.createHash("sha256").update(absConfigDir).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".agentsview-tkmx", hash);
}

// The same extra homes the usage path collects, resolved to the isolated data
// dirs collectExtraAgentsviewHomes already synced, for session_stats to RE-READ.
//
// Why this exists: EXTRA_CLAUDE_CONFIGS used to reach the token totals only.
// collectSessionStats took no data-dir argument, so every stats panel
// (subagents/session, plan mode, tool mix) silently described just the default
// ~/.claude home while the operator had explicitly configured more. Tokens
// counted the extra home; the panels did not — a blind spot that looked
// authoritative. Deriving both from parseExtraConfigs + agentsviewDataDirFor
// keeps them from drifting apart again.
//
// Only dirs that already exist are returned: they are created and synced
// earlier in the same run by collectExtraAgentsviewHomes, so a missing one
// means that home was not collected and there is nothing to read. Nothing here
// syncs — see ExtraStatsHome.
function extraStatsHomes(raw: string): ExtraStatsHome[] {
  const homes: ExtraStatsHome[] = [];
  for (const entry of parseExtraConfigs(raw)) {
    const absEntry = path.resolve(entry);
    const dataDir = agentsviewDataDirFor(absEntry);
    if (!fs.existsSync(dataDir)) continue;
    homes.push({ name: path.basename(absEntry) || absEntry, dataDir });
  }
  return homes;
}

// Collect usage from extra AgentsView-backed homes beyond the local scan:
// Claude projects, Codex sessions, Pi root data dirs, and OpenCode root data
// dirs. Each entry is validated against the descriptor's expected directory,
// synced into an isolated data dir (so it can't contaminate the local
// sessions.db), and returned for the caller to fold into the matching source.
// A configured home that can't be collected — missing expected directory, or any
// agentsview failure — is fatal: the operator listed it, so the run aborts
// rather than POST a silently partial total as success (the original cause of
// weeks of unreported usage).
function collectExtraAgentsviewHomes(
  bin: string,
  sinceStr: string,
  raw: string,
  opts: { agent: string; subdir: string; subdirEnvKey: string },
): DailyUsage[] {
  let daily: DailyUsage[] = [];
  for (const entry of parseExtraConfigs(raw)) {
    const absEntry = path.resolve(entry);
    const name = path.basename(absEntry) || absEntry;
    const subdirPath = opts.subdir === "." ? absEntry : path.join(absEntry, opts.subdir);
    const expectedPathLabel = opts.subdir === "." ? "directory" : `${opts.subdir}/ subdir`;
    if (!fs.existsSync(subdirPath)) {
      throw new Error(`${opts.agent} (${name}) missing ${expectedPathLabel} at ${absEntry} — a configured EXTRA_${opts.agent.toUpperCase()}_CONFIGS home must be a valid ${opts.agent} home`);
    }
    const dataDir = agentsviewDataDirFor(absEntry);
    fs.mkdirSync(dataDir, { recursive: true });
    let homeDaily: DailyUsage[];
    try {
      homeDaily = collectAgentsviewAgentOnly(bin, sinceStr, opts.agent, {
        AGENT_VIEWER_DATA_DIR: dataDir,
        [opts.subdirEnvKey]: subdirPath,
      });
    } catch (err) {
      throw new Error(`${opts.agent} (${name}) usage collection failed: ${errMessage(err)}`);
    }
    console.log(`  ${opts.agent} (${name}): ${homeDaily.length} days`);
    daily = daily.concat(homeDaily);
  }
  return daily;
}

interface MachineConfig {
  hostname: string;
  os: string;
  cpu: string;
  memory_gb: number;
  codex_version?: string;
  claude_skills?: string[];
  // Canonical public URL per skill name, for the subset that has one. Sent
  // alongside claude_skills rather than folded into it, so a server that does
  // not know about links keeps rendering the same chips it always has.
  claude_skill_links?: Record<string, string>;
  [key: string]: unknown;
}

// Returned instead of a bare config so the caller can record delivery only once
// the POST carrying it has succeeded.
interface PendingMachineConfig {
  config: MachineConfig;
  commit: () => void;
}

function collectMachineConfig(): PendingMachineConfig | null {
  if (process.env.REPORT_MACHINE_CONFIG !== "true") return null;

  const cfg: MachineConfig = { hostname: os.hostname(), os: os.platform() + " " + os.release(), cpu: "", memory_gb: Math.round(os.totalmem() / 1e9) };
  const cpus = os.cpus();
  if (cpus.length > 0) {
    // Some virtualized kernels (e.g. Docker Desktop's linuxkit on Apple Silicon,
    // many ARM guests) report os.cpus()[0].model as the literal string "unknown"
    // or empty. The profile "Machines" card renders the cpu field as the machine's
    // primary label, so such nodes show up as "unknown (N cores)" with no way to
    // tell them apart. Fall back to the hostname so the machine stays identifiable.
    const model = cpus[0].model.trim();
    const label = model && model.toLowerCase() !== "unknown" ? model : os.hostname();
    cfg.cpu = label + " (" + cpus.length + " cores)";
  }
  try { cfg.codex_version = execFileSync("codex", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim(); } catch {}
  // MCP servers are a capability the profile has no row of its own for, so they
  // join the skills list rather than being collected and then never surfaced.
  // Each source is filtered once, then merged, so a name is dropped no matter
  // which source produced it.
  const configStack = collectConfigStack();
  const mcpServers = applyExclusions(configStack.mcp_servers || [], process.env.SKILLS_EXCLUDE);
  if (mcpServers.length > 0) configStack.mcp_servers = mcpServers;
  else delete configStack.mcp_servers;

  const skills = dedupeSkills([
    ...applyExclusions(collectClaudeSkills(), process.env.SKILLS_EXCLUDE),
    ...mcpServers,
  ]);
  if (skills.length > 0) cfg.claude_skills = skills;

  // Where each skill actually lives, for the ones we can answer for. The
  // profile renders skills as inert text because a bare name is all it has;
  // this is the missing half. Only plugin-sourced names resolve — a personal
  // skill or an MCP server has no upstream to point at, and is left out so the
  // page can mark it unlinkable instead of linking it somewhere wrong.
  const skillLinks = linksForReportedSkills(collectSkillLinks(), skills);
  if (Object.keys(skillLinks).length > 0) cfg.claude_skill_links = skillLinks;

  Object.assign(cfg, configStack);
  // The gate keeps "changed" and "delivered" separate; commit() runs only once
  // the POST carrying this snapshot has succeeded, as saveState below already does.
  const gate = gateOnSnapshotHash(cfg, path.join(PROJECT_ROOT, ".machine_config_hash"));
  if (!gate) return null;
  console.log("  Machine config changed, will report");
  return { config: cfg, commit: gate.commit };
}

interface ServerResponse {
  client_update?: string;
  agentsview_update?: string;
  profile_frozen?: boolean;
}

// Plain GET used by the badge check below. Kept separate from postUsage: it
// carries no credentials, reads a public profile, and must never take the whole
// cycle down, so it has its own timeout and resolves whatever it got.
function httpGet(url: URL, timeoutMs = 10000): Promise<{ status: number; body: string }> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

// Hey, you found the API call. Yes, you can post whatever you want — any tool,
// any numbers. This is a trust-based system. We don't have server-side validation
// that cross-checks your local usage logs because there's no way to do that without
// making the client invasive. We're running an experiment to see if a community of
// devs can self-report honestly and learn from each other's setups. Please don't
// pee in the punchbowl. If you want to add support for a new tool, we'd love a PR:
// https://github.com/srosro/tkmx-client
function postUsage(payload: string): Promise<ServerResponse> {
  const url = new URL("/api/usage", SERVER_URL);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Authorization": `Bearer ${API_KEY}`,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          console.log(`[${new Date().toISOString()}] Server responded ${res.statusCode}: ${body}`);
          if (res.statusCode !== 200) {
            reject(new Error(`Server returned ${res.statusCode}: ${body}`));
            return;
          }
          let parsed: ServerResponse = {};
          try { parsed = JSON.parse(body); } catch {}
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

interface ReportBody {
  username: string;
  team: string;
  // Optional: a profile-prose key this machine hasn't configured is left out
  // of the POST entirely rather than sent as "". See where `body` is built.
  tools?: string;
  communities?: string;
  projects?: string;
  about?: string;
  hn_username?: string;
  demo_video_url?: string;
  // Omitted when AVATAR is unset, so a client that doesn't set one never
  // clears an avatar configured elsewhere.
  avatar_url?: string;
  client_id: string;
  client_version: string;
  report_days: number;
  data: DailyUsage[];
  agentsview_version?: string;
  machine_config?: MachineConfig;
  cursor_stats?: CursorStats;
  session_stats?: Record<string, unknown> | null;
  clear_dev_stats?: boolean;
}

async function main(): Promise<void> {
  const AVATAR_URL = resolveAvatarUrl(AVATAR);
  const REPORT_DAYS = parseInt(process.env.REPORT_DAYS || "", 10) || 28;
  // Two date windows: `sinceStr` bounds `body.data` (daily usage rows,
  // merged per-date by the server — short windows safe), `statsSinceStr`
  // bounds `body.session_stats` and `body.cursor_stats` (wholesale-
  // replaced blobs — short windows scrub history). See reporter/window.ts.
  const sinceStr = formatSinceStr(REPORT_DAYS);
  const statsSinceStr = formatSinceStr(STATS_WINDOW_DAYS);

  console.log(`[${new Date().toISOString()}] Collecting ${REPORT_DAYS}d usage since ${sinceStr} for ${USERNAME} (team: ${TEAM})`);

  const agentsviewBin = resolveAgentsview();
  if (!agentsviewBin) {
    console.error("");
    console.error("agentsview not found.");
    console.error("");
    console.error("tkmx-client v1.3.0 requires agentsview for local token usage collection.");
    console.error("");
    console.error("Install (macOS / Linux):");
    console.error("  curl -fsSL https://agentsview.io/install.sh | bash");
    console.error("");
    console.error("Windows:");
    console.error("  powershell -ExecutionPolicy ByPass -c \"irm https://agentsview.io/install.ps1 | iex\"");
    console.error("");
    console.error("Custom install location? Set AGENTSVIEW_BIN=/path/to/agentsview");
    console.error("More: https://agentsview.io/quickstart/");
    console.error("");
    console.error("Prefer the previous ccusage-based flow? Pin to v1.2.0:");
    console.error("  cd tkmx-client && git checkout v1.2.0 && npm install");
    console.error("");
    process.exit(1);
  }
  console.log(`  Using agentsview at ${agentsviewBin}`);

  // Keep agentsview current (throttled to once/day, best-effort, opt-out via
  // AGENTSVIEW_AUTO_UPDATE=false). Runs before the version is reported and the
  // data collected so this run already reflects any new binary.
  maybeAutoUpdateAgentsview(agentsviewBin, AGENTSVIEW_UPDATE_STAMP, { nowMs: Date.now() });

  const agentsviewVersion = detectAgentsviewVersion(agentsviewBin);
  if (agentsviewVersion) console.log(`  agentsview version: ${agentsviewVersion}`);

  const localAgentsviewDaily = collectAgentsviewUsage(agentsviewBin, sinceStr);

  // The EXTRA_*_CONFIGS names stay a fixed map because they're a documented
  // .env contract with per-agent home layouts, not a list of what's
  // collectable — an agent discovered in the index simply has no extras.
  const EXTRA_HOMES: Record<string, { raw: string; subdir: string; subdirEnvKey: string }> = {
    claude: { raw: EXTRA_CLAUDE_CONFIGS, subdir: "projects", subdirEnvKey: "CLAUDE_PROJECTS_DIR" },
    codex: { raw: EXTRA_CODEX_CONFIGS, subdir: "sessions", subdirEnvKey: "CODEX_SESSIONS_DIR" },
    pi: { raw: EXTRA_PI_CONFIGS, subdir: ".", subdirEnvKey: "PIEBALD_DIR" },
    opencode: { raw: EXTRA_OPENCODE_CONFIGS, subdir: ".", subdirEnvKey: "OPENCODE_DIR" },
  };

  // Union so a configured extra home is still collected when that agent has no
  // local sessions to be discovered from.
  const agents = [...new Set([
    ...Object.keys(localAgentsviewDaily),
    ...Object.keys(EXTRA_HOMES).filter((a) => EXTRA_HOMES[a].raw),
  ])].sort();
  for (const agent of agents) {
    console.log(`  ${agent} (local): ${(localAgentsviewDaily[agent] || []).length} days`);
  }

  // Extra homes outside the local scan are folded into their matching
  // AgentsView-backed source so mergeDailyUsage sums same-(date,model,source)
  // rows before POST (see merge.ts for the canonical dedup/summing contract)
  // rather than letting them collide on the server upsert.
  const agentsviewDaily = agents.map((agent) => {
    const local = localAgentsviewDaily[agent] || [];
    const extra = EXTRA_HOMES[agent];
    if (!extra) return local;
    return local.concat(collectExtraAgentsviewHomes(agentsviewBin, sinceStr, extra.raw, { agent, ...extra }));
  });

  const openaiDaily = await collectOpenAIUsage(sinceStr);
  if (openaiDaily.length > 0) {
    console.log(`  OpenAI platform: ${openaiDaily.length} days`);
  }

  const openclawDirs = await discoverOpenclawSessionsDirs({
    env: process.env,
    homeDir: os.homedir(),
    platform: process.platform,
  });
  const openclawDaily = await collectOpenclawUsage({
    sinceDateStr: sinceStr,
    sessionsDirs: openclawDirs,
  });
  // Printed unconditionally: this line was suppressed at zero roots, which is
  // the only time its absence is interesting. `0 root(s)` on a machine you know
  // runs Plow is the whole signal — Plow's sessions path moved once already and
  // read as "no Plow here" for weeks, because nothing said otherwise.
  console.log(`  OpenClaw: ${openclawDaily.length} days from ${openclawDirs.length} root(s)`);

  const mergedDaily = mergeDailyUsage(...agentsviewDaily, openaiDaily, openclawDaily);

  if (mergedDaily.length === 0) {
    // Previously we returned here, skipping session_stats / cursor_stats
    // collection, transition markers, and the POST itself. That meant an
    // inactive REPORT_DAYS=1 day would fail to refresh the rolling-window
    // blobs — natural 28-day expiry of, say, Cursor usage would never
    // take effect, and an on→off toggle of REPORT_DEV_STATS would miss
    // its one-shot clear. Fall through so the server still sees us: an
    // empty `data:[]` is valid per /api/usage and lets the wholesale-
    // replaced blobs decay on schedule.
    console.log("  No new token-usage rows in window; posting empty data[] to refresh rolling-window blobs.");
  }

  const body: ReportBody = {
    username: USERNAME as string,
    team: TEAM,
    client_id: CLIENT_ID as string,
    client_version: CLIENT_VERSION,
    report_days: REPORT_DAYS,
    data: mergedDaily,
  };

  // Profile prose comes from THIS machine's .env, but the profile it lands on is
  // shared by every machine reporting under this username. Sending "" for a field
  // nobody on this machine has configured is at best meaningless and at worst
  // destructive, so send nothing at all.
  //
  // What the server does with what it receives isn't knowable from here — `tools`
  // is known to merge rather than replace, and the scalar fields are unverified —
  // which is exactly why this side declines to guess. Omitting an unconfigured
  // field is the only behaviour that's correct under either semantics.
  for (const f of PROFILE_FIELDS) {
    if (f.value) body[f.key] = f.value;
  }
  if (AVATAR_URL) body.avatar_url = AVATAR_URL;
  if (agentsviewVersion) body.agentsview_version = agentsviewVersion;
  const machineConfig = collectMachineConfig();
  if (machineConfig) body.machine_config = machineConfig.config;

  const priorState = loadState(STATE_PATH);
  const currentState = {
    dev_stats_on:     process.env.REPORT_DEV_STATS === "true",
    session_stats_on: process.env.REPORT_SESSION_STATS !== "false"
                      && process.env.REPORT_DEV_STATS === "true",
  };

  if (currentState.dev_stats_on) {
    console.log("  Collecting dev stats...");

    const cursorStats = collectCursorStats(statsSinceStr);
    if (cursorStats) {
      body.cursor_stats = cursorStats;
      console.log(`  Cursor: ${cursorStats.scored_commits || 0} scored commits`);
    }

    if (currentState.session_stats_on) {
      console.log("  Collecting session stats (agentsview)...");
      const statsHomes = extraStatsHomes(EXTRA_CLAUDE_CONFIGS);
      if (statsHomes.length > 0) {
        console.log(`  Session stats: folding in ${statsHomes.length} extra Claude home(s)`);
      }
      const ss = collectSessionStats({ sinceDays: STATS_WINDOW_DAYS, extraHomes: statsHomes });
      if (ss) {
        body.session_stats = ss;
        console.log(`  Session stats: ${ss.totals?.sessions_all ?? "?"} sessions, schema v${ss.schema_version}`);
      }
    }
  }

  const markers = computeTransitionMarkers(priorState, currentState);
  if (markers.clear_dev_stats) body.clear_dev_stats = true;
  if ("session_stats" in markers) body.session_stats = null;

  // Badge lists are unioned server-side, so any name this machine has that the
  // profile doesn't becomes a permanent chip. Say so before sending rather than
  // after: thirteen duplicates reached one profile because nothing ever did.
  // A report is never held up for this — the check reports or says it couldn't.
  const tagCheck = await checkTagDrift(
    { tools: body.tools, projects: body.projects, communities: body.communities },
    async () => {
      const url = buildListUrl(SERVER_URL, USERNAME as string, Date.now());
      const { body: profile } = await httpGet(url);
      return profile;
    },
  );
  if (tagCheck.skipped) {
    console.error(`  Badge check skipped — ${tagCheck.skipped}`);
  } else {
    for (const line of formatTagDrift(tagCheck.drifts)) console.error(line);
  }

  const response = await postUsage(JSON.stringify(body));
  // A frozen profile answers 200 but stays on its last snapshot, so nothing we
  // just sent was applied. Both writes below record "the server has this now",
  // so both wait on the same condition: the config hash, and the reporting state
  // whose transition markers are one-shot — clear_dev_stats and session_stats
  // fire only on the local prior→current edge, so persisting that edge against a
  // server that ignored it consumes the signal for good, leaving stale stats
  // until some later toggle happens to re-trigger it.
  //
  // The server's exact freeze semantics are not visible from here. The asymmetry
  // settles it: gating costs a redundant resend each cycle until the profile
  // unfreezes, while not gating costs data the server never receives and nothing
  // reports as missing.
  if (!response?.profile_frozen) {
    machineConfig?.commit();
    saveState(STATE_PATH, currentState);
  }

  // Human-facing profile lives on the Builder Index (aiworthusing), not the API host (SERVER_URL).
  const profileUrl = `https://aiworthusing.com/builder-index/u/${USERNAME}`;
  console.log(`  Profile: ${profileUrl}`);

  for (const f of PROFILE_FIELDS) {
    if (!f.value && f.nudge) console.log(`  Set ${f.env} in .env — ${f.nudge}`);
  }
  if (!AVATAR) console.log(`  Set AVATAR in .env — a picture for your profile (https://…, gravatar:you@example.com, or github:yourhandle) — not active yet, needs server support`);
  if (!HN_USERNAME) {
    console.log(`  Set HN_USERNAME in .env to appear on the Builder Index`);
  } else {
    console.log(`  Verify your HN account on your Builder Index profile (${profileUrl}) to appear on the Builder Index`);
  }

  // Printed after every nudge and covering the whole set, because all of these
  // are omitted when blank. Without it the nudges contradict .env.example, which
  // tells a multi-machine operator to leave them blank on every machine but one
  // — and then this machine nags them to fill them in every two hours, forever.
  //
  // AVATAR is in the condition but not in PROFILE_FIELDS: it isn't profile prose
  // and has its own resolver, but it is omitted-when-unset in exactly the same
  // way, so a machine that keeps its picture elsewhere needs the same reassurance.
  if (PROFILE_FIELDS.some((f) => !f.value) || !AVATAR) {
    console.log(`  (Reporting from more than one machine? Set the fields above on one machine only — blank here means "leave my profile alone".)`);
  }

  if (response && response.client_update) {
    const bar = "=".repeat(72);
    console.log(`\n${bar}\n⚠️  CLIENT UPDATE AVAILABLE\n${bar}\n${response.client_update}\n${bar}`);
  }
  if (response && response.agentsview_update) {
    const bar = "=".repeat(72);
    console.log(`\n${bar}\n⚠️  AGENTSVIEW UPDATE REQUIRED\n${bar}\n${response.agentsview_update}\n${bar}`);
  }
  if (response && response.profile_frozen) {
    console.log(`  Your profile will stay on its last snapshot until you update.`);
  }
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] Fatal:`, errMessage(err));
  process.exit(1);
});
