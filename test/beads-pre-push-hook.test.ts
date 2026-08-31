import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.join(__dirname, "..", "..");
const HOOK = path.join(REPO_ROOT, ".beads", "hooks", "pre-push");

// `.beads/hooks/pre-push` is two gates stacked in one file: a roborev
// FAIL-verdict check prepended above beads' own managed lifecycle block.
// The roborev half is deliberately fail-open, so every one of its "nothing to
// check here" paths used to `exit 0` — which terminated the whole hook and left
// beads' `bd hooks run pre-push` unreachable on every ordinary push. The repo
// advertises that pushing syncs beads, so that contract was silently dead.
//
// These tests run the real hook against a throwaway repo with a stubbed `bd`,
// asserting observable behaviour rather than the file's text, so the guarantee
// survives any future reshuffle of the two gates.

type HookRun = {
  status: number;
  stderr: string;
  beadsInvocations: string;
  sha: string;
  tmpLeftovers: string[];
};

/** Run the hook in a scratch repo, with `bd` (and optionally `roborev`) stubbed. */
function runHook(opts: {
  roborevJson?: (sha: string) => string;
  /** Override what git feeds the hook on stdin. */
  stdin?: (sha: string) => string;
  /** Make `mktemp` fail, as an unwritable or missing $TMPDIR would. */
  breakMktemp?: boolean;
}): HookRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-"));
  try {
    const bin = path.join(dir, "bin");
    const home = path.join(dir, "home");
    const marker = path.join(dir, "beads-invocations");
    fs.mkdirSync(bin);
    fs.mkdirSync(home);

    // Stub bd: records that beads' lifecycle was reached, with what arguments,
    // and — the part that matters — what it saw on stdin.
    fs.writeFileSync(
      path.join(bin, "bd"),
      `#!/bin/sh\n{ echo "$*"; cat; } >> ${JSON.stringify(marker)}\nexit 0\n`,
      { mode: 0o755 },
    );
    if (opts.breakMktemp) {
      fs.writeFileSync(path.join(bin, "mktemp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }

    // A private TMPDIR, so the hook's own spool file is the only thing that can
    // appear in it.
    const tmp = path.join(dir, "tmp");
    fs.mkdirSync(tmp);

    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    // git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY to
    // the hooks it runs, and this repo installs hooks — so if the suite is ever
    // run from under one, an inherited env would point these git calls at the
    // real repository's index instead of the throwaway one.
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(cleanEnv)) if (k.startsWith("GIT_")) delete cleanEnv[k];
    // ...and don't inherit the developer's global config either: commit.gpgsign
    // alone would fail every `git commit` here for reasons unrelated to the hook.
    // This also covers core.hooksPath, so the scratch repo runs no host hooks.
    cleanEnv.GIT_CONFIG_GLOBAL = "/dev/null";
    cleanEnv.GIT_CONFIG_SYSTEM = "/dev/null";

    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv }).trim();
    git("init", "--quiet");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    fs.writeFileSync(path.join(repo, "f"), "x");
    git("add", "f");
    git("commit", "--quiet", "-m", "c");
    const sha = git("rev-parse", "HEAD");

    if (opts.roborevJson !== undefined) {
      fs.writeFileSync(
        path.join(bin, "roborev"),
        `#!/bin/sh\ncat <<'JSON'\n${opts.roborevJson(sha)}\nJSON\n`,
        { mode: 0o755 },
      );
    }

    // What git itself feeds a pre-push hook on stdin.
    const stdin = opts.stdin
      ? opts.stdin(sha)
      : `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`;
    const run = spawnSync("sh", [HOOK, "origin", "https://example.invalid/r.git"], {
      cwd: repo,
      input: stdin,
      encoding: "utf8",
      env: { ...cleanEnv, PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmp },
    });

    return {
      status: run.status ?? -1,
      stderr: run.stderr ?? "",
      beadsInvocations: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "",
      sha,
      tmpLeftovers: fs.readdirSync(tmp),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("runs beads' pre-push lifecycle when roborev is not installed", () => {
  // The regression: roborev absent is the commonest case (any machine but the
  // one that generated these hooks), and it must not swallow beads.
  const run = runHook({});
  assert.equal(run.status, 0);
  assert.match(run.beadsInvocations, /hooks run pre-push/);
  // beads reads the ref list off stdin; reaching it with an empty one is the
  // same silent death as never reaching it at all.
  assert.match(run.beadsInvocations, new RegExp(run.sha));
  // The spool file is unlinked as soon as its fd is open, so no exit path can
  // leave one behind.
  assert.deepEqual(run.tmpLeftovers, []);
});

test("runs beads' pre-push lifecycle when roborev has no blocking review", () => {
  const run = runHook({ roborevJson: () => "[]" });
  assert.equal(run.status, 0);
  assert.match(run.beadsInvocations, /hooks run pre-push/);
  assert.match(run.beadsInvocations, new RegExp(run.sha));
});

test("still blocks the push when roborev has an unresolved FAIL verdict", () => {
  // The roborev gate keeps its teeth: making it fall through to beads must not
  // have cost it the ability to fail a push outright.
  const run = runHook({
    roborevJson: (sha) =>
      JSON.stringify([
        { verdict: "F", closed: false, status: "done", git_ref: sha, id: 1, commit_subject: "c" },
      ]),
  });
  assert.equal(run.status, 1);
  assert.equal(run.beadsInvocations, "");
  assert.deepEqual(run.tmpLeftovers, []);
});

test("hands the ref list to beads unchanged, metacharacters and all", () => {
  // Ref names may legally contain `, $ and () — only space, ~^:?*[\\ and control
  // chars are rejected by check-ref-format — so whatever path stdin takes to
  // reach beads has to be byte-preserving, not a re-parse of the ref list.
  const weird = "refs/heads/a$(x)`y`b";
  const run = runHook({
    stdin: (sha) => `${weird} ${sha} ${weird} ${"0".repeat(40)}\n`,
  });
  assert.equal(run.status, 0);
  assert.match(run.beadsInvocations, /hooks run pre-push/);
  assert.ok(
    run.beadsInvocations.includes(`${weird} ${run.sha}`),
    `beads saw: ${JSON.stringify(run.beadsInvocations)}`,
  );
});

test("still runs beads when it cannot spool stdin to a temp file", () => {
  // The roborev gate may fail open; beads' lifecycle may not. An unwritable
  // $TMPDIR must not become a silent "beads never ran" — the same silent
  // contract death, just relocated to the spool step.
  const run = runHook({ breakMktemp: true });
  assert.equal(run.status, 0);
  assert.match(run.beadsInvocations, /hooks run pre-push/);
  assert.match(run.beadsInvocations, new RegExp(run.sha));
  // And it has to SAY so: a silent fallback is the bug, not the fix.
  assert.match(run.stderr, /mktemp failed/);
});


test("allows the push when the FAIL verdict is for a commit not being pushed", () => {
  // The gate discriminates on `git_ref in pushed`. A false positive here blocks
  // EVERY push with no way out short of --no-verify, so it is the branch most
  // worth pinning — and the one an empty-list test cannot reach.
  const run = runHook({
    roborevJson: () =>
      JSON.stringify([
        {
          verdict: "F",
          closed: false,
          status: "done",
          git_ref: "f".repeat(40),
          id: 1,
          commit_subject: "some other commit",
        },
      ]),
  });
  assert.equal(run.status, 0);
  assert.match(run.beadsInvocations, /hooks run pre-push/);
});
