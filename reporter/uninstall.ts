import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as os from "node:os";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_BASENAME, launchdPlistPath } from "./install";

if (os.platform() === "darwin") {
  uninstallLaunchd();
} else if (os.platform() === "linux") {
  uninstallSystemd();
} else {
  console.error(`Unsupported platform: ${os.platform()}`);
  process.exit(1);
}

function uninstallLaunchd(): void {
  const plistPath = launchdPlistPath(os.homedir());

  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
      console.log(`Unloaded ${LAUNCHD_LABEL}`);
    } catch {}
    fs.unlinkSync(plistPath);
    console.log(`Removed ${plistPath}`);
  } else {
    console.log(`No plist at ${plistPath} — nothing to remove`);
  }
}

// NOTE: this systemd path is untested — author only verified the launchd
// branch on darwin. Mirrors install.ts step-for-step, but please sanity-check
// on linux before relying on it.
function uninstallSystemd(): void {
  const userDir = path.join(os.homedir(), ".config", "systemd", "user");
  const servicePath = path.join(userDir, `${SYSTEMD_UNIT_BASENAME}.service`);
  const timerPath = path.join(userDir, `${SYSTEMD_UNIT_BASENAME}.timer`);

  try {
    execSync(`systemctl --user disable --now ${SYSTEMD_UNIT_BASENAME}.timer 2>/dev/null`);
    console.log(`Disabled and stopped ${SYSTEMD_UNIT_BASENAME}.timer`);
  } catch {}

  let removed = false;
  for (const p of [timerPath, servicePath]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`Removed ${p}`);
      removed = true;
    }
  }
  if (!removed) {
    console.log("No systemd units found — nothing to remove");
    return;
  }

  try {
    execSync("systemctl --user daemon-reload");
  } catch {}
}
