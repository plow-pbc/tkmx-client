import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");

interface ClaudeSettings {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  effortLevel?: string;
}

function readJsonSafe<T = ClaudeSettings>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T; } catch { return null; }
}

function countLines(filePath: string): number {
  try { return fs.readFileSync(filePath, "utf-8").split("\n").length; } catch { return 0; }
}

// MCP server names from settings.json (names only, never credentials)
export function collectMcpServers(): string[] {
  const settings = readJsonSafe(SETTINGS_PATH);
  if (!settings) return [];
  const servers = settings.mcpServers || {};
  return Object.keys(servers).sort();
}

// Hook event types and count from settings.json
export function collectHooks(): { events: string[]; count: number } {
  const settings = readJsonSafe(SETTINGS_PATH);
  if (!settings) return { events: [], count: 0 };
  const hooks = settings.hooks || {};
  const events = Object.keys(hooks).sort();
  let count = 0;
  for (const event of events) {
    const arr = hooks[event];
    count += Array.isArray(arr) ? arr.length : 1;
  }
  return { events, count };
}

// CLAUDE.md presence and LOC at global + project levels
export function collectClaudeMdStats(): { global_loc: number; project_count: number } {
  const globalLoc = countLines(path.join(CLAUDE_DIR, "CLAUDE.md"));
  let projectCount = 0;
  const projectsDir = path.join(CLAUDE_DIR, "projects");
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const claudeMd = path.join(projectsDir, dir, "CLAUDE.md");
      if (fs.existsSync(claudeMd)) projectCount++;
    }
  } catch {}
  return { global_loc: globalLoc, project_count: projectCount };
}

// Effort level from settings
function collectEffortLevel(): string | null {
  const settings = readJsonSafe(SETTINGS_PATH);
  return settings?.effortLevel || null;
}

interface EnvironmentInfo {
  shell?: string;
  terminal?: string;
  multiplexer?: string;
  editor?: string;
}

// Shell, terminal, editor from environment
export function collectEnvironment(): EnvironmentInfo {
  const env: EnvironmentInfo = {};
  env.shell = path.basename(process.env.SHELL || process.env.COMSPEC || "");
  if (process.env.TERM_PROGRAM) env.terminal = process.env.TERM_PROGRAM;
  if (process.env.TMUX) env.multiplexer = "tmux";
  else if (process.env.ZELLIJ) env.multiplexer = "zellij";
  if (process.env.EDITOR) env.editor = path.basename(process.env.EDITOR);
  else if (process.env.VISUAL) env.editor = path.basename(process.env.VISUAL);
  return env;
}

// Count git worktrees across active project dirs
export function collectWorktreeCount(): number {
  const projectsDir = path.join(CLAUDE_DIR, "projects");
  const repoPaths = new Set<string>();
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const repoPath = "/" + dir.replace(/^-/, "").replace(/-/g, "/");
      if (fs.existsSync(path.join(repoPath, ".git"))) repoPaths.add(repoPath);
    }
  } catch {}

  let totalWorktrees = 0;
  for (const repo of repoPaths) {
    try {
      const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repo, encoding: "utf-8", timeout: 5000,
      });
      const count = (out.match(/^worktree /gm) || []).length;
      if (count > 1) totalWorktrees += count;
    } catch {}
  }
  return totalWorktrees;
}

interface ConfigStack {
  mcp_servers?: string[];
  hook_events?: string[];
  hook_count?: number;
  claude_md_global_loc?: number;
  claude_md_project_count?: number;
  effort_level?: string;
  shell?: string;
  terminal?: string;
  multiplexer?: string;
  editor?: string;
  git_worktrees?: number;
}

// Collect all config-stack data into a flat object to merge into machine_config
export function collectConfigStack(): ConfigStack {
  const cfg: ConfigStack = {};

  const mcpServers = collectMcpServers();
  if (mcpServers.length > 0) cfg.mcp_servers = mcpServers;

  const hooks = collectHooks();
  if (hooks.count > 0) {
    cfg.hook_events = hooks.events;
    cfg.hook_count = hooks.count;
  }

  const claudeMd = collectClaudeMdStats();
  if (claudeMd.global_loc > 0) cfg.claude_md_global_loc = claudeMd.global_loc;
  if (claudeMd.project_count > 0) cfg.claude_md_project_count = claudeMd.project_count;

  const effort = collectEffortLevel();
  if (effort) cfg.effort_level = effort;

  const env = collectEnvironment();
  Object.assign(cfg, env);

  const worktrees = collectWorktreeCount();
  if (worktrees > 0) cfg.git_worktrees = worktrees;

  return cfg;
}
