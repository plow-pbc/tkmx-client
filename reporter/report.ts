import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import {
  collectAgentsviewUsage,
  collectAgentsviewClaudeOnly,
  resolveAgentsview,
  detectAgentsviewVersion,
} from "./agentsview";
import { collectOpenAIUsage } from "./openai";
import { mergeDailyUsage, type DailyUsage } from "./merge";
import { collectClaudeSkills } from "./skills";
import { collectConfigStack } from "./config-stack";
import { collectCursorStats, type CursorStats } from "./cursor";
import { collectSessionStats } from "./session-stats";
import { loadState, saveState, computeTransitionMarkers } from "./reporting-state";
import { STATS_WINDOW_DAYS, formatSinceStr } from "./window";
import { errMessage } from "./errors";

// PROJECT_ROOT is the actual checked-out repo (not dist/). After build, this
// file lives in dist/reporter/report.js — go up two levels to reach the repo.
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const STATE_PATH = path.join(PROJECT_ROOT, ".reporting-state.json");

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
const TOOLS = process.env.TOOLS || "";
const COMMUNITIES = process.env.COMMUNITIES || "";
const PROJECTS = process.env.PROJECTS || "";
const ABOUT = process.env.ABOUT || "";
const HN_USERNAME = process.env.HN_USERNAME || "";
const DEMO_VIDEO_URL = process.env.DEMO_VIDEO_URL || "";
const EXTRA_CLAUDE_CONFIGS = process.env.EXTRA_CLAUDE_CONFIGS || "";

if (!USERNAME || !API_KEY) {
  console.error("USERNAME and API_KEY must be set in .env");
  process.exit(1);
}

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

interface MachineConfig {
  hostname: string;
  os: string;
  cpu: string;
  memory_gb: number;
  codex_version?: string;
  claude_skills?: string[];
  [key: string]: unknown;
}

function collectMachineConfig(): MachineConfig | null {
  if (process.env.REPORT_MACHINE_CONFIG !== "true") return null;

  const cfg: MachineConfig = { hostname: os.hostname(), os: os.platform() + " " + os.release(), cpu: "", memory_gb: Math.round(os.totalmem() / 1e9) };
  const cpus = os.cpus();
  if (cpus.length > 0) cfg.cpu = cpus[0].model.trim() + " (" + cpus.length + " cores)";
  try { cfg.codex_version = execFileSync("codex", ["--version"], { encoding: "utf-8", timeout: 5000 }).trim(); } catch {}
  const skills = collectClaudeSkills();
  if (skills.length > 0) cfg.claude_skills = skills;
  Object.assign(cfg, collectConfigStack());
  const cfgJson = JSON.stringify(cfg);
  const cfgHash = crypto.createHash("sha256").update(cfgJson).digest("hex").slice(0, 16);
  const hashFile = path.join(PROJECT_ROOT, ".machine_config_hash");
  const lastHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, "utf-8").trim() : "";
  if (cfgHash !== lastHash) {
    fs.writeFileSync(hashFile, cfgHash);
    console.log("  Machine config changed, will report");
    return cfg;
  }
  return null;
}

interface ServerResponse {
  client_update?: string;
  agentsview_update?: string;
  profile_frozen?: boolean;
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
  tools: string;
  communities: string;
  projects: string;
  about: string;
  hn_username: string;
  demo_video_url: string;
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
  const agentsviewVersion = detectAgentsviewVersion(agentsviewBin);
  if (agentsviewVersion) console.log(`  agentsview version: ${agentsviewVersion}`);

  const { claudeDaily: localClaudeDaily, codexDaily } = collectAgentsviewUsage(agentsviewBin, sinceStr);
  console.log(`  Claude (local): ${localClaudeDaily.length} days`);
  console.log(`  Codex (local): ${codexDaily.length} days`);

  let claudeDaily: DailyUsage[] = [...localClaudeDaily];
  for (const entry of parseExtraConfigs(EXTRA_CLAUDE_CONFIGS)) {
    const absEntry = path.resolve(entry);
    const label = path.basename(absEntry) || absEntry;
    const projectsDir = path.join(absEntry, "projects");
    if (!fs.existsSync(projectsDir)) {
      console.error(`  Claude (${label}) skipped: missing projects/ subdir at ${absEntry}`);
      continue;
    }
    const dataDir = agentsviewDataDirFor(absEntry);
    let remoteDaily: DailyUsage[];
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      remoteDaily = collectAgentsviewClaudeOnly(agentsviewBin, sinceStr, {
        AGENT_VIEWER_DATA_DIR: dataDir,
        CLAUDE_PROJECTS_DIR: projectsDir,
      });
    } catch (err) {
      console.error(`  Claude (${label}) failed: ${errMessage(err)}`);
      continue;
    }
    console.log(`  Claude (${label}): ${remoteDaily.length} days`);
    claudeDaily = claudeDaily.concat(remoteDaily);
  }

  const openaiDaily = await collectOpenAIUsage(sinceStr);
  if (openaiDaily.length > 0) {
    console.log(`  OpenAI platform: ${openaiDaily.length} days`);
  }

  const mergedDaily = mergeDailyUsage(claudeDaily, codexDaily, openaiDaily);

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
    tools: TOOLS,
    communities: COMMUNITIES,
    projects: PROJECTS,
    about: ABOUT,
    hn_username: HN_USERNAME,
    demo_video_url: DEMO_VIDEO_URL,
    client_id: CLIENT_ID as string,
    client_version: CLIENT_VERSION,
    report_days: REPORT_DAYS,
    data: mergedDaily,
  };
  if (agentsviewVersion) body.agentsview_version = agentsviewVersion;
  const machineConfig = collectMachineConfig();
  if (machineConfig) body.machine_config = machineConfig;

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
      const ss = collectSessionStats({ sinceDays: STATS_WINDOW_DAYS });
      if (ss) {
        body.session_stats = ss;
        console.log(`  Session stats: ${ss.totals?.sessions_all ?? "?"} sessions, schema v${ss.schema_version}`);
      }
    }
  }

  const markers = computeTransitionMarkers(priorState, currentState);
  if (markers.clear_dev_stats) body.clear_dev_stats = true;
  if ("session_stats" in markers) body.session_stats = null;

  const response = await postUsage(JSON.stringify(body));
  saveState(STATE_PATH, currentState);

  const profileUrl = `${SERVER_URL}/user/${USERNAME}`;
  console.log(`  Profile: ${profileUrl}`);

  if (!TOOLS) console.log(`  Set TOOLS in .env — which AI tools you use daily (e.g. superpowers,paperclip)`);
  if (!PROJECTS) console.log(`  Set PROJECTS in .env — what you're spending tokens on (e.g. tkmx,plow.co)`);
  if (!COMMUNITIES) console.log(`  Set COMMUNITIES in .env — which dev communities you're part of`);
  if (!ABOUT) console.log(`  Set ABOUT in .env — a short description for your profile page`);
  if (!DEMO_VIDEO_URL) console.log(`  Set DEMO_VIDEO_URL in .env — a 3-min demo of your AI workflow`);

  if (!HN_USERNAME) {
    console.log(`  Set HN_USERNAME in .env to unlock leaderboard visibility`);
  } else {
    console.log(`  Verify your HN account at your profile page to appear on the leaderboard`);
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
