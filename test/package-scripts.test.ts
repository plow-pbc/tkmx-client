import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"),
) as { scripts?: Record<string, string> };

const BUILD_SCRIPT_NAMES = ["build", "build:tests"] as const;
const POSIX_ONLY_FS_COMMAND = /(^|&&\s*|\|\|\s*|;\s*)(rm|cp)\s+/;

/** Body of the justfile's `test:` recipe, up to the next unindented line. */
function justTestRecipe(): string {
  const justfile = fs.readFileSync(
    path.join(__dirname, "..", "..", "justfile"),
    "utf-8",
  );
  const afterHeader = justfile.split(/^test:$/m)[1];
  assert.ok(afterHeader, "justfile should define a test recipe");
  return afterHeader.split(/^\S/m)[0] ?? "";
}

// `just test` calls these two separately so setup failures can exit 2 while a
// failing assertion stays exit 1; `npm test` chains them for anyone not using
// just. Both must keep calling both, in order — inline a stage or drop one and
// the suite quietly runs against stale dist, or does nothing at all, while
// staying green. Only the two script names live here, so nothing is duplicated.
test("both entry points run setup then the suite", () => {
  const surfaces = {
    "npm test": PACKAGE_JSON.scripts?.test ?? "",
    "just test": justTestRecipe(),
  };

  for (const [surface, body] of Object.entries(surfaces)) {
    const setupAt = body.indexOf("npm run test:setup");
    const runAt = body.indexOf("npm run test:run");

    assert.ok(setupAt !== -1, `${surface} should call npm run test:setup`);
    assert.ok(runAt !== -1, `${surface} should call npm run test:run`);
    assert.ok(
      setupAt < runAt,
      `${surface} should compile in test:setup before test:run executes the suite`,
    );
  }
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
