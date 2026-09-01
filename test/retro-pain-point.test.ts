import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.join(__dirname, "..", "..");
const FILER = path.join(REPO_ROOT, "scripts", "file-retro-pain-point.sh");

// The filer talks to `bd`, which owns the real issue database. Pointing BD_BIN
// at a stub keeps these tests from writing to the project's own tracker, and
// lets us assert on the exact argv the filer produced — which is where the
// dedupe behaviour actually lives.
//
// The stub is stateful on purpose: the whole contract under test is "the second
// filing of one finding escalates the first bead", and that cannot be observed
// against a stub that forgets what it created.
function makeFakeBd(dir: string, opts: { createEmitsId?: boolean } = {}): string {
  const state = path.join(dir, "state.json");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(state, JSON.stringify({ byKey: {}, labels: {}, comments: [] }));
  const emitsId = opts.createEmitsId !== false;
  const bd = path.join(dir, "bd");
  fs.writeFileSync(
    bd,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
export STATE=${JSON.stringify(state)}
node -e '
  const fs = require("fs");
  const state = process.env.STATE, argv = process.argv.slice(1);
  const s = JSON.parse(fs.readFileSync(state, "utf8"));
  const sub = argv[0];
  const labelOf = () => { const i = argv.indexOf("--label"); return i < 0 ? null : argv[i + 1]; };
  if (sub === "list" && argv[1] === "--all") {
    const key = labelOf();
    const id = key && s.byKey[key];
    process.stdout.write(JSON.stringify(id ? [{ id, title: "x" }] : []));
  } else if (sub === "create") {
    const li = argv.indexOf("-l");
    const labels = li < 0 ? [] : argv[li + 1].split(",");
    const key = labels.find(l => l.startsWith("fbkey-"));
    const id = "fake-bead-1";
    if (key) { s.byKey[key] = id; s.labels[id] = labels; }
    fs.writeFileSync(state, JSON.stringify(s));
    if (${emitsId ? "true" : "false"}) process.stdout.write(JSON.stringify({ id }));
  } else if (sub === "label" && argv[1] === "list") {
    process.stdout.write((s.labels[argv[2]] || []).join("\\n"));
  } else if (sub === "label" && argv[1] === "add") {
    (s.labels[argv[2]] = s.labels[argv[2]] || []).push(argv[3]);
    fs.writeFileSync(state, JSON.stringify(s));
  } else if (sub === "label" && argv[1] === "remove") {
    s.labels[argv[2]] = (s.labels[argv[2]] || []).filter(l => l !== argv[3]);
    fs.writeFileSync(state, JSON.stringify(s));
  } else if (sub === "comment") {
    s.comments.push(argv[1]);
    fs.writeFileSync(state, JSON.stringify(s));
  }
' -- "$@"
`,
    { mode: 0o755 },
  );
  return bd;
}

function runFiler(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): { line: string; status: number } {
  let status = 0;
  let out = "";
  try {
    out = execFileSync("bash", [FILER, ...args], {
      env: { ...process.env, ...env },
      input: input ?? "",
      encoding: "utf8",
    });
  } catch (err: any) {
    status = err.status ?? 1;
    out = err.stdout ?? "";
  }
  return { line: out.trim(), status };
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "retro-filer-"));
}

const GOOD = [
  "--summary",
  "Preview server declines to start on a fresh worktree",
  "--severity",
  "3",
  "--recommendation",
  "Detect the dev server from package.json scripts before giving up",
];

// The caller prints this line straight into a retro heading and never checks an
// exit code, so a filer that exits non-zero or prints two lines silently
// corrupts the retro. Both halves are contract, not style.
test("prints exactly one line and exits 0 on success", () => {
  const dir = tmp();
  const bd = makeFakeBd(dir);
  const { line, status } = runFiler(GOOD, {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
  });
  assert.equal(status, 0);
  assert.equal(line.split("\n").length, 1);
  assert.equal(line, "fake-bead-1");
});

// The reason this script exists instead of a bare `bd create`: a second sighting
// must land on the SAME bead. A duplicate here splits the recurrence count that
// inbox triage ranks by, which is precisely the failure builder-index-client-080
// describes.
test("a repeat sighting escalates the same bead instead of creating a second", () => {
  const dir = tmp();
  const bd = makeFakeBd(dir);
  const env = {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
  };
  const first = runFiler(GOOD, env);
  const second = runFiler([...GOOD, "--context", "seen again on a later run"], env);

  assert.equal(first.line, second.line, "both sightings must resolve to one bead");

  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
  assert.equal(calls.match(/^create /gm)?.length, 1, "create must run exactly once");
  assert.match(calls, /^comment fake-bead-1 --stdin$/m, "the repeat must leave evidence");
  assert.match(calls, /label add fake-bead-1 seen-2/, "the recurrence counter must advance");
});

// Wording drifts between runs; the finding does not. Keying on normalised text
// keeps one bead when only case and spacing changed.
test("case and whitespace drift still hits the same dedupe key", () => {
  const dir = tmp();
  const bd = makeFakeBd(dir);
  const env = {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
  };
  runFiler(GOOD, env);
  const again = runFiler(
    [
      "--summary",
      "Preview   server DECLINES to start on a fresh worktree",
      "--severity",
      "3",
      "--recommendation",
      "Detect the  dev server from package.json scripts before giving up",
    ],
    env,
  );
  assert.equal(again.line, "fake-bead-1");
  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
  assert.equal(calls.match(/^create /gm)?.length, 1);
});

// `context` carries run-specific evidence and differs on every sighting. If it
// fed the key, nothing would ever dedupe.
test("context is evidence, not identity, so it stays out of the key", () => {
  const dir = tmp();
  const bd = makeFakeBd(dir);
  const env = {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
  };
  runFiler([...GOOD, "--context", "run A"], env);
  const b = runFiler([...GOOD, "--context", "run B, totally different evidence"], env);
  assert.equal(b.line, "fake-bead-1");
});

// Refusing beats redacting: the author knows which detail carried the meaning.
// `scrubbed` therefore has to be recoverable — a rewrite, not a rejection.
test("PII and secrets are refused rather than filed", () => {
  const dir = tmp();
  const bd = makeFakeBd(dir);
  const env = {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
  };
  const cases = [
    ["--context", "failed under /Users/someperson/Projects/thing"],
    ["--context", "mail the owner at someone@example.com"],
    ["--context", "used token ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["--context", "creds AKIAIOSFODNN7EXAMPLE in the env"],
    ["--context", "sent Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"],
    ["--context", "api_key = s3cr3tvalue12345"],
  ];
  for (const extra of cases) {
    const { line, status } = runFiler([...GOOD, ...extra], env);
    assert.equal(status, 0);
    assert.equal(line, "unfiled:scrubbed", `should refuse: ${extra[1]}`);
  }
  assert.ok(!fs.existsSync(path.join(dir, "calls.log")), "nothing may reach bd");
});

// A machine without bd must not lose the finding. Parking is a slower success:
// the drop log holds it and the next run re-files it.
test("a missing bd parks the finding rather than dropping it", () => {
  const dir = tmp();
  const drops = path.join(dir, "drops.jsonl");
  const { line, status } = runFiler(GOOD, {
    BD_BIN: path.join(dir, "definitely-not-here"),
    RETRO_DROP_LOG: drops,
  });
  assert.equal(status, 0);
  assert.equal(line, "unfiled:parked-no-bd");

  const parked = JSON.parse(fs.readFileSync(drops, "utf8").trim());
  assert.equal(parked.reason, "parked-no-bd");
  assert.equal(parked.severity, 3);
  assert.match(parked.fbkey, /^fbkey-[0-9a-f]{12}$/);
  assert.equal(parked.summary, GOOD[1]);
});

// A create that lands but reports nothing usable must NOT be retried blind —
// looking the key up first is what stops one finding becoming two beads.
test("an unconfirmed create resolves by key instead of filing twice", () => {
  const dir = tmp();
  const bd = makeFakeBd(dir, { createEmitsId: false });
  const { line } = runFiler(GOOD, {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
  });
  assert.equal(line, "fake-bead-1");
  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
  assert.equal(calls.match(/^create /gm)?.length, 1, "must not re-create after looking it up");
});

// Quoting prose into shell flags is where these calls break in practice: a
// backtick or $( in a double-quoted argument is command-substituted by the
// caller's shell. --json-stdin is the escape hatch, so it has to survive
// exactly the characters that motivated it.
test("--json-stdin carries prose that would break shell quoting", () => {
  const dir = tmp();
  const bd = makeFakeBd(dir);
  const payload = JSON.stringify({
    summary: "Command `bd comment` loses text containing $(backticks)",
    severity: 2,
    recommendation: "Pipe through --stdin so the shell never sees the prose",
    subsystem: "Retro Filer",
  });
  const { line, status } = runFiler(["--json-stdin"], {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
  }, payload);
  assert.equal(status, 0);
  assert.equal(line, "fake-bead-1");

  const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
  assert.match(calls, /\$\(backticks\)/, "the prose must reach bd verbatim");
  assert.match(calls, /subsystem-retro-filer/, "subsystem becomes a slug label");
});

// Severity is the caller's whole vocabulary for "how bad", so an out-of-range or
// missing one is a caller bug that must be reported, not guessed at.
test("bad input is reported, never guessed", () => {
  const dir = tmp();
  const bd = makeFakeBd(dir);
  const env = {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
  };
  for (const args of [
    ["--summary", "x", "--severity", "9", "--recommendation", "y"],
    ["--summary", "x", "--severity", "high", "--recommendation", "y"],
    ["--summary", "x", "--recommendation", "y"],
    ["--severity", "2", "--recommendation", "y"],
    ["--summary", "x", "--severity", "2"],
  ]) {
    const { line, status } = runFiler(args, env);
    assert.equal(status, 0);
    assert.equal(line, "unfiled:bad-args");
  }
});

// Severity 4 is a full blocker and 1 is a paper cut, while bd's priority runs
// the other way (0 critical .. 4 backlog). Getting this inverted would file
// every blocker into the backlog.
test("severity maps onto bd priority inverted", () => {
  const expected: Record<string, string> = { "4": "1", "3": "2", "2": "3", "1": "4" };
  for (const [sev, pri] of Object.entries(expected)) {
    const dir = tmp();
    const bd = makeFakeBd(dir);
    runFiler(["--summary", `sev ${sev} finding`, "--severity", sev, "--recommendation", "fix it"], {
      BD_BIN: bd,
      PATH: `${dir}:${process.env.PATH}`,
      RETRO_DROP_LOG: path.join(dir, "drops.jsonl"),
    });
    const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8");
    assert.match(calls, new RegExp(`--priority=${pri}\\b`), `severity ${sev} -> P${pri}`);
  }
});

// A failed lookup must never fall through into a create. If the store cannot be
// read, the script does not know whether this finding already has a bead — and
// guessing "no" mints the duplicate the whole script exists to prevent. Noise on
// stdout is the realistic shape of this: a bd that dies mid-write, or prints a
// usage banner, still fails while leaving bytes behind.
test("an unreadable store parks rather than guessing there is no bead", () => {
  const dir = tmp();
  const log = path.join(dir, "calls.log");
  const bd = path.join(dir, "bd");
  fs.writeFileSync(
    bd,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [[ "$1" == "list" ]]; then
  # fails, but not silently — the failure path must not depend on empty stdout
  printf 'Error: could not open the issue store\\n'
  exit 1
fi
printf '%s' '{"id":"must-not-be-created"}'
`,
    { mode: 0o755 },
  );
  const drops = path.join(dir, "drops.jsonl");
  const { line, status } = runFiler(GOOD, {
    BD_BIN: bd,
    PATH: `${dir}:${process.env.PATH}`,
    RETRO_DROP_LOG: drops,
  });

  assert.equal(status, 0);
  assert.equal(line, "unfiled:store-unreadable");

  const calls = fs.readFileSync(log, "utf8");
  assert.equal(calls.match(/^create /gm), null, "a failed lookup must not fall through to create");

  const parked = JSON.parse(fs.readFileSync(drops, "utf8").trim());
  assert.equal(parked.reason, "store-unreadable");
  assert.equal(parked.summary, GOOD[1]);
});
