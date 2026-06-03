# Tokenmaxxing Client

Reports your Claude Code and Codex token usage to the [Tokenmaxxing Leaderboard](https://tokenmaxxing.odio.dev). Each user gets a shareable profile page at `tokenmaxxing.odio.dev/user/YOUR_NAME`.

## Quick Start

```bash
# Install agentsview (required). See https://agentsview.io/quickstart/ for
# platform-specific install; the canonical one-liner is:
curl -fsSL https://agentsview.io/install.sh | bash

git clone git@github.com:srosro/tkmx-client.git
cd tkmx-client && npm install
cp .env.example .env              # then edit .env (see below)
npm run report                    # test it
npm run install-service           # auto-report every 2 hours
```

> New to the client or upgrading from v1.x? See [Upgrading from v1.x](#upgrading-from-v1x) for the `v1.2.0` pinning option if you can't install agentsview.

## Setup

### 1. Install dependencies

[agentsview](https://www.agentsview.io/token-usage/) is required — it reads your local Claude Code and Codex usage data from an incrementally-synced SQLite index, which is dramatically faster than walking every JSONL transcript.

**macOS / Linux:**

```bash
curl -fsSL https://agentsview.io/install.sh | bash
```

**Windows:**

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://agentsview.io/install.ps1 | iex"
```

The installer drops the binary in `~/.local/bin/agentsview` by default. If you install somewhere else (nix, asdf, custom prefix), set `AGENTSVIEW_BIN=/path/to/agentsview` in your `.env` and tkmx-client will use that. See https://agentsview.io/quickstart/ for more. Codex CLI usage is auto-detected from `~/.codex/` — no extra setup beyond agentsview.

> **Previously using ccusage?** v1.x of this client used `ccusage`. If you prefer the old flow and don't want to install agentsview, pin to the v1.2.0 tag:
>
> ```bash
> cd tkmx-client
> git checkout v1.2.0
> npm install
> ```
>
> See [Upgrading from v1.x](#upgrading-from-v1x) for details.

### 2. Clone and install

```
git clone git@github.com:srosro/tkmx-client.git
cd tkmx-client
npm install        # installs deps + builds dist/ (runs `npm run build` via prepare hook)
```

> **Build:** the source is TypeScript; runtime ships compiled JS from `dist/`. `npm install` triggers the build automatically. To rebuild manually: `npm run build`. The launchd plist / systemd unit written by `install-service` points at `dist/reporter/report.js`, so end-user machines need only Node — no global TypeScript install required.

### 3. Register your username

Pick a unique username and provide your email. First come, first served.

```
curl -s -X POST https://tokenmaxxing.odio.dev/api/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"YOUR_NAME", "email":"you@example.com"}'
```

Save the returned API key — it cannot be retrieved later.

> Email is required at registration but kept private. It is never displayed or returned by any API.

### 4. Configure `.env`

```
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `USERNAME` | Yes | Your registered username |
| `API_KEY` | Yes | The key returned by `/api/register` |
| `TEAM` | No | Your team name (default: `default`) |
| `TOOLS` | No | What AI coding tools do you actually use daily? (see [Tools, Projects & Communities](#tools-projects--communities)) |
| `PROJECTS` | No | What are you spending tokens on? The projects you're actively building with AI. |
| `COMMUNITIES` | No | What developer communities are you part of? |
| `ABOUT` | No | The main content of your profile — describe your setup, link to tools you use, share blog posts/videos about your workflow. URLs are auto-linked. See [Profile Page](#profile-page) |
| `DEMO_VIDEO_URL` | No | YouTube URL (**3 min or shorter**) showing your before/after AI coding workflow. Embedded on your profile page under "3-MIN DEMO VIDEO". |
| `HN_USERNAME` | No | Your Hacker News username (e.g. `Sam_Odio`). Required to appear on the leaderboard — see [HN Verification](#appearing-on-the-leaderboard-hn-verification) |
| `OPENCLAW_SESSIONS_DIRS` | No | Override OpenClaw auto-discovery with a comma-separated list of session directories. Defaults to auto-discovery of standalone + Plow variants on macOS. See [OpenClaw Usage](#openclaw-usage). |
| `REPORT_DAYS` | No | Days of history to report (default: `28`). See [Backfill & Optimization](#backfill--optimization) |
| `REPORT_MACHINE_CONFIG` | No | Set to `true` to share machine info (OS, CPU, memory, installed skills, MCP servers, hooks, CLAUDE.md stats, shell/editor) on your profile. No prompts, code, or keys are ever sent. |
| `REPORT_DEV_STATS` | No | Set to `true` to share how you code — tool-call frequencies, session stats, cache efficiency, git outcome metrics (commits/LOC/PRs), and Cursor AI attribution. No file paths, prompts, or code are ever sent. See [Dev Stats](#dev-stats). |
| `REPORT_SESSION_STATS` | No | Defaults to `true` when `REPORT_DEV_STATS=true`. Shells out to `agentsview stats --format json` to collect cross-agent session analytics (portfolio, archetype, velocity, temporal patterns, cache economics). Set to `false` to opt out — on the next report the server will clear your stored session_stats blob. The opt-out marker is tracked per-checkout in `.reporting-state.json`, so if you flip the toggle in one sibling checkout the clear signal only fires from that checkout's reporter. |

### 5. First run

```
npm run report
```

```
[2026-04-08T12:30:40.544Z] Collecting 28d usage since 20260311 for your-name (team: your-team)
  Claude: 23 days
  Codex: 5 days
[2026-04-08T12:30:44.237Z] Server responded 200: {"ok":true,"rows":56}
```

A `CLIENT_ID` is auto-generated on first run and saved to `.env`. This identifies your machine so multiple machines can report for the same username without overwriting each other.

> **⚠ Don't touch `CLIENT_ID` once it's set.** Usage rows are keyed on `(username, date, model, client_id, source)` server-side. If you delete `.env`, re-clone into a new directory, or paste a fresh `.env` that omits the line, a new id is generated and the server treats your machine as brand new — the old id's rows stay behind and every overlapping date gets double-counted on your profile. When updating, always `git pull` in place rather than re-cloning. If you must re-clone, copy `CLIENT_ID` from the old `.env` first.

### 6. Install the background service

```
npm run install-service
```

Uses **launchd** on macOS, **systemd** on Linux. Starts immediately, survives reboots, runs every 2 hours.

Verify it's running:

```bash
# macOS
launchctl list | grep token-tracking

# Linux
systemctl --user status token-tracking-reporter.timer
```

## Updating

```bash
cd tkmx-client
git pull
npm install        # rebuilds dist/ via the prepare hook
```

Your existing config (credentials, `CLIENT_ID`) is preserved — `git pull` never touches `.env`. **Do not re-clone or delete `.env` as an "update" — see the CLIENT_ID warning in [First run](#5-first-run).**

> **Pre-TypeScript installs:** if your launchd plist or systemd unit was installed before the TypeScript migration, it still points at `reporter/report.js`. A compatibility shim at that path forwards to the compiled `dist/reporter/report.js`, so the daemon keeps working. To get a clean unit pointing at `dist/` directly, re-run `npm run install-service` once after this update — the shim can then be removed in a future release.

### What's new

If you're updating an existing install, refer to the config table above and add any new `.env` values you don't already have:

| Setting | What it does |
|---------|-------------|
| `REPORT_MACHINE_CONFIG=true` | Shares your machine setup (OS, CPU, memory, installed skills) on your [profile page](#profile-page). **No prompts, code, conversation history, or API keys are ever sent.** |
| `PROJECTS=tkmx,plow.co` | Projects you're building. Shown as badges on your profile and leaderboard. |
| `COMMUNITIES=bloomberg-ai-engineering,agentcribs-community` | Developer communities you're part of. Shown as badges on your profile and leaderboard. |
| `ABOUT="..."` | Bio, config details, and links shown on your profile. Share your setup — blog posts, tweets, or videos where you've discussed your workflow. URLs are auto-linked. |
| `REPORT_DAYS=1` | Only send the last day of new token-usage rows each cycle instead of 28. Session stats, Cursor stats, and other rolling-window aggregates always carry a fixed 28-day window and are unaffected. Recommended after your first sync. |
| `DEMO_VIDEO_URL=https://www.youtube.com/watch?v=...` | YouTube demo video (**3 min or shorter**) embedded on your profile. Show before/after workflows — how you worked before AI tools vs. after. |
| `HN_USERNAME=Sam_Odio` | Your Hacker News username. Required for leaderboard visibility — see [HN Verification](#appearing-on-the-leaderboard-hn-verification). |
| `REPORT_DEV_STATS=true` | Shares how you code — tool frequencies, session stats, cache efficiency, git outcomes, Cursor attribution. See [Dev Stats](#dev-stats). |

`CLIENT_ID` is auto-generated on first run and written to `.env` — you don't need to set it. If you already have one, it's kept as-is.

## Upgrading from v1.x

> **⚠️ BREAKING in v1.3.0:** agentsview is now a **hard dependency**. If you don't have it installed, `npm run report` will exit with an install-or-pin message on first run. This is technically a breaking change under SemVer — we kept it as a minor bump because the user pool is small, the fix is a one-line install, and the pin path to `v1.2.0` is explicit and supported.

v1.3.0 replaces `ccusage` + the direct codex sqlite reader with [agentsview](https://www.agentsview.io/token-usage/) for all local Claude and Codex token collection. `EXTRA_CLAUDE_CONFIGS` / `EXTRA_CODEX_CONFIGS` — the features for aggregating usage from extra `~/.claude` / `~/.codex` homes — also go through agentsview (each creates a per-home sqlite under `~/.agentsview-tkmx/<hash>/` for isolated incremental sync).

### Why upgrade?

1. **Correct codex token counts.** v1.x's `~/.codex/state_*.sqlite` reader was silently dropping cache-read tokens. Expect your **codex `total_tokens` to jump ~+90%** on active codex machines (Claude numbers are unaffected). This is agentsview counting tokens that were always being spent but never appearing in your reports — **a correction, not inflation.** Nothing is double-counted.
2. **Accurate cost.** agentsview computes per-field cost via LiteLLM and the server respects it, so codex dollar figures on your profile go from server-side blended estimates to actual per-model rates.
3. **~200× faster** on large histories via agentsview's incremental SQLite sync, instead of walking every JSONL transcript on every run.
4. **Bonus: free session viewer.** You now have `agentsview` installed — run `agentsview` in a terminal and you get a full local web UI for browsing and full-text-searching every Claude + Codex session you've ever had. It's a real product, not a data-access tool. See https://agentsview.io for the full feature set.
5. **Single install story going forward.** One dependency to install, not "ccusage or codex-sqlite-reader depending on which flag you set."

**If you can install agentsview:** `git pull`, install agentsview, run `npm run report`. That's it — existing `.env` settings are unchanged. The `USE_AGENTSVIEW` flag and `CCUSAGE_TIMEOUT_MS` are gone (delete them from your `.env` if present — they're ignored).

**If you can't or don't want to install agentsview:** pin to the last ccusage-based release. This is a real, working version — it will stay reachable:

```bash
cd tkmx-client
git checkout v1.2.0
npm install
npm run report
```

You lose access to future improvements, but the v1.2.0 flow (ccusage + codex sqlite) continues to work against the server.

## Backfill & Optimization

By default the reporter sends 28 days of history. To backfill older data or optimize steady-state reporting:

**Backfill** — set `REPORT_DAYS=365` in `.env` and run once:

```bash
npm run report
```

**Optimize** — after your initial sync, change to `REPORT_DAYS=1` in `.env` so the background service only re-sends the last day of token-usage rows each cycle instead of 28 days every 2 hours. Session stats (agent portfolio, temporal patterns, streaks) and Cursor stats always ship their full 28-day window regardless — they're wholesale-replaced on the server, so a short window would scrub prior history.

You can always do a manual full re-sync of the token-usage rows by temporarily setting `REPORT_DAYS=28` and running `npm run report`.

## Multiple Machines

The client supports reporting from multiple machines under the same username. Each machine gets its own `CLIENT_ID` (auto-generated on first run), and the server tracks data per-machine. Setup on each machine is identical — just use the same `USERNAME`, `API_KEY`, and `TEAM` in `.env`.

Your [profile page](https://tokenmaxxing.odio.dev) shows how many machines you're reporting from.

### Aggregating from synced remote machines

If you already sync `~/.claude` from other machines to a central location (e.g. via rsync, Syncthing, or a tool like [engineering-notebook](https://github.com/obra/engineering-notebook)), you can aggregate all of them into a single report without installing the client on each machine. Set `EXTRA_CLAUDE_CONFIGS` in `.env` to a comma-separated list of directories, each containing a `projects/` subdirectory of Claude Code JSONL sessions:

```
EXTRA_CLAUDE_CONFIGS=/path/to/synced-laptop,/path/to/synced-desktop
```

The reporter runs `agentsview` once per directory (each with its own `AGENT_VIEWER_DATA_DIR` under `~/.agentsview-tkmx/<hash>/` and `CLAUDE_PROJECTS_DIR` pointing at `<dir>/projects`) and merges the results with the local machine's usage before submitting. Each remote mirror gets its own incrementally-synced sqlite, so re-runs are cheap.

The Codex equivalent is `EXTRA_CODEX_CONFIGS` — a comma-separated list of Codex homes, each containing a `sessions/` subdirectory (the `~/.codex` layout). Use it to fold in Codex accounts whose data lives outside the local `~/.codex`, e.g. a reviewer bot's per-account homes. It works the same way (one `agentsview` run per home, isolated `AGENT_VIEWER_DATA_DIR`, `CODEX_SESSIONS_DIR` pointing at `<home>/sessions`) and its usage sums into the `codex` source. A configured home that can't be collected — missing `sessions/`, or any agentsview failure — aborts the run rather than POSTing a silent partial; fix the path in `.env` and the next run recovers.

```
EXTRA_CODEX_CONFIGS=/path/to/codex-account-a,/path/to/codex-account-b
```

## OpenAI Platform Usage

If you make OpenAI API calls directly (not through Codex CLI), you can pull token usage from `platform.openai.com/usage` and merge it into your reports. This covers any OpenAI API usage — your own scripts, agents, third-party tools authenticated with your API keys, etc.

1. Create an admin API key at [platform.openai.com/settings/organization/admin-keys](https://platform.openai.com/settings/organization/admin-keys) (must be an Organization Owner). Regular project keys won't work — the org usage endpoint requires an admin key.
2. Add it to `.env`:
   ```
   OPENAI_ADMIN_KEY=sk-admin-...
   ```
3. Run `npm run report`. You'll see a new `OpenAI platform` line in the output.

The client only *reads* usage data; it never sends your admin key anywhere except `api.openai.com`. Reports use the `/v1/organization/usage/completions` endpoint, which covers chat completions and the Responses API — essentially all OpenAI token volume for most users.

> **⚠️ Don't double-count Codex CLI:** If your Codex CLI is authenticated with an OpenAI API key (rather than a ChatGPT Plus/Pro subscription), its traffic already appears in platform usage. Enabling `OPENAI_ADMIN_KEY` alongside Codex collection will double-count those tokens. Leave `OPENAI_ADMIN_KEY` unset if Codex is on API-key auth.

## OpenClaw Usage

If you run [OpenClaw](https://openclaw.ai) sessions locally — standalone or wrapped by [Plow](https://plow.co) on macOS — token usage is read directly from session JSONL transcripts and merged into your reports under the `openclaw` source. No setup required: the reporter auto-discovers session directories on each run.

**Discovery paths (macOS):**

- Standalone install: `~/.openclaw/agents/main/sessions/`
- Plow (any variant): `~/Library/Application Support/co.plow.app*/openclaw/gateway/agents/main/sessions/` — picks up `co.plow.app`, `co.plow.app.dev`, `co.plow.app.wt1`, dev/worktree variants, etc.

**Other platforms:** Only the standalone path is probed. Plow is macOS-only.

To point the reporter at non-default install locations (or to scope reporting to a subset of installs), set `OPENCLAW_SESSIONS_DIRS` in `.env` to one or more sessions directories, comma-separated:

```
OPENCLAW_SESSIONS_DIRS=/custom/path/agents/main/sessions,/another/path/agents/main/sessions
```

The override replaces the auto-discovered list entirely. Each directory is scanned for `*.jsonl` files; `*.trajectory.jsonl` and `sessions.json` are ignored. Cross-file and cross-root duplicates are deduped by each LLM call's `responseId`, so running multiple Plow variants that share OpenClaw data won't double-count.

## Profile Page

Each user gets a shareable profile at `https://tokenmaxxing.odio.dev/user/YOUR_NAME` showing:

- Token usage stats (28-day and all-time)
- Claude vs Codex cost breakdown
- Model breakdown by tokens
- Daily usage chart (28 days)
- Tools, projects, and community badges
- Number of reporting machines
- Your bio from the `ABOUT` field

The `ABOUT` field is the main content of your profile. This is your chance to help other developers by sharing what tools you use and how you use them. Link to the tools, share blog posts, or tweets about your workflow:

```
ABOUT="Building with https://github.com/nickarail/arsenal — 3x founder, shipping AI-first products"
```

URLs are auto-linked on your profile page. The more detail you share, the more useful your profile is to the community.

### 3-Min Demo Video

Set `DEMO_VIDEO_URL` to a YouTube link — **keep it to 3 minutes or shorter**. It embeds on your profile under the "3-MIN DEMO VIDEO" heading. This is the single most useful thing you can share with other developers.

```
DEMO_VIDEO_URL=https://www.youtube.com/watch?v=YiDcgyAn-88
```

**The goal is one aha moment.** Pick a single concrete task and show how AI has changed the way you do it. Structure it as old world → new world:

- **Old world (~1 min).** One task you used to do before AI. Spell out the friction: the manual steps, how long it took, the parts that made you dread it. Keep this short — the viewer needs enough context to feel the old pain, but not a full re-enactment.
- **New world (~2 min).** The same task today. Show the prompt, the agent's output, the shipped result. Don't cut away from the screen — let people see the actual workflow land. The viewer should finish thinking "I want that."

**Why 3 minutes?** It's a social contract. The discipline of cutting to 3 minutes is also what forces the demo to be actually good — if you can't show the transformation in that time, the transformation isn't as clear as you thought, and watching a longer cut won't fix it.

## Appearing on the Leaderboard (HN Verification)

To prevent fake accounts, new users must verify a Hacker News account to appear on the leaderboard. Here's how:

1. Set `HN_USERNAME` in your `.env` (e.g. `HN_USERNAME=Sam_Odio`)
2. Run `npm run report` so the server knows your HN username
3. Add your tkmx profile URL to your [HN about section](https://news.ycombinator.com/user). For example, see [Sam_Odio's HN profile](https://news.ycombinator.com/user?id=Sam_Odio) — the about field includes `https://tkmx.odio.dev/user/samodio`
4. Visit your tkmx profile and click "Verify"

HN may cache your about section for a few minutes. If verification fails, wait a minute and try again.

You can still register, report usage, and view your profile without verification — you just won't appear on the public leaderboard.

## Tools, Projects & Communities

Everyone's tweeting about the latest hot AI tool, but most of it is vaporware. By listing what you actually use day-to-day, you help the developer community see what's real and what's hype. Your usage data — backed by actual token spend — shows what tools people are building with in production, not just what they tried once and posted about.

All three fields show as clickable badges on your profile and the leaderboard.

```
TOOLS=superpowers,arsenal
PROJECTS=tkmx,plow.co
COMMUNITIES=bloomberg-ai-engineering,agentcribs-community
```

- **TOOLS** — What AI coding tools do you actually use daily? Only list what you really use, not everything you've tried.
- **PROJECTS** — What are you spending tokens on? The projects you're actively building with AI. Shows up as "building:" on your profile.
- **COMMUNITIES** — What developer communities are you part of? Clickable filters on the leaderboard.

### Known Tools

| Tool | Description |
|------|-------------|
| [superpowers](https://github.com/nickarail/superpowers) | Claude Code skills for TDD, planning, debugging |
| [arsenal](https://github.com/nickarail/arsenal) | Extended Claude Code skill set |
| [paperclip](https://github.com/paperclipai/paperclip) | AI coding agent framework |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | Codex CLI enhancements |
| [cmux](https://cmux.com/) | AI coding multiplexer |

## Dev Stats

Set `REPORT_DEV_STATS=true` to share how you actually code. This helps the community learn from top developers' workflows — what tools they use, how they use them, and what they ship.

**What's collected:**

| Category | Data | Source |
|----------|------|--------|
| **Workflow shape** | Tool-call frequencies (Edit, Read, Bash, Grep, Agent, etc.), avg tools per turn, subagent dispatch count, plan-mode entries | Claude Code JSONL transcripts |
| **Session stats** | Sessions/period, avg session length, hour-of-day histogram | Claude Code JSONL timestamps |
| **Cache efficiency** | Cache reuse ratio (cache reads / total prompt tokens) | Claude Code JSONL usage blocks |
| **Git outcomes** | Commits, LOC ±, files changed, PRs opened/merged (aggregate across all repos) | `git log` and `gh` in repos Claude touched |
| **Cursor attribution** | Tab-completion vs composer vs human lines, AI-authored %, conversations by model/mode | `~/.cursor/ai-tracking/ai-code-tracking.db` |

**What's never sent:** file paths, prompt content, tool arguments, repo names, code, commit messages, API keys.

The `REPORT_MACHINE_CONFIG` flag also now includes your configuration stack: MCP server names (no credentials), hook event types, CLAUDE.md size, shell/terminal/editor, and git worktree count.

## Cost Estimation

Cost is calculated server-side using current API pricing:

- **Claude models** — estimated per token type (input, output, cache write, cache read) when agentsview doesn't provide cost. When agentsview reports accurate cost, that's used as-is.
- **Codex models** — estimated using blended rates since Codex only reports total tokens (no input/output split).

You don't need to worry about pricing — the server handles it.

## How It Works

[`agentsview`](https://www.agentsview.io/token-usage/) is the required local usage collector. It maintains its own sqlite database synced from `~/.claude` and `~/.codex`, and the reporter queries it via `agentsview usage daily --json --breakdown --agent <claude|codex>`. On large histories this is dramatically faster than walking every JSONL transcript — the sync is incremental and queries hit an indexed database.

When `EXTRA_CLAUDE_CONFIGS` (or `EXTRA_CODEX_CONFIGS`) is set, the reporter runs one agentsview invocation per extra home, each with its own `AGENT_VIEWER_DATA_DIR` (under `~/.agentsview-tkmx/<hash>/`) and the matching source dir env — `CLAUDE_PROJECTS_DIR` (`<home>/projects`) for Claude, `CODEX_SESSIONS_DIR` (`<home>/sessions`) for Codex. This keeps each home in its own isolated sqlite — incremental sync works per-home and the local machine's `~/.agentsview/sessions.db` stays clean.

The reporter merges daily token-usage rows from all enabled sources (Claude, Codex, OpenAI platform, OpenClaw) client-side into `body.data` and POSTs them to the Tokenmaxxing server. Cursor stats and session stats ship in separate body fields (`cursor_stats`, `session_stats`) — they are wholesale-replaced rolling-window blobs, not per-day token rows. Each report replaces previous data for the same machine and date range, so re-syncs are safe and idempotent.

## Logs

```bash
# macOS
cat ~/Library/Logs/token-tracking-reporter.log

# Linux
journalctl --user -u token-tracking-reporter
```

## Manual Report

```
npm run report
```
