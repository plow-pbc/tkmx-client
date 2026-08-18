import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as os from "node:os";

// PROJECT_ROOT is the actual checked-out repo, not dist/. After build, this
// file lives in dist/reporter/install.js — go up two levels to reach the repo.
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
export const REPORT_SCRIPT = path.join(PROJECT_ROOT, "dist", "reporter", "report.js");
export const LAUNCHD_LABEL = "com.token-tracking.reporter";
export const SYSTEMD_UNIT_BASENAME = "token-tracking-reporter";

// Where the unit files live. Exported and home-parameterized because install,
// uninstall, and doctor all need the same three paths, and a doctor that
// computed them independently could look at a different file than the one
// install wrote — reading "not installed" off a healthy machine.
export function launchdPlistPath(home: string): string {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function systemdServicePath(home: string): string {
  return path.join(home, ".config", "systemd", "user", `${SYSTEMD_UNIT_BASENAME}.service`);
}

export function systemdTimerPath(home: string): string {
  return path.join(home, ".config", "systemd", "user", `${SYSTEMD_UNIT_BASENAME}.timer`);
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
  const plistPath = launchdPlistPath(os.homedir());
  const logPath = path.join(os.homedir(), "Library", "Logs", "token-tracking-reporter.log");

  const plist = buildLaunchdPlist({
    label: LAUNCHD_LABEL,
    nodePath: NODE_PATH,
    reportScript: REPORT_SCRIPT,
    workingDir: PROJECT_ROOT,
    logPath,
  });

  // Unload first if already loaded
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch {}

  fs.writeFileSync(plistPath, plist);
  console.log(`Wrote ${plistPath}`);

  execSync(`launchctl load "${plistPath}"`);
  console.log(`Loaded ${LAUNCHD_LABEL} — will run every 2 hours and once now`);
}

function installSystemd(): void {
  const userDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(userDir, { recursive: true });

  const servicePath = systemdServicePath(os.homedir());
  const timerPath = systemdTimerPath(os.homedir());

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

  execSync("systemctl --user daemon-reload");
  execSync(`systemctl --user enable --now ${SYSTEMD_UNIT_BASENAME}.timer`);
  console.log(`Enabled and started ${SYSTEMD_UNIT_BASENAME}.timer`);
}
