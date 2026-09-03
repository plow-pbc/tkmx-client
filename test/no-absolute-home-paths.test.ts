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

// Placeholders are the whole point of writing an example path, so the scan
// allows a documented set of them and flags anything else. It deliberately does
// NOT hardcode the current developer's username: doing so would commit the very
// string this test exists to keep out of the repo.
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

// THE single definition of what a home path looks like. The username runs to
// the first non-name character or end of line — requiring a trailing slash
// would miss `BEADS_ROOT=/Users/someone` and `cd "/Users/someone"`, which is
// exactly the shape generated wrappers and gitignore comments produce.
const HOME_PATH = /(?:\/Users\/|\/home\/)([A-Za-z0-9._<>-]+)(?![A-Za-z0-9._-])/g;

// git grep is a cheap pre-filter and nothing more: it matches the two fixed
// prefixes and is deliberately BROADER than HOME_PATH, so it can never be the
// thing that decides whether a line offends. `classify` alone decides.
const GREP_PREFIXES = "/Users/|/home/";

// This file has to contain a non-placeholder example path to test itself with,
// so it is the one file the repo scan skips. It is a path, not a second
// definition of the pattern.
const SELF = "test/no-absolute-home-paths.test.ts";

/**
 * Pure: given one line of text, return the offending (non-placeholder)
 * usernames in it. This is the whole matching policy, in one place, and the
 * unit test below is what proves it works — the repo scan cannot, because the
 * real index is clean and so stays green whether this is correct or not.
 */
export function classify(line: string): string[] {
  const offenders: string[] = [];
  for (const match of line.matchAll(HOME_PATH)) {
    if (!ALLOWED_PLACEHOLDER_USERS.has(match[1])) offenders.push(match[1]);
  }
  return offenders;
}

/**
 * Grep the git INDEX, not the working tree and not HEAD.
 *
 * Reading HEAD was the subtle bug this replaced: `bd init` rewrites an
 * already-tracked hook wrapper in place, so the staged blob carries the leak
 * while `git show HEAD:<path>` still returns the clean pre-init version. The
 * scan passed green on precisely the case it existed to catch.
 *
 * `--cached` reads staged content, `-I` skips binary blobs, and `-n` gives line
 * numbers. git grep exits 1 with no output when nothing matches, which is the
 * success case; any other non-zero status is a real failure and is rethrown
 * rather than swallowed.
 */
function stagedLines(): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "--cached", "-nI", "-E", GREP_PREFIXES, "--", ".", `:!${SELF}`],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split("\n").filter(Boolean);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return []; // no matches — the clean case
    throw error;
  }
}

// A synthetic username, assembled at runtime so this file does not itself carry
// a literal that looks like a leak.
const NOT_A_PLACEHOLDER = ["real", "dev"].join("");

test("classify flags real usernames and allows documented placeholders", () => {
  // The shape a bd init wrapper produces.
  assert.deepEqual(classify(`ROBOREV="/Users/${NOT_A_PLACEHOLDER}/.local/bin/roborev"`), [
    NOT_A_PLACEHOLDER,
  ]);
  // Terminal path, no trailing slash — the case a slash-anchored pattern misses.
  assert.deepEqual(classify(`BEADS_ROOT=/Users/${NOT_A_PLACEHOLDER}`), [NOT_A_PLACEHOLDER]);
  // Linux home directories count too.
  assert.deepEqual(classify(`/home/${NOT_A_PLACEHOLDER}/tkmx-client`), [NOT_A_PLACEHOLDER]);
  // Documented placeholders are the reason example paths get written at all.
  assert.deepEqual(classify("/Users/alice/.nvm/versions/node/v24.14.1/bin/node"), []);
  assert.deepEqual(classify("file:///Users/someone/dev/my-marketplace"), []);
  assert.deepEqual(classify("/Users/<name>/.config/roborev"), []);
  // A username that merely starts with a placeholder must not be excused.
  assert.deepEqual(classify("/Users/alicent/x"), ["alicent"]);
  // Lines with no home path at all.
  assert.deepEqual(classify("const HOME = process.env.HOME;"), []);
  assert.deepEqual(classify("~/.local/bin/roborev"), []);
  // Several on one line are all reported.
  assert.deepEqual(
    classify(`cp /Users/${NOT_A_PLACEHOLDER}/a /home/${NOT_A_PLACEHOLDER}/b`),
    [NOT_A_PLACEHOLDER, NOT_A_PLACEHOLDER],
  );
});

test("the grep pre-filter is broader than the matcher, so it never decides", () => {
  // Every prefix the pre-filter looks for must be one HOME_PATH also knows, or
  // the two could drift into disagreeing about what reaches classify().
  for (const prefix of GREP_PREFIXES.split("|")) {
    assert.deepEqual(classify(`${prefix}${NOT_A_PLACEHOLDER}/x`), [NOT_A_PLACEHOLDER]);
  }
});

test("no staged file contains a real absolute home path", () => {
  const offenders: string[] = [];

  for (const entry of stagedLines()) {
    // `path:line:text`, and the text may itself contain colons.
    const firstColon = entry.indexOf(":");
    const secondColon = entry.indexOf(":", firstColon + 1);
    if (firstColon === -1 || secondColon === -1) continue;
    const file = entry.slice(0, firstColon);
    const line = entry.slice(firstColon + 1, secondColon);

    // Report the location, never the leaked name — a failure message ends up in
    // public CI logs.
    if (classify(entry.slice(secondColon + 1)).length > 0) offenders.push(`${file}:${line}`);
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
