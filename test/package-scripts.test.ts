import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"),
) as { scripts?: Record<string, string> };

const BUILD_SCRIPT_NAMES = ["build", "build:tests"] as const;
const POSIX_ONLY_FS_COMMAND = /(^|&&\s*|\|\|\s*|;\s*)(rm|cp)\s+/;

test("build npm scripts avoid POSIX-only filesystem commands", () => {
  for (const scriptName of BUILD_SCRIPT_NAMES) {
    const script = PACKAGE_JSON.scripts?.[scriptName] ?? "";

    assert.doesNotMatch(
      script,
      POSIX_ONLY_FS_COMMAND,
      `${scriptName} should use node-based filesystem operations so it works on Windows`,
    );
  }
});
