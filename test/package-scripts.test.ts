import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"),
) as { scripts?: Record<string, string> };

const BUILD_SCRIPT_NAMES = ["build", "build:tests"] as const;
const STAGE_SCRIPT_NAMES = [...BUILD_SCRIPT_NAMES, "test:run"] as const;
const POSIX_ONLY_FS_COMMAND = /(^|&&\s*|\|\|\s*|;\s*)(rm|cp)\s+/;

/** The indented body of a just recipe, e.g. everything under `test:`. */
function recipeBody(name: string): string {
  const lines = fs
    .readFileSync(path.join(__dirname, "..", "..", "justfile"), "utf-8")
    .split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  assert.notEqual(start, -1, `justfile should define a ${name} recipe`);

  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => line.trim() !== "" && !/^\s/.test(line));
  return (end === -1 ? body : body.slice(0, end)).join("\n");
}

// `just test` splits these stages apart to give each its own exit code. Both
// entry points have to keep running all of them: drop one from the justfile and
// the suite runs against stale compiled output, drop one from `npm test` and
// anyone invoking npm directly skips a compile. Neither failure is loud.
test("every build stage runs under both `npm test` and `just test`", () => {
  const surfaces = {
    "npm test": PACKAGE_JSON.scripts?.test ?? "",
    "just test": recipeBody("test"),
  };

  for (const [surface, body] of Object.entries(surfaces)) {
    for (const stage of STAGE_SCRIPT_NAMES) {
      assert.match(
        body,
        new RegExp(`npm run ${stage}(\\s|$)`),
        `${surface} should run the ${stage} script rather than inlining or skipping it`,
      );
    }
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
