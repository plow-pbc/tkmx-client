import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as os from "node:os";

// PROJECT_ROOT is the actual checked-out repo, not dist/. After build, this
// file lives in dist/reporter/install.js — go up two levels to reach the repo.
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
export const REPORT_SCRIPT = path.join(PROJECT_ROOT, "dist", "reporter", "report.js");
export const LAUNCHD_LABEL = "com.token-tracking.reporter";
export const SYSTEMD_UNIT_BASENAME = "token-tracking-reporter";

export interface LaunchdInstallInputs {
  uid: number;
  label: string;
  plistPath: string;
}

export interface LaunchdCommand {
  file: "/bin/launchctl";
  args: string[];
  tolerateFailure?: boolean;
}

// Pure command plan for the logged-in user's launchd domain. `load` and
// `unload` are legacy compatibility verbs; bootstrap/enable is the supported
// registration path and survives reboot through the plist in LaunchAgents.
// Keeping argv separate from the executable also avoids a shell entirely.
export function buildLaunchdInstallCommands({ uid, label, plistPath }: LaunchdInstallInputs): LaunchdCommand[] {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error("Launchd installation must run as the logged-in user, never root");
  }
  const domain = `gui/${uid}`;
  const service = `${domain}/${label}`;
  return [
    { file: "/bin/launchctl", args: ["bootout", service], tolerateFailure: true },
    { file: "/bin/launchctl", args: ["enable", service] },
    { file: "/bin/launchctl", args: ["bootstrap", domain, plistPath] },
    { file: "/bin/launchctl", args: ["kickstart", "-k", service] },
    { file: "/bin/launchctl", args: ["print", service] },
  ];
}

// `process.execPath` points at the real on-disk node binary, which on Homebrew
// is a versioned Cellar path like `/opt/homebrew/Cellar/node/25.8.1_1/bin/node`.
// Baking that into a launchd plist is a ticking time bomb: the next
// `brew upgrade node` deletes that cellar dir and the service starts failing
// silently with dyld "Library not loaded" errors. Rewrite cellar paths to
// `<prefix>/opt/<formula>/bin/node`, the symlink brew keeps pointing at the
// formula's current keg.
//
// `opt/<formula>` rather than `<prefix>/bin/node` because versioned formulae
// (`node@22`) are keg-only: brew never links them into `<prefix>/bin`, so that
// path is either missing or — worse — the *unversioned* formula, a different
// major. `opt/` is the one form that resolves correctly for both.
//
// brew maintains `opt/<formula>` for every formula it has installed — it's what
// `brew --prefix <formula>` resolves to — so a Cellar match implies the symlink
// and there's nothing to probe for. A missing one would mean a half-deleted brew
// prefix, where a unit that won't start is the loud break we want over silently
// re-baking the Cellar path this function exists to remove.
//
// nvm has the same fragility but no equivalent stable symlink, so we warn
// instead.
export function stableNodePath(execPath: string): string {
  const brewMatch = execPath.match(/^(.*)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/);
  return brewMatch ? `${brewMatch[1]}/opt/${brewMatch[2]}/bin/node` : execPath;
}

function warnIfFragileNodePath(execPath: string): void {
  if (execPath.includes("/.nvm/versions/node/")) {
    console.warn(
      `Warning: installing against nvm node at ${execPath}. ` +
      `The service will break on \`nvm install\`/\`nvm uninstall\` of this version — ` +
      `re-run \`npm run install-service\` after nvm changes, or install with Homebrew node for stability.`,
    );
  }
}

export interface PlistInputs {
  label: string;
  nodePath: string;
  reportScript: string;
  workingDir: string;
  logPath: string;
}

// Pure: builds the launchd plist body. Tested directly so a typo in the
// node/script/working-dir interpolation fails locally rather than at
// install time on a developer's machine.
export function buildLaunchdPlist({ label, nodePath, reportScript, workingDir, logPath }: PlistInputs): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${reportScript}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${workingDir}</string>
  <key>StartInterval</key>
  <integer>7200</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;
}

export interface SystemdInputs {
  nodePath: string;
  reportScript: string;
  workingDir: string;
}

// Pure: builds the systemd .service body.
export function buildSystemdService({ nodePath, reportScript, workingDir }: SystemdInputs): string {
  return `[Unit]
Description=Token Tracking Reporter

[Service]
Type=oneshot
ExecStart=${nodePath} ${reportScript}
WorkingDirectory=${workingDir}
Environment=PATH=${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

// Pure: builds the systemd .timer body. Constant for now, but exporting
// keeps the surface symmetric with buildSystemdService.
export function buildSystemdTimer(): string {
  return `[Unit]
Description=Run Token Tracking Reporter every 2 hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=2h
Persistent=true

[Install]
WantedBy=timers.target
`;
}

const NODE_PATH = stableNodePath(process.execPath);

if (require.main === module) {
  warnIfFragileNodePath(NODE_PATH);
  if (os.platform() === "darwin") {
    installLaunchd();
  } else if (os.platform() === "linux") {
    installSystemd();
  } else {
    console.error(`Unsupported platform: ${os.platform()}`);
    process.exit(1);
  }
}

function installLaunchd(): void {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const logPath = path.join(os.homedir(), "Library", "Logs", "token-tracking-reporter.log");

  const plist = buildLaunchdPlist({
    label: LAUNCHD_LABEL,
    nodePath: NODE_PATH,
    reportScript: REPORT_SCRIPT,
    workingDir: PROJECT_ROOT,
    logPath,
  });

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  fs.chmodSync(plistPath, 0o644);
  console.log(`Wrote ${plistPath}`);

  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Cannot determine the logged-in user id for launchd");
  for (const command of buildLaunchdInstallCommands({ uid, label: LAUNCHD_LABEL, plistPath })) {
    try {
      execFileSync(command.file, command.args, { encoding: "utf-8" });
    } catch (err) {
      if (!command.tolerateFailure) throw err;
    }
  }
  console.log(`Bootstrapped and verified ${LAUNCHD_LABEL} — runs every 2 hours and once now`);
}

function installSystemd(): void {
  const userDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(userDir, { recursive: true });

  const servicePath = path.join(userDir, `${SYSTEMD_UNIT_BASENAME}.service`);
  const timerPath = path.join(userDir, `${SYSTEMD_UNIT_BASENAME}.timer`);

  const service = buildSystemdService({
    nodePath: NODE_PATH,
    reportScript: REPORT_SCRIPT,
    workingDir: PROJECT_ROOT,
  });
  const timer = buildSystemdTimer();

  fs.writeFileSync(servicePath, service);
  console.log(`Wrote ${servicePath}`);

  fs.writeFileSync(timerPath, timer);
  console.log(`Wrote ${timerPath}`);

  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", `${SYSTEMD_UNIT_BASENAME}.timer`], { stdio: "inherit" });
  console.log(`Enabled and started ${SYSTEMD_UNIT_BASENAME}.timer`);
}
