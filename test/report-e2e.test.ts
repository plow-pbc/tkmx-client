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

// Builds a temp fake-agentsview bash script. `dailyJson` is the value the
// `usage` subcommand echoes — either a row for the "activity" scenario or
// `{"daily":[]}` for the inactive scenario. The script also logs its argv
// to argvLog so tests can inspect the --since windows.
function writeFakeAgentsview(fakeBin, argvLog, dailyJson, failCodexSessionsDir = "") {
  if (process.platform === "win32") {
    fs.writeFileSync(
      fakeBin,
      `const fs = require("fs");
const path = require("path");
const args = process.argv.slice(1);
const cmd = path.basename(args[0] || "");
if (cmd !== "usage" && cmd !== "stats") return;
args[0] = cmd;
const envCols = ["CODEX_SESSIONS_DIR", "CLAUDE_PROJECTS_DIR", "AGENT_VIEWER_DATA_DIR"].map((k) => k + "=" + (process.env[k] || ""));
fs.appendFileSync(${JSON.stringify(argvLog)}, args.concat(envCols).join("\\t") + "\\n");
if (cmd === "usage") {
  if (${JSON.stringify(failCodexSessionsDir)} && process.env.CODEX_SESSIONS_DIR === ${JSON.stringify(failCodexSessionsDir)}) {
    process.stderr.write("agentsview: simulated usage failure for " + process.env.CODEX_SESSIONS_DIR + "\\n");
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

  fs.writeFileSync(
    fakeBin,
    `#!/usr/bin/env bash
printf '%s\\t' "$@" >> "${argvLog}"
printf 'CODEX_SESSIONS_DIR=%s\\tCLAUDE_PROJECTS_DIR=%s\\tAGENT_VIEWER_DATA_DIR=%s\\t' "$CODEX_SESSIONS_DIR" "$CLAUDE_PROJECTS_DIR" "$AGENT_VIEWER_DATA_DIR" >> "${argvLog}"
printf '\\n' >> "${argvLog}"
case "$1" in
  --version)
    echo "agentsview v0.25.0 (commit abcdef1, built 2026-04-24T00:00:00Z)"
    ;;
  usage)
    if [ -n '${failCodexSessionsDir}' ] && [ "$CODEX_SESSIONS_DIR" = '${failCodexSessionsDir}' ]; then
      echo "agentsview: simulated usage failure for $CODEX_SESSIONS_DIR" >&2
      exit 2
    fi
    echo '${dailyJson.replace(/'/g, "'\\''")}'
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
async function setupE2E({ dailyJson, failCodexSessionsDir = "" }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-e2e-"));
  const argvLog = path.join(tmp, "argv.log");
  const fakeScript = path.join(tmp, process.platform === "win32" ? "fake-agentsview-preload.cjs" : "fake-agentsview");
  writeFakeAgentsview(fakeScript, argvLog, dailyJson, failCodexSessionsDir);
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
      res.end(JSON.stringify({ ok: true }));
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
      ? `${process.env.NODE_OPTIONS || ""} --require=${fakeScript}`.trim()
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

test("EXTRA_CODEX_CONFIGS sums every configured home's codex usage into the POST, scanning each right home", async () => {
  // The reviewer's bot Codex accounts live in separate homes
  // (docker/secrets/codex-account-*), outside the local ~/.codex agentsview
  // scans by default. EXTRA_CODEX_CONFIGS is a comma-separated list; EACH
  // valid home's codex usage must sum into the codex source — colliding
  // (date,model,source) rows must sum, not drop (see mergeDailyUsage). Two
  // homes here guard against a first-entry-only regression undercounting the
  // real multi-account use case.
  const ctx = await setupE2E({
    dailyJson:
      '{"daily":[{"date":"2026-05-25","modelBreakdowns":[{"modelName":"gpt-5.5","inputTokens":1000,"outputTokens":100,"cacheCreationTokens":0,"cacheReadTokens":0}]}]}',
  });
  const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-codex-"));
  const homeA = path.join(extraRoot, "codex-account-a");
  const homeB = path.join(extraRoot, "codex-account-b");
  fs.mkdirSync(path.join(homeA, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(homeB, "sessions"), { recursive: true });
  try {
    const result = await runReporter({
      ...ctx.baseEnv,
      REPORT_DAYS: "3650", // wide window so the fixture date passes the sinceStr filter
      EXTRA_CODEX_CONFIGS: `${homeA},${homeB}`,
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

    // Local ~/.codex (1000) + two valid extra homes (1000 each) sum on the same
    // (date, gpt-5.5, codex) row → 3000; a first-entry-only bug would give 2000.
    const codexRow = day.modelBreakdowns.find((m) => m.source === "codex" && m.modelName === "gpt-5.5");
    assert.ok(codexRow, `missing codex gpt-5.5 row: ${JSON.stringify(day.modelBreakdowns)}`);
    assert.equal(codexRow.inputTokens, 3000, "every configured extra codex home must sum into the codex stream");
    assert.equal(codexRow.outputTokens, 300);
    assert.equal(codexRow.totalTokens, 3300);

    // The extra-codex homes must not bleed into the claude source.
    const claudeRow = day.modelBreakdowns.find((m) => m.source === "claude" && m.modelName === "gpt-5.5");
    assert.ok(claudeRow, "expected a claude-source row from the local scan");
    assert.equal(claudeRow.inputTokens, 1000, "extra codex homes must not be counted under claude");

    // The merge total alone can't prove the reporter scanned the *right* homes
    // (a wrong-path scan that still returned 1000 would also sum). Assert
    // agentsview was invoked for codex with CODEX_SESSIONS_DIR at BOTH homes.
    const argvLines = fs.readFileSync(ctx.argvLog, "utf-8").trim().split("\n");
    const codexUsageCalls = argvLines.filter((l) => l.startsWith("usage\t") && l.includes("--agent\tcodex"));
    for (const home of [homeA, homeB]) {
      assert.ok(
        codexUsageCalls.some((l) => l.includes(`CODEX_SESSIONS_DIR=${path.join(home, "sessions")}`)),
        `expected a codex usage call with CODEX_SESSIONS_DIR=${path.join(home, "sessions")}, got:\n${codexUsageCalls.join("\n")}`,
      );
    }
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
  { name: "missing sessions/ subdir", makeSessions: false, failUsage: false, expectStderr: /missing sessions\/ subdir/i },
  { name: "agentsview usage call fails for a valid home", makeSessions: true, failUsage: true, expectStderr: /usage collection failed/i },
]) {
  test(`a configured EXTRA_CODEX_CONFIGS home aborts the run with no POST when it can't be collected — ${tc.name}`, async () => {
    const extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-codex-bad-"));
    const home = path.join(extraRoot, "codex-account-broken");
    fs.mkdirSync(tc.makeSessions ? path.join(home, "sessions") : home, { recursive: true });
    const ctx = await setupE2E({
      dailyJson:
        '{"daily":[{"date":"2026-05-25","modelBreakdowns":[{"modelName":"gpt-5.5","inputTokens":1000,"outputTokens":100,"cacheCreationTokens":0,"cacheReadTokens":0}]}]}',
      failCodexSessionsDir: tc.failUsage ? path.join(home, "sessions") : "",
    });
    try {
      const result = await runReporter({
        ...ctx.baseEnv,
        REPORT_DAYS: "3650",
        EXTRA_CODEX_CONFIGS: home,
      });
      assert.notEqual(result.status, 0, "reporter must exit non-zero when a configured home can't be collected");
      assert.equal(ctx.getCaptured(), null, "no POST may be sent when a configured extra home can't be collected");
      assert.match(result.stderr, /codex-account-broken/i, `expected a fatal error naming the home, got stderr:\n${result.stderr}`);
      assert.match(result.stderr, tc.expectStderr, `expected the ${tc.name} branch's error message, got stderr:\n${result.stderr}`);
    } finally {
      fs.rmSync(extraRoot, { recursive: true, force: true });
      ctx.cleanup();
    }
  });
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
