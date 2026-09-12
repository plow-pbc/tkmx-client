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
import { errMessage } from "./errors";

// Why this file exists: REVIEW.md already promises the report path fails fast
// on config and credential errors, and a reporter still went quiet without
// anyone noticing. The gap is everything AFTER the daemon dies — a launchd unit
// pointing at a node binary `brew upgrade` deleted produces no report, no
// error, and no signal on either side. Nothing here inspects the report path;
// it inspects whether the report path is still being RUN.
//
// Deliberately on-demand only, and deliberately says nothing about "when did
// this last report". A reporter that has stopped cannot run this — or anything
// else — so silence can only be noticed by the side that is still awake: the
// server, from its own last accepted POST. Asking the dead machine to report
// its own death is the one thing this file must not pretend to do.

// install-service installs a unit on darwin and linux and refuses everywhere
// else, so those are the only platforms where "is the unit healthy" is a
// question with an answer.
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

// Pure, and exported, so the refusal is reachable in a test without pretending
// to be Windows. The old code had no such gate: it fell through to the systemd
// path for every non-darwin platform, so on Windows it looked for a unit
// install-service refuses to write, failed to find it, and called a machine
// that never had a reporter broken.
export function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (SUPPORTED_PLATFORMS.includes(platform)) return;
  throw new Error(
    `the reporter service is not supported on ${platform} — \`npm run install-service\` refuses to install here, so there is no unit to diagnose`,
  );
}

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
  /** Only meaningful when unitInstalled: with no unit there is nothing to schedule. */
  unitScheduled: boolean;
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

// Only ever asked about a platform assertSupportedPlatform let through, so
// there is no "cannot tell" answer to represent: either the unit is loaded or
// it is not.
function probeScheduled(platform: NodeJS.Platform): boolean {
  try {
    if (platform === "darwin") {
      execFileSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "ignore" });
      return true;
    }
    if (platform === "linux") {
      const out = execFileSync("systemctl", ["--user", "is-active", `${SYSTEMD_UNIT_BASENAME}.timer`], { encoding: "utf-8" });
      return out.trim() === "active";
    }
    return false;
  } catch {
    // Both commands exit non-zero for "not loaded"/"inactive", which is the
    // answer we want rather than an error.
    return false;
  }
}

export function collectInput(): DiagnoseInput {
  const platform = os.platform();
  assertSupportedPlatform(platform);
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
    unitScheduled: unitInstalled && probeScheduled(platform),
  };
}

if (require.main === module) {
  try {
    const d = diagnose(collectInput());
    console.log(formatDiagnosis(d));
    if (!d.healthy) process.exit(1);
  } catch (err) {
    console.error(`doctor failed to run: ${errMessage(err)}`);
    process.exit(1);
  }
}
