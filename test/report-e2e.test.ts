// End-to-end regression tests for the reporter's two-window contract:
//   1. REPORT_DAYS=1 with activity must still invoke agentsview with
//      --since 28d for session_stats so the wholesale-replaced blob keeps
//      its full rolling window.
//   2. An inactive day (no usage rows) must still POST so session_stats
//      and cursor_stats get refreshed — previously the reporter returned
//      early, which let stale blobs linger forever.
//
// Both tests run the actual reporter/report.js as a child process, stub
// agentsview via AGENTSVIEW_BIN to a recording bash script, and stub the
// server via an in-process http.Server. No real network, no real DB.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { writeFakeIndex } from "./fake-index";

// After build, __dirname = dist/test/. Project root is two levels up;
// the compiled report.js is at dist/reporter/report.js (one level up).
const REPO = path.join(__dirname, "..", "..");
const REPORT_JS = path.join(__dirname, "..", "reporter", "report.js");
const LEGACY_SHIM = path.join(REPO, "reporter", "report.js");
const STATE_PATH = path.join(REPO, ".reporting-state.json");
const ENV_PATH = path.join(REPO, ".env");

// Run a reporter entrypoint asynchronously so the in-process stub HTTP
// server's request handler can fire — spawnSync would block the event
// loop for the entire child lifetime and the server would never respond.
// `script` defaults to the compiled dist/reporter/report.js but can be
// overridden so the legacy reporter/report.js compat shim gets the same
// regression coverage.
function runReporter(env: Record<string, string>, timeoutMs = 30000, script: string = REPORT_JS): Promise<{status: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function quoteNodeOptionsValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function appendNodeOption(existing: string | undefined, option: string): string {
  return [existing, option].filter(Boolean).join(" ");
}

// Builds a temp fake-agentsview bash script. `dailyJson` is the value the
// `usage` subcommand echoes — either a row for the "activity" scenario or
// `{"daily":[]}` for the inactive scenario. The script also logs its argv
// to argvLog so tests can inspect the --since windows.
function writeFakeAgentsview(fakeBin, argvLog, dailyJson, failUsageEnvKey = "", failUsageEnvValue = "") {
  if (process.platform === "win32") {
    fs.writeFileSync(
      fakeBin,
      `const fs = require("fs");
const path = require("path");
const args = process.argv.slice(1);
const cmd = path.basename(args[0] || "");
if (cmd !== "usage" && cmd !== "stats" && cmd !== "sync") return;
args[0] = cmd;
const envCols = ["CODEX_SESSIONS_DIR", "CLAUDE_PROJECTS_DIR", "PIEBALD_DIR", "OPENCODE_DIR", "AGENT_VIEWER_DATA_DIR"].map((k) => k + "=" + (process.env[k] || ""));
fs.appendFileSync(${JSON.stringify(argvLog)}, args.concat(envCols).join("\\t") + "\\n");
if (cmd === "sync") { process.exit(0); }
if (cmd === "usage") {
  if (${JSON.stringify(failUsageEnvKey)} && process.env[${JSON.stringify(failUsageEnvKey)}] === ${JSON.stringify(failUsageEnvValue)}) {
    process.stderr.write("agentsview: simulated usage failure for " + ${JSON.stringify(failUsageEnvKey)} + "=" + process.env[${JSON.stringify(failUsageEnvKey)}] + "\\n");
    process.exit(2);
  }
  console.log(${JSON.stringify(dailyJson)});
  process.exit(0);
}
let since = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since") since = args[i + 1] || "";
}
console.log(JSON.stringify({ schema_version: 1, window: { days_arg: since }, totals: { sessions_all: 7 }, generated_at: "2026-04-24T00:00:00Z" }));
process.exit(0);
`,
    );
    return;
  }

  const shQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const failUsageConfig = `FAIL_USAGE_ENV_KEY=${shQuote(failUsageEnvKey)}
FAIL_USAGE_ENV_VALUE=${shQuote(failUsageEnvValue)}`;

  fs.writeFileSync(
    fakeBin,
    `#!/usr/bin/env bash
${failUsageConfig}
printf '%s\\t' "$@" >> "${argvLog}"
printf 'CODEX_SESSIONS_DIR=%s\\tCLAUDE_PROJECTS_DIR=%s\\tPIEBALD_DIR=%s\\tOPENCODE_DIR=%s\\tAGENT_VIEWER_DATA_DIR=%s\\t' "$CODEX_SESSIONS_DIR" "$CLAUDE_PROJECTS_DIR" "$PIEBALD_DIR" "$OPENCODE_DIR" "$AGENT_VIEWER_DATA_DIR" >> "${argvLog}"
printf '\\n' >> "${argvLog}"
case "$1" in
  sync)
    ;;
  --version)
    echo "agentsview v0.25.0 (commit abcdef1, built 2026-04-24T00:00:00Z)"
    ;;
  sync)
    # Standalone best-effort index refresh; the reporter runs this before
    # reading with --no-sync. A real agentsview exits 0 here.
    exit 0
    ;;
  usage)
    if [ -n "$FAIL_USAGE_ENV_KEY" ]; then
      current_value="\${!FAIL_USAGE_ENV_KEY}"
      if [ "$current_value" = "$FAIL_USAGE_ENV_VALUE" ]; then
        echo "agentsview: simulated usage failure for $FAIL_USAGE_ENV_KEY=$FAIL_USAGE_ENV_VALUE" >&2
        exit 2
      fi
    fi
    echo ${shQuote(dailyJson)}
    ;;
  stats)
    SINCE=""
    for ((i=1; i<=$#; i++)); do
      if [[ "\${!i}" == "--since" ]]; then
        j=$((i+1))
        SINCE="\${!j}"
      fi
    done
    printf '{"schema_version":1,"window":{"days_arg":"%s"},"totals":{"sessions_all":7},"generated_at":"2026-04-24T00:00:00Z"}\\n' "$SINCE"
    ;;
  *)
    echo "unexpected: $*" >&2
    exit 2
    ;;
esac
`,
  );
  fs.chmodSync(fakeBin, 0o755);
}

// Shared test scaffolding: tmp dir, fake-agentsview, stub server. Returns
// everything the test needs plus a cleanup fn.
// responseJson is widened past its default so a test can add response fields
// the reporter branches on, e.g. profile_frozen.
async function setupE2E({ dailyJson, failUsageEnvKey = "", failUsageEnvValue = "", responseJson = { ok: true } as Record<string, unknown>, indexAgents = ["claude", "codex", "pi", "opencode"] }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-e2e-"));
  // baseEnv sets HOME to tmp, so discoverAgents() reads this index rather than
  // the developer's real one — which would otherwise make these assertions
  // depend on whichever agents the machine running the suite happens to have.
  writeFakeIndex(path.join(tmp, ".agentsview"), indexAgents);
  const argvLog = path.join(tmp, "argv.log");
  const fakeScript = path.join(tmp, process.platform === "win32" ? "fake-agentsview-preload.cjs" : "fake-agentsview");
  writeFakeAgentsview(fakeScript, argvLog, dailyJson, failUsageEnvKey, failUsageEnvValue);
  const fakeBin = process.platform === "win32" ? process.execPath : fakeScript;

  let captured = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/usage" && req.method === "POST") {
        captured = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseJson));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as import("node:net").AddressInfo;
  const { port } = addr;

  const baseEnv = {
    PATH: process.env.PATH,
    HOME: tmp,  // isolates cursor db lookup
    USERNAME: "e2euser",
    TKMX_USERNAME: "e2euser",
    API_KEY: "e2ekey",
    CLIENT_ID: "e2e-client-id-fixed",  // avoid writing to .env
    SERVER_URL: `http://127.0.0.1:${port}`,
    AGENTSVIEW_BIN: fakeBin,
    NODE_OPTIONS: process.platform === "win32"
      ? appendNodeOption(process.env.NODE_OPTIONS, `--require=${quoteNodeOptionsValue(fakeScript)}`)
      : process.env.NODE_OPTIONS,
    REPORT_DAYS: "1",
    REPORT_DEV_STATS: "true",
    REPORT_SESSION_STATS: "true",
    // dotenv fills unset vars from .env, which would otherwise surface
    // the developer's real REPORT_MACHINE_CONFIG=true and invoke codex
    // / git from collectMachineConfig.
    REPORT_MACHINE_CONFIG: "false",
    EXTRA_CLAUDE_CONFIGS: "",
    EXTRA_CODEX_CONFIGS: "",
    EXTRA_PI_CONFIGS: "",
    EXTRA_OPENCODE_CONFIGS: "",
    OPENAI_ADMIN_KEY: "",
    TEAM: "e2e",
  };

  return {
    argvLog,
    baseEnv,
    getCaptured: () => captured,
    cleanup: () => {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// Preserve the user's .reporting-state.json and .env during this test —
// the reporter writes to both on a successful run.
let savedState = null;
let savedEnv = null;

before(() => {
  if (fs.existsSync(STATE_PATH)) {
    savedState = fs.readFileSync(STATE_PATH);
  }
  if (fs.existsSync(ENV_PATH)) {
    savedEnv = fs.readFileSync(ENV_PATH);
  }
});

after(() => {
  if (savedState !== null) fs.writeFileSync(STATE_PATH, savedState);
  else if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
  if (savedEnv !== null) fs.writeFileSync(ENV_PATH, savedEnv);
  else if (fs.existsSync(ENV_PATH)) fs.unlinkSync(ENV_PATH);
});

test("REPORT_DAYS=1 still invokes agentsview with --since 28d for session_stats", async () => {
  const ctx = await setupE2E({
    dailyJson:
      '{"daily":[{"date":"2026-04-23","modelBreakdowns":[{"modelName":"claude-sonnet-4-6","inputTokens":100,"outputTokens":50,"cacheCreationTokens":0,"cacheReadTokens":0}]}]}',
  });
  try {
    const result = await runReporter(ctx.baseEnv);
    assert.equal(
      result.status,
      0,
      `reporter exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const captured = ctx.getCaptured();
    assert.ok(captured, "server did not capture a POST body");

    const argvLines = fs.readFileSync(ctx.argvLog, "utf-8").trim().split("\n");
    const statsInvocations = argvLines.filter((l) => l.startsWith("stats\t"));
    assert.ok(
      statsInvocations.length >= 1,
      `expected at least one 'stats' invocation, got ${argvLines.join(" | ")}`,
    );
    for (const line of statsInvocations) {
      assert.match(
        line,
        /--since\t28d/,
        `stats invocation should use --since 28d, got: ${line}`,
      );
    }
    assert.equal(
      captured.session_stats?.window?.days_arg,
      "28d",
      "POSTed session_stats should reflect the 28d window that agentsview was asked for",
    );
    assert.equal(captured.report_days, 1);
  } finally {
    ctx.cleanup();
  }
});

test(".env USERNAME beats inherited OS USERNAME", async () => {
  const ctx = await setupE2E({ dailyJson: '{"daily":[]}' });
  const testEnv = [
    "USERNAME=dotenv-user",
    "API_KEY=dotenv-key",
    "CLIENT_ID=dotenv-client-id",
    "TEAM=dotenv-team",
  ].join("\n");
  fs.writeFileSync(ENV_PATH, `${testEnv}\n`);
  const env = { ...ctx.baseEnv, USERNAME: "windows-account-name" };
  delete env.TKMX_USERNAME;
  delete env.API_KEY;
  delete env.CLIENT_ID;
  delete env.TEAM;
  try {
    const result = await runReporter(env);
    assert.equal(
      result.status,
      0,
      `reporter exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const captured = ctx.getCaptured();
    assert.ok(captured, "server did not capture a POST body");
    assert.equal(captured.username, "dotenv-user");
    assert.equal(captured.team, "dotenv-team");
    assert.equal(captured.client_id, "dotenv-client-id");
  } finally {
    ctx.cleanup();
  }
});

// The profile is shared by every machine reporting under one username, so a
// field this machine hasn't configured must be left OUT of the POST (expressing
// no opinion) while a field it has configured is still sent. Each row writes a
// controlled .env first — dotenv fills unset vars from the repo's real .env,
// which on a developer machine carries their own profile and would otherwise
// mask an "unconfigured machine" regression.
const PROFILE_PROSE_KEYS = ["tools", "communities", "projects", "about", "hn_username", "demo_video_url"];
const MINIMAL_ENV = "USERNAME=e2euser\nAPI_KEY=e2ekey\nCLIENT_ID=e2e-client-id-fixed\n";
const MULTI_MACHINE_HINT = "Reporting from more than one machine?";
// The echo of what this machine just published. A configured field used to
// print nothing, so a forgotten machine's stale .env overwrote a corrected
// profile every cycle with no local trace. These rows pin both directions:
// what is configured is echoed (with its value, so a stale one is recognisable)
// and what is not configured is never echoed.
const PUBLISHED_HEADER = "Published from this machine's .env";

for (const tc of [
  {
    // Regression: these were posted unconditionally as `TOOLS || ""`, so a
    // machine with a blank .env — exactly what .env.example ships — sent six
    // empty strings over a profile configured elsewhere.
    name: "omits every key this machine hasn't configured",
    env: { TOOLS: "   " },  // whitespace-only counts as unconfigured
    present: {},
    absent: PROFILE_PROSE_KEYS,
    // Nothing is configured, so every nudge the loop emits fires here. Pinning
    // the strings is what stops the loop being deleted, or losing its
    // `!f.value` guard and nagging about configured fields, unnoticed.
    stdoutHas: [
      "Set TOOLS in .env",
      "Set PROJECTS in .env",
      "Set COMMUNITIES in .env",
      "Set ABOUT in .env",
      "Set DEMO_VIDEO_URL in .env",
      MULTI_MACHINE_HINT,
    ],
    // Nothing is configured, so this machine overwrites nothing and must not
    // claim it published anything. Without this the echo could degrade to
    // always-on and tell a deliberately-blank machine it is republishing.
    stdoutLacks: [PUBLISHED_HEADER],
  },
  {
    // hn_username was left out of the hint's condition twice, so a machine with
    // everything BUT it configured got no hint at all. A row where it is the
    // only blank field is the one that catches that; any row with something
    // else blank passes regardless. Doubles as the configured-and-trimmed case.
    name: "sends what is configured, trimmed; hint fires on hn_username alone",
    env: {
      TOOLS: "Sparkle.ai", PROJECTS: "tkmx", COMMUNITIES: "hn",
      ABOUT: "  padded on both sides  ", DEMO_VIDEO_URL: "https://youtu.be/x",
    },
    present: { tools: "Sparkle.ai", about: "padded on both sides" },
    absent: ["hn_username"],
    stdoutHas: [
      "Set HN_USERNAME in .env", MULTI_MACHINE_HINT,
      PUBLISHED_HEADER,
      // The value, not just the name: recognising a stale URL in this
      // machine's own log is the entire point of the echo.
      "DEMO_VIDEO_URL=https://youtu.be/x",
      "TOOLS=Sparkle.ai",
      // Echoed post-trim, so what is printed is what was sent.
      "ABOUT=padded on both sides",
    ],
    // The other half of the nudge contract: a configured field stops nagging.
    // Without this the loop can lose its `!f.value` guard and nag forever
    // about fields you've already set, with the suite still green.
    // The echo's negative half rides along: an unconfigured field is not sent,
    // so claiming it was published would be a lie about what this machine owns.
    stdoutLacks: ["Set TOOLS in .env", "HN_USERNAME=", "AVATAR="],
  },
  {
    // AVATAR is omitted-when-unset like the prose fields but lives outside
    // PROFILE_FIELDS, so it needs its own disjunct in the hint's condition.
    // Every PROFILE_FIELDS value is set here, so this is the only shape that
    // catches a missing one — any row with prose blank passes either way.
    name: "hint fires when AVATAR alone is unset",
    env: {
      TOOLS: "Sparkle.ai", PROJECTS: "tkmx", COMMUNITIES: "hn",
      ABOUT: "about me", DEMO_VIDEO_URL: "https://youtu.be/x", HN_USERNAME: "drodio", AVATAR: "",
    },
    present: {},
    absent: ["avatar_url"],
    stdoutHas: ["Set AVATAR in .env", MULTI_MACHINE_HINT],
  },
  {
    // The negative side of the same condition. Without this the disjunction
    // could degrade to always-true and nag every operator every two hours —
    // the exact thing the hint exists to avoid — with the suite still green.
    name: "hint stays quiet when nothing is left unset",
    env: {
      TOOLS: "Sparkle.ai", PROJECTS: "tkmx", COMMUNITIES: "hn",
      ABOUT: "about me", DEMO_VIDEO_URL: "https://youtu.be/x", HN_USERNAME: "drodio", AVATAR: "github:octocat",
    },
    present: { tools: "Sparkle.ai", avatar_url: "https://github.com/octocat.png?size=256" },
    absent: [],
    // AVATAR is echoed as the RESOLVED url actually sent, not the `github:`
    // shorthand — the profile is overwritten with the former, so that is the
    // value an operator needs to recognise.
    stdoutHas: [PUBLISHED_HEADER, "AVATAR=https://github.com/octocat.png?size=256"],
    stdoutLacks: [MULTI_MACHINE_HINT, "Set AVATAR in .env"],
  },
  {
    // The shape the bead was filed on: a machine whose ONLY profile opinion is
    // a demo video, carried by an .env nobody has looked at in months. Every
    // other row leaves something else configured, so this is the one that
    // catches an echo keyed to a field other than the one that reverted.
    name: "echoes a lone DEMO_VIDEO_URL, the field that reverted in the wild",
    env: { DEMO_VIDEO_URL: "https://youtu.be/67vGhYrCdrM" },
    present: { demo_video_url: "https://youtu.be/67vGhYrCdrM" },
    absent: ["tools", "about", "projects", "communities", "hn_username"],
    stdoutHas: [PUBLISHED_HEADER, "DEMO_VIDEO_URL=https://youtu.be/67vGhYrCdrM", MULTI_MACHINE_HINT],
    stdoutLacks: ["TOOLS=", "ABOUT="],
  },
]) {
  test(`profile prose payload — ${tc.name}`, async () => {
    const ctx = await setupE2E({ dailyJson: '{"daily":[]}' });
    fs.writeFileSync(ENV_PATH, MINIMAL_ENV);
    try {
      const result = await runReporter({ ...ctx.baseEnv, ...tc.env });
      assert.equal(
        result.status,
        0,
        `reporter exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      const captured = ctx.getCaptured();
      assert.ok(captured, "server did not capture a POST body");
      for (const [key, value] of Object.entries(tc.present)) {
        assert.equal(captured[key], value, `configured "${key}" must reach the server`);
      }
      for (const key of tc.absent) {
        assert.ok(
          !(key in captured),
          `unconfigured "${key}" must be absent, not sent as "" — an empty value expresses an opinion this machine doesn't have. Got: ${JSON.stringify(captured[key])}`,
        );
      }
      // The multi-machine hint must fire whenever ANY of these is blank — the
      // condition that was wrong twice — so pin it on stdout rather than
      // trusting a read of the code.
      for (const line of tc.stdoutHas) {
        assert.ok(result.stdout.includes(line), `stdout should contain "${line}".\nGot:\n${result.stdout}`);
      }
      for (const line of tc.stdoutLacks ?? []) {
        assert.ok(!result.stdout.includes(line), `stdout should NOT contain "${line}".\nGot:\n${result.stdout}`);
      }
      // Sanity: an otherwise-normal report, so this can't pass because the
      // reporter bailed out before building a body.
      assert.equal(captured.username, "e2euser");
      assert.deepEqual(captured.data, []);
    } finally {
      ctx.cleanup();
    }
  });
}

// AVATAR's payload wiring — resolved value in, unset omitted — is covered by
// the profile-prose rows above, which write a controlled .env first. What's
// left here is the malformed case, which can't be a row: it aborts the run.
test("a malformed AVATAR aborts before posting, without echoing its value", async () => {
  // Two contracts, one run, because a credential-bearing value exercises both.
  //
  // Fail-fast per REVIEW.md: a typo'd avatar is a config error the operator can
  // fix, and nothing is lost by stopping — `data` covers the last REPORT_DAYS,
  // so the next run after the fix re-sends the same window.
  //
  // And no-echo: stderr on an installed client is an unattended launchd/systemd
  // log, and a malformed value is exactly the case that can still carry a
  // password — `https://user:pw@` fails to parse and reaches the error path
  // with the secret intact.
  //
  // Which reason each malformed *form* produces is covered per-branch in
  // test/avatar.test.ts; what only an end-to-end run can show is that the
  // process stops, nothing is POSTed, and the value never reaches a log.
  const ctx = await setupE2E({ dailyJson: '{"daily":[]}' });
  try {
    const result = await runReporter({ ...ctx.baseEnv, AVATAR: "https://user:hunter2@" });
    assert.notEqual(result.status, 0, "reporter must exit non-zero on a malformed AVATAR");
    assert.equal(ctx.getCaptured(), null, "no POST may be sent when AVATAR is malformed");
    assert.match(result.stderr, /AVATAR is not a URL/i, `expected a generic reason, got:\n${result.stderr}`);
    assert.ok(
      !result.stderr.includes("hunter2") && !result.stdout.includes("hunter2"),
      `the AVATAR value leaked into the logs:\n${result.stderr}${result.stdout}`,
    );
  } finally {
    ctx.cleanup();
  }
});

test("inactive day (no usage rows) still posts and still refreshes session_stats", async () => {
  // Regression: the reporter used to early-return when mergedDaily was
  // empty, skipping session_stats / cursor_stats collection and the POST
  // itself. That meant rolling-window blobs could not decay on an
  // inactive REPORT_DAYS=1 day — stale data would linger on the profile
  // until the next day with activity.
  const ctx = await setupE2E({ dailyJson: '{"daily":[]}' });
  try {
    const result = await runReporter(ctx.baseEnv);
    assert.equal(
      result.status,
      0,
      `reporter exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const captured = ctx.getCaptured();
    assert.ok(
      captured,
      "server should still receive a POST on an inactive day so blob fields can decay",
    );
    assert.deepEqual(captured.data, [], "body.data should be the empty array");
    assert.ok(
      captured.session_stats,
      "session_stats should still be collected and sent on an inactive day",
    );
    assert.equal(
      captured.session_stats.window?.days_arg,
      "28d",
      "session_stats must still reflect the 28d window, not REPORT_DAYS=1",
    );
    // Sanity: stats invocation still happened despite no usage rows.
    const argvLines = fs.readFileSync(ctx.argvLog, "utf-8").trim().split("\n");
    assert.ok(
      argvLines.some((l) => l.startsWith("stats\t")),
      `expected at least one 'stats' invocation on an inactive day; got ${argvLines.join(" | ")}`,
    );
  } finally {
    ctx.cleanup();
  }
});

test("openclaw rows are present in the POST body when OPENCLAW_SESSIONS_DIRS points at fixtures", async () => {
  // Reuses the multi-root fixture tree from test/openclaw.test.ts (Task 4).
  // Expected aggregation (after responseId dedup across roots):
  //   2026-05-25 sonnet — input 150, output 15, total 165
  //   2026-05-26 opus   — input 200, output 20, total 220
  const ctx = await setupE2E({ dailyJson: '{"daily":[]}' });
  try {
    const fixturesRoot = path.join(__dirname, "fixtures", "openclaw");
    const result = await runReporter({
      ...ctx.baseEnv,
      // Wide window so the 2026-05-25/26 fixture dates always pass the sinceStr filter.
      REPORT_DAYS: "3650",
      OPENCLAW_SESSIONS_DIRS: [
        path.join(fixturesRoot, "root-a"),
        path.join(fixturesRoot, "root-b"),
      ].join(","),
    });
    assert.equal(
      result.status,
      0,
      `reporter exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const captured = ctx.getCaptured();
    assert.ok(captured, "server did not capture a POST body");

    const openclawRows = (captured as any).data.flatMap((d) =>
      d.modelBreakdowns
        .filter((m) => m.source === "openclaw")
        .map((m) => ({ ...m, date: d.date })),
    );
    assert.ok(
      openclawRows.length >= 2,
      `expected at least 2 openclaw rows in POST body, got ${openclawRows.length}: ${JSON.stringify(openclawRows)}`,
    );

    const sonnet = openclawRows.find(
      (m) => m.date === "2026-05-25" && m.modelName === "anthropic/claude-sonnet-4-6",
    );
    assert.ok(sonnet, `missing sonnet row for 2026-05-25 in: ${JSON.stringify(openclawRows)}`);
    assert.equal(sonnet.inputTokens, 150);
    assert.equal(sonnet.outputTokens, 15);
    assert.equal(sonnet.totalTokens, 165);

    const opus = openclawRows.find(
      (m) => m.date === "2026-05-26" && m.modelName === "anthropic/claude-opus-4-7",
    );
    assert.ok(opus, `missing opus row for 2026-05-26 in: ${JSON.stringify(openclawRows)}`);
    assert.equal(opus.totalTokens, 220);
  } finally {
    ctx.cleanup();
  }
});

// EXTRA_{CLAUDE,CODEX,PI,OPENCODE}_CONFIGS are comma-separated home lists routed through
// the same descriptor map in report.ts. For EACH agent's descriptor, every
// configured home's usage must sum into THAT agent's source (colliding
// (date,model,source) rows sum, not drop — see mergeDailyUsage), without
// bleeding into the other sources. Two homes per case guard a first-entry-only
// undercount (the real multi-account use case); one matrix over all agents
// guards every descriptor's subdir + env-var wiring against drift.
for (const tc of [
  { agent: "codex", envVar: "EXTRA_CODEX_CONFIGS", subdir: "sessions", subdirEnvKey: "CODEX_SESSIONS_DIR", source: "codex" },
  { agent: "claude", envVar: "EXTRA_CLAUDE_CONFIGS", subdir: "projects", subdirEnvKey: "CLAUDE_PROJECTS_DIR", source: "claude" },
  { agent: "pi", envVar: "EXTRA_PI_CONFIGS", subdir: ".", subdirEnvKey: "PIEBALD_DIR", source: "pi" },
  { agent: "opencode", envVar: "EXTRA_OPENCODE_CONFIGS", subdir: ".", subdirEnvKey: "OPENCODE_DIR", source: "opencode" },
]) {
  test(`${tc.envVar} sums every configured home's usage into the ${tc.source} source, scanning each right home`, async () => {
    const ctx = await setupE2E({
      dailyJson:
        '{"daily":[{"date":"2026-05-25","modelBreakdowns":[{"modelName":"gpt-5.5","inputTokens":1000,"outputTokens":100,"cacheCreationTokens":0,"cacheReadTokens":0}]}]}',
    });
    const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tkmx-${tc.agent}-`));
    const homeA = path.join(extraRoot, "home-a");
    const homeB = path.join(extraRoot, "home-b");
    const sourcePath = (home: string) => tc.subdir === "." ? home : path.join(home, tc.subdir);
    fs.mkdirSync(sourcePath(homeA), { recursive: true });
    fs.mkdirSync(sourcePath(homeB), { recursive: true });
    try {
      const result = await runReporter({
        ...ctx.baseEnv,
        REPORT_DAYS: "3650", // wide window so the fixture date passes the sinceStr filter
        [tc.envVar]: `${homeA},${homeB}`,
      });
      assert.equal(
        result.status,
        0,
        `reporter exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      const captured = ctx.getCaptured();
      assert.ok(captured, "server did not capture a POST body");

      const day = (captured as any).data.find((d) => d.date === "2026-05-25");
      assert.ok(day, `missing 2026-05-25 in POST data: ${JSON.stringify((captured as any).data)}`);

      // Local (1000) + two valid extra homes (1000 each) sum on the same
      // (date, gpt-5.5, <source>) row → 3000; a first-entry-only bug gives 2000.
      const row = day.modelBreakdowns.find((m) => m.source === tc.source && m.modelName === "gpt-5.5");
      assert.ok(row, `missing ${tc.source} gpt-5.5 row: ${JSON.stringify(day.modelBreakdowns)}`);
      assert.equal(row.inputTokens, 3000, `every configured extra ${tc.agent} home must sum into the ${tc.source} stream`);
      assert.equal(row.outputTokens, 300);
      assert.equal(row.totalTokens, 3300);

      // The extra homes must not bleed into the other sources (only their local scans).
      for (const source of ["claude", "codex", "pi", "opencode"].filter((source) => source !== tc.source)) {
        const localOnlyRow = day.modelBreakdowns.find((m) => m.source === source && m.modelName === "gpt-5.5");
        assert.ok(localOnlyRow, `expected a ${source}-source row from the local scan`);
        assert.equal(localOnlyRow.inputTokens, 1000, `extra ${tc.agent} homes must not be counted under ${source}`);
      }

      // The merge total alone can't prove the reporter scanned the *right* homes
      // (a wrong-path scan that still returned 1000 would also sum). Assert
      // agentsview was invoked for this agent with its env key at BOTH homes.
      const argvLines = fs.readFileSync(ctx.argvLog, "utf-8").trim().split("\n");
      const usageCalls = argvLines.filter((l) => l.startsWith("usage\t") && l.includes(`--agent\t${tc.agent}`));
      for (const home of [homeA, homeB]) {
        assert.ok(
          usageCalls.some((l) => l.includes(`${tc.subdirEnvKey}=${sourcePath(home)}`)),
          `expected a ${tc.agent} usage call with ${tc.subdirEnvKey}=${sourcePath(home)}, got:\n${usageCalls.join("\n")}`,
        );
      }
    } finally {
      fs.rmSync(extraRoot, { recursive: true, force: true });
      ctx.cleanup();
    }
  });
}

// Local agents come from the index, so an agent present only as a configured
// extra home isn't discovered — the reporter unions the two. Without that, a
// machine that runs codex solely through EXTRA_CODEX_CONFIGS would silently
// report nothing for it.
test("an extra home is collected for an agent with no local sessions", async () => {
  const ctx = await setupE2E({
    dailyJson:
      '{"daily":[{"date":"2026-05-25","modelBreakdowns":[{"modelName":"gpt-5.5","inputTokens":1000,"outputTokens":100,"cacheCreationTokens":0,"cacheReadTokens":0}]}]}',
    indexAgents: ["claude"],
  });
  const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-union-"));
  fs.mkdirSync(path.join(extraRoot, "sessions"), { recursive: true });
  try {
    const result = await runReporter({
      ...ctx.baseEnv,
      REPORT_DAYS: "3650",
      EXTRA_CODEX_CONFIGS: extraRoot,
    });
    assert.equal(result.status, 0, `reporter exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const captured = ctx.getCaptured();
    const day = captured.data.find((d) => d.date === "2026-05-25");
    const codexRow = day.modelBreakdowns.find((m) => m.source === "codex");
    assert.ok(codexRow, "codex reached the payload only via its configured extra home");
    assert.equal(codexRow.inputTokens, 1000);
  } finally {
    fs.rmSync(extraRoot, { recursive: true, force: true });
    ctx.cleanup();
  }
});

// Fail-loud posture: a home the operator explicitly configured but that can't
// be collected must abort before POST, not be silently omitted from a
// successful report — the silent-undercount class that left usage unreported
// for weeks. Both failure triggers exercise distinct branches of
// collectExtraAgentsviewHomes (missing-subdir throw vs the catch→rethrow when
// a valid home's agentsview call fails); same guarantee, so one matrix.
for (const tc of [
  {
    agent: "codex",
    envVar: "EXTRA_CODEX_CONFIGS",
    subdir: "sessions",
    subdirEnvKey: "CODEX_SESSIONS_DIR",
    missingName: "missing sessions/ subdir",
    missingPattern: /missing sessions\/ subdir/i,
  },
  {
    agent: "pi",
    envVar: "EXTRA_PI_CONFIGS",
    subdir: ".",
    subdirEnvKey: "PIEBALD_DIR",
    missingName: "missing configured directory",
    missingPattern: /missing directory/i,
  },
  {
    agent: "opencode",
    envVar: "EXTRA_OPENCODE_CONFIGS",
    subdir: ".",
    subdirEnvKey: "OPENCODE_DIR",
    missingName: "missing configured directory",
    missingPattern: /missing directory/i,
  },
]) {
  for (const mode of [
    { name: tc.missingName, makeSource: false, failUsage: false, expectStderr: tc.missingPattern },
    { name: "agentsview usage call fails for a valid home", makeSource: true, failUsage: true, expectStderr: /usage collection failed/i },
  ]) {
    test(`a configured ${tc.envVar} home aborts the run with no POST when it can't be collected - ${mode.name}`, async () => {
      const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tkmx-${tc.agent}-bad-`));
      const home = path.join(extraRoot, `${tc.agent}-account-broken`);
      const sourcePath = tc.subdir === "." ? home : path.join(home, tc.subdir);
      if (mode.makeSource) fs.mkdirSync(sourcePath, { recursive: true });
      else if (tc.subdir !== ".") fs.mkdirSync(home, { recursive: true });
      const ctx = await setupE2E({
        dailyJson:
          '{"daily":[{"date":"2026-05-25","modelBreakdowns":[{"modelName":"gpt-5.5","inputTokens":1000,"outputTokens":100,"cacheCreationTokens":0,"cacheReadTokens":0}]}]}',
        failUsageEnvKey: mode.failUsage ? tc.subdirEnvKey : "",
        failUsageEnvValue: mode.failUsage ? sourcePath : "",
      });
      try {
        const result = await runReporter({
          ...ctx.baseEnv,
          REPORT_DAYS: "3650",
          [tc.envVar]: home,
        });
        assert.notEqual(result.status, 0, "reporter must exit non-zero when a configured home can't be collected");
        assert.equal(ctx.getCaptured(), null, "no POST may be sent when a configured extra home can't be collected");
        assert.match(result.stderr, new RegExp(`${tc.agent}-account-broken`, "i"), `expected fatal error naming the home, got stderr:\n${result.stderr}`);
        assert.match(result.stderr, mode.expectStderr, `expected the ${mode.name} branch's error message, got stderr:\n${result.stderr}`);
      } finally {
        fs.rmSync(extraRoot, { recursive: true, force: true });
        ctx.cleanup();
      }
    });
  }
}

test("legacy reporter/report.js compat shim forwards to the compiled reporter", async () => {
  // Pre-TypeScript installs wrote launchd/systemd units pointing at
  // <repo>/reporter/report.js. The migration replaced that file with a
  // shim that requires ../dist/reporter/report.js. This test guards the
  // shim path: an accidental deletion or a wrong relative require would
  // break every pre-migration daemon silently after `git pull`.
  const ctx = await setupE2E({
    dailyJson:
      '{"daily":[{"date":"2026-04-23","modelBreakdowns":[{"modelName":"claude-sonnet-4-6","inputTokens":42,"outputTokens":17,"cacheCreationTokens":0,"cacheReadTokens":0}]}]}',
  });
  try {
    const result = await runReporter(ctx.baseEnv, 30000, LEGACY_SHIM);
    assert.equal(
      result.status,
      0,
      `shim exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const captured = ctx.getCaptured();
    assert.ok(captured, "server should receive a POST when invoked through the shim");
    assert.equal(captured.username, "e2euser", "POST body should reflect the shim's forwarded run");
  } finally {
    ctx.cleanup();
  }
});

test("a frozen profile does not consume the one-shot transition markers", async () => {
  // The !profile_frozen branch decides whether BOTH delivery records get
  // written, and nothing else reaches it: the stub answers { ok: true } for
  // every other test, and reporting-state.test.ts exercises the gate primitive,
  // which never sees a response.
  //
  // The failure is silent by construction. clear_dev_stats and session_stats
  // fire only on the local prior→current edge, so recording that edge against a
  // server that ignored the payload consumes the signal for good — the profile
  // keeps serving stale stats and nothing logs an error. Moving saveState back
  // outside the guard must fail here.
  const ctx = await setupE2E({
    dailyJson: '{"daily":[]}',
    responseJson: { ok: true, profile_frozen: true },
  });
  try {
    if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);

    const result = await runReporter(ctx.baseEnv);
    assert.equal(
      result.status,
      0,
      `reporter exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.ok(ctx.getCaptured(), "the report is still sent to a frozen profile");
    assert.equal(
      fs.existsSync(STATE_PATH),
      false,
      "reporting state was recorded against a server that declined to apply it, " +
        "so the next run will treat the transition as already delivered",
    );
    // This run is the only one in the suite that reaches the frozen-profile
    // notice, and a cycle that delivers nothing must not also be silent.
    assert.match(
      result.stdout,
      /stay on its last snapshot/,
      `a frozen profile left the operator no indication the report was not applied:\n${result.stdout}`,
    );
  } finally {
    ctx.cleanup();
  }
});
