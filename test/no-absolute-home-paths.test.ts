import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Resolve from git rather than __dirname so the test is correct whether it runs
// from dist/test/ (npm test) or from test/ directly under tsx/ts-node.
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: __dirname,
  encoding: "utf8",
}).trim();

// This repo is PUBLIC, and several agent workflows generate files with the
// generating machine's home directory baked in — `bd init` writes .beads/hooks/
// wrappers containing an absolute `/Users/<name>/...` path, and progress docs
// and gitignore comments tend to quote real paths as examples.
//
// Committing one publishes a developer's account name and, worse, produces a
// file that is a silent no-op on every other machine: a hook wrapper pointing
// at a path no other clone has does nothing, while still looking installed.
// Neither failure is visible in review — the leak is one line deep in a
// generated wrapper, and CI is otherwise green. This test is the check that
// does look.
//
// It scans STAGED (index) content only. An untracked path is the .gitignore's
// problem (see gitignore.test.ts); this asserts the complementary half — that
// nothing entering the index carries a real home path.

// Placeholders are the whole point of writing an example path, so the test
// allows a documented set of them and fails on anything else. It deliberately
// does NOT hardcode the current developer's username: doing so would commit the
// very string this test exists to keep out of the repo.
const ALLOWED_PLACEHOLDER_USERS = new Set([
  "alice",
  "bob",
  "someone",
  "user",
  "username",
  "you",
  "<username>",
  "<user>",
  "<REDACTED>",
  "<name>",
]);

// macOS is `/Users/<name>`, Linux `/home/<name>`. The username is terminated by
// a non-name character OR end of line — requiring a trailing slash would miss
// `BEADS_ROOT=/Users/someone` and `cd "/Users/someone"`, which is exactly the
// shape generated wrappers and gitignore comments produce.
const HOME_PATH = /(?:\/Users\/|\/home\/)([A-Za-z0-9._<>-]+)(?![A-Za-z0-9._-])/g;

// This test's own allowlist is written in terms of the pattern it matches, so
// scanning it would report itself.
const SELF = "test/no-absolute-home-paths.test.ts";

/**
 * Grep the git INDEX, not the working tree and not HEAD.
 *
 * Reading HEAD is the subtle bug this replaced: `bd init` rewrites an
 * already-tracked hook wrapper in place, so the staged blob carries the leak
 * while `git show HEAD:<path>` still returns the clean pre-init version. The
 * scan passed green on precisely the case it existed to catch.
 *
 * `--cached` reads staged content, `-I` skips binary blobs, and `-n` gives line
 * numbers. git grep exits 1 with no output when nothing matches, which is the
 * success case here; any other non-zero status is a real failure and is
 * rethrown rather than swallowed.
 */
function stagedMatches(): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "--cached", "-nI", "-E", "(/Users/|/home/)[A-Za-z0-9._<>-]+", "--", ".", `:!${SELF}`],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split("\n").filter(Boolean);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return []; // no matches — the clean case
    throw error;
  }
}

test("no staged file contains a real absolute home path", () => {
  const offenders: string[] = [];

  for (const entry of stagedMatches()) {
    // `path:line:text` — the path may itself contain colons, so split off the
    // last two fields from the right rather than the first two from the left.
    const firstColon = entry.indexOf(":");
    const secondColon = entry.indexOf(":", firstColon + 1);
    if (firstColon === -1 || secondColon === -1) continue;
    const file = entry.slice(0, firstColon);
    const line = entry.slice(firstColon + 1, secondColon);
    const text = entry.slice(secondColon + 1);

    for (const match of text.matchAll(HOME_PATH)) {
      if (ALLOWED_PLACEHOLDER_USERS.has(match[1])) continue;
      // Report the location, never the leaked name — a failure message ends up
      // in public CI logs.
      offenders.push(`${file}:${line}`);
      break;
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Staged files contain an absolute home path, which publishes a developer's ` +
      `account name and is non-portable. Rewrite the path as $HOME/... or ~/..., ` +
      `or use one of the documented placeholders. Offending locations:\n  ` +
      offenders.join("\n  "),
  );
});
