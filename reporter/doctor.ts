import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import {
  stableNodePath,
  launchdPlistPath,
  systemdServicePath,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT_BASENAME,
} from "./install";
import { loadState } from "./reporting-state";
import { errMessage } from "./errors";

// Why this file exists: REVIEW.md already promises the report path fails fast
// on config and credential errors, and a reporter still went quiet without
// anyone noticing. The gap is everything AFTER the daemon dies — a launchd unit
// pointing at a node binary `brew upgrade` deleted produces no report, no
// error, and no signal on either side. Nothing here inspects the report path;
// it inspects whether the report path is still being RUN.

// 48h rather than a single missed 2h cycle: the unit runs every 2 hours, and a
// laptop that was shut for a long weekend must not be indicted as broken. Two
// days of silence from a machine claiming an installed reporter is not idleness.
export const STALE_AFTER_HOURS = 48;

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DiagnoseInput {
  platform: NodeJS.Platform;
  unitInstalled: boolean;
  /** node path baked into the installed unit; null when there is no unit. */
  unitNodePath: string | null;
  nodePathExists: boolean;
  /** null when the platform could not be asked (probe failed / unsupported). */
  unitScheduled: boolean | null;
  lastSuccessAt: string | null;
  nowMs: number;
  staleAfterHours: number;
}

export interface Diagnosis {
  healthy: boolean;
  checks: Check[];
}

const INSTALL_HINT = "run `npm run install-service` to (re)install it";

// Pure: every fact it judges arrives in the input, so the interesting failures
// — a vanished binary, a two-day silence — are reachable in a test without
// installing a service or waiting two days.
export function diagnose(input: DiagnoseInput): Diagnosis {
  const checks: Check[] = [];

  if (!input.unitInstalled) {
    checks.push({
      name: "service-installed",
      status: "fail",
      detail: `no reporter service is installed on this machine — ${INSTALL_HINT}`,
    });
    // Deliberately no node-binary / service-scheduled checks here: with no unit
    // there is nothing to point at a binary or to schedule, and reporting them
    // as failures would blame three things for one cause.
  } else {
    checks.push({ name: "service-installed", status: "ok", detail: "reporter service is installed" });
    checks.push(nodeBinaryCheck(input));
    checks.push(scheduledCheck(input));
  }

  checks.push(lastSuccessCheck(input));

  return { healthy: checks.every((c) => c.status !== "fail"), checks };
}

function nodeBinaryCheck(input: DiagnoseInput): Check {
  const p = input.unitNodePath;
  if (!p) {
    return {
      name: "node-binary",
      status: "warn",
      detail: "could not read the node path out of the installed unit",
    };
  }
  if (input.nodePathExists) {
    return { name: "node-binary", status: "ok", detail: `service runs ${p}` };
  }

  // stableNodePath is the same rewrite install.ts applies, so when it changes
  // the path we know this unit predates that fix and reinstalling cures it.
  const stable = stableNodePath(p);
  const remedy =
    stable !== p
      ? `${stable} is the upgrade-proof path for it — ${INSTALL_HINT}`
      : INSTALL_HINT;
  return {
    name: "node-binary",
    status: "fail",
    detail: `the node binary this service points at no longer exists: ${p} — ${remedy}`,
  };
}

function scheduledCheck(input: DiagnoseInput): Check {
  if (input.unitScheduled === null) {
    return {
      name: "service-scheduled",
      status: "warn",
      detail: "could not determine whether the reporter is scheduled on this platform",
    };
  }
  if (input.unitScheduled) {
    return { name: "service-scheduled", status: "ok", detail: "reporter is loaded and scheduled" };
  }
  const what = input.platform === "darwin" ? `${LAUNCHD_LABEL} is not loaded` : `${SYSTEMD_UNIT_BASENAME}.timer is not active`;
  return {
    name: "service-scheduled",
    status: "fail",
    detail: `${what} — the unit file exists but nothing will run it; ${INSTALL_HINT}`,
  };
}

