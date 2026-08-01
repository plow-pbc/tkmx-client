import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"),
) as { scripts?: Record<string, string> };

const BUILD_SCRIPT_NAMES = ["build", "build:tests"] as const;
const POSIX_ONLY_FS_COMMAND = /(^|&&\s*|\|\|\s*|;\s*)(rm|cp)\s+/;

// `just test` runs test:setup and test:run as separate steps so it can give a
// setup failure its own exit code. Those two scripts own the stage list, so the
// justfile can't drift from `npm test` — as long as npm test keeps composing
// both. Inline a stage here instead and the two entry points diverge silently.
test("npm test composes the same setup and run scripts the justfile calls", () => {
  assert.match(
    PACKAGE_JSON.scripts?.test ?? "",
    /npm run test:setup\s*&&\s*npm run test:run/,
    "npm test should delegate to test:setup and test:run rather than inlining the stages",
  );
});

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
