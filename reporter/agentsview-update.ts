import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { errMessage } from "./errors";
import { detectAgentsviewVersion } from "./agentsview";

const DAY_MS = 24 * 60 * 60 * 1000;

// Leave installation ownership with the user unless they opt in. A self-update
// can replace a package-managed or source-built binary with a tagged release.
export function autoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AGENTSVIEW_AUTO_UPDATE ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function readStamp(stampPath: string): number {
  try {
    const n = parseInt(fs.readFileSync(stampPath, "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeStamp(stampPath: string, nowMs: number): void {
  try {
    fs.writeFileSync(stampPath, String(nowMs), "utf-8");
  } catch (err) {
    // A non-writable repo dir shouldn't fail the report; we just lose the
    // throttle and may re-check next run.
    console.error(`  agentsview auto-update: could not record check time (${errMessage(err)})`);
  }
}

export interface AutoUpdateOptions {
  nowMs: number;
  intervalMs?: number;
  timeoutMs?: number;
  // Governs ONLY the AGENTSVIEW_AUTO_UPDATE enabled check (kept injectable
  // for tests). The update subprocess deliberately runs with the real
  // process.env — it needs the actual PATH/HOME to download and swap the
  // binary — so this is not propagated to the child.
  env?: NodeJS.ProcessEnv;
}

// Opt-in, throttled (default once/day) agentsview self-update. Runs
// `agentsview update --yes`, which replaces the resolved binary and may restart
// its daemon. Logs update failures and continues with usage collection.
//
// The check timestamp is written BEFORE the update runs, so a hang that the
// timeout reaps (or a crash) doesn't re-attempt every 2h — it waits a full
// interval before trying again.
//
// Returns true when an update was attempted this run (throttle elapsed and
// auto-update enabled), false when skipped.
export function maybeAutoUpdateAgentsview(
  bin: string,
  stampPath: string,
  opts: AutoUpdateOptions,
): boolean {
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const env = opts.env ?? process.env;

  if (!autoUpdateEnabled(env)) return false;
  if (opts.nowMs - readStamp(stampPath) < intervalMs) return false;

  writeStamp(stampPath, opts.nowMs);

  const before = detectAgentsviewVersion(bin);
  try {
    execFileSync(bin, ["update", "--yes"], {
      encoding: "utf-8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    // Surface the child's stderr (captured via the piped fd) the way
    // queryAgent does — the bare error message is just a generic
    // "Command failed"/timeout string and hides why the update failed.
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() || "";
    const detail = stderr ? `${errMessage(err)}: ${stderr}` : errMessage(err);
    console.error(`  agentsview auto-update skipped (${detail})`);
    return true;
  }
  const after = detectAgentsviewVersion(bin);
  if (after && before && after !== before) {
    console.log(`  agentsview auto-updated: ${before} -> ${after}`);
  } else {
    console.log(`  agentsview up to date (${after ?? "unknown"})`);
  }
  return true;
}