function lastSuccessCheck(input: DiagnoseInput): Check {
  const parsed = input.lastSuccessAt === null ? NaN : Date.parse(input.lastSuccessAt);
  if (Number.isNaN(parsed)) {
    // warn, not fail: "never succeeded" is indistinguishable from "installed a
    // minute ago". launchd's RunAtLoad fires a cycle the instant the unit is
    // installed, before any success can have been stamped — failing here would
    // print BROKEN into the log of a reporter that is working, and would put
    // healthy:false on the very POST that proves it works, handing the
    // server-side gone-quiet list a false positive for every new builder.
    // A genuinely dead reporter is still caught: by the unit checks above, and
    // by the staleness branch below once it has ever worked.
    return {
      name: "last-success",
      status: "warn",
      detail: "this machine has not yet had a report accepted by the server — expected on a fresh install, otherwise the first cycle has never completed",
    };
  }

  const ageHours = (input.nowMs - parsed) / 3600_000;
  if (ageHours < 0) {
    // Treated as unknown, not fresh: a clock that jumped would otherwise buy
    // itself permanent silence from this check.
    return {
      name: "last-success",
      status: "warn",
      detail: `last accepted report is dated in the future (${input.lastSuccessAt}) — check this machine's clock`,
    };
  }

  const rounded = Math.round(ageHours);
  if (ageHours > input.staleAfterHours) {
    return {
      name: "last-success",
      status: "fail",
      detail: `last accepted report was ${rounded}h ago, over the ${input.staleAfterHours}h threshold — your Builder Index data is going stale`,
    };
  }
  return { name: "last-success", status: "ok", detail: `last accepted report was ${rounded}h ago` };
}

export function formatDiagnosis(d: Diagnosis): string {
  const lines = d.checks.map((c) => `  [${c.status.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}`);
  const header = d.healthy
    ? "Reporter health: OK"
    : "Reporter health: BROKEN — this machine is not reporting, and nothing else will tell you";
  return [header, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Impure probes. Kept thin and below the pure core on purpose.
// ---------------------------------------------------------------------------

// The plist and systemd unit are written by buildLaunchdPlist /
// buildSystemdService; these read the node path back out of them.
export function nodePathFromPlist(xml: string): string | null {
  const args = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const first = args?.[1].match(/<string>([^<]*)<\/string>/);
  return first?.[1] ?? null;
}

export function nodePathFromSystemdUnit(text: string): string | null {
  const exec = text.match(/^ExecStart=(\S+)/m);
  return exec?.[1] ?? null;
}

function probeScheduled(platform: NodeJS.Platform): boolean | null {
  try {
    if (platform === "darwin") {
      execFileSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "ignore" });
      return true;
    }
    if (platform === "linux") {
      const out = execFileSync("systemctl", ["--user", "is-active", `${SYSTEMD_UNIT_BASENAME}.timer`], { encoding: "utf-8" });
      return out.trim() === "active";
    }
    return null;
  } catch {
    // Both commands exit non-zero for "not loaded"/"inactive", which is the
    // answer we want rather than an error.
    return false;
  }
}

export function collectInput(nowMs: number, statePath: string): DiagnoseInput {
  const platform = os.platform();
  const home = os.homedir();

  let unitInstalled = false;
  let unitNodePath: string | null = null;

  const unitPath = platform === "darwin" ? launchdPlistPath(home) : systemdServicePath(home);
  try {
    const raw = fs.readFileSync(unitPath, "utf-8");
    unitInstalled = true;
    unitNodePath = platform === "darwin" ? nodePathFromPlist(raw) : nodePathFromSystemdUnit(raw);
  } catch {}

  return {
    platform,
    unitInstalled,
    unitNodePath,
    nodePathExists: unitNodePath !== null && fs.existsSync(unitNodePath),
    unitScheduled: unitInstalled ? probeScheduled(platform) : null,
    lastSuccessAt: loadState(statePath).last_success_at,
    nowMs,
    staleAfterHours: STALE_AFTER_HOURS,
  };
}

if (require.main === module) {
  try {
    const statePath = require("node:path").join(__dirname, "..", "..", ".reporting-state.json");
    const d = diagnose(collectInput(Date.now(), statePath));
    console.log(formatDiagnosis(d));
    if (!d.healthy) process.exit(1);
  } catch (err) {
    console.error(`doctor failed to run: ${errMessage(err)}`);
    process.exit(1);
  }
}
