#!/usr/bin/env bash
# Run the tkmx-client reporter against a local tkmx-server dev instance.
# Reads credentials from ../tkmx-server/scripts/.dev-credentials.json.
#
# Env overrides:
#   TKMX_SERVER_REPO  path to tkmx-server checkout (default: ../tkmx-server)
#   AGENTSVIEW_BIN    path to agentsview binary (default: ../agentsview/agentsview)
#   REPORT_DAYS       days of history (default: 7 — dev default; production uses 28)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

DEFAULT_SERVER_REPO="$(cd "$REPO/.." && pwd)/tkmx-server"
TKMX_SERVER_REPO="${TKMX_SERVER_REPO:-$DEFAULT_SERVER_REPO}"
CREDS="$TKMX_SERVER_REPO/scripts/.dev-credentials.json"

if [[ ! -f "$CREDS" ]]; then
  echo "ERROR: $CREDS not found"
  echo ""
  echo "Start tkmx-server dev mode first:"
  echo "  cd $TKMX_SERVER_REPO && npm run dev"
  exit 1
fi

DEFAULT_AV_BIN="$(cd "$REPO/.." && pwd)/agentsview/agentsview"
AGENTSVIEW_BIN="${AGENTSVIEW_BIN:-$DEFAULT_AV_BIN}"
if [[ ! -x "$AGENTSVIEW_BIN" ]]; then
  # Fall back to PATH lookup
  if command -v agentsview >/dev/null 2>&1; then
    AGENTSVIEW_BIN="$(command -v agentsview)"
  else
    echo "ERROR: agentsview binary not found at $AGENTSVIEW_BIN and not on PATH"
    echo "Build it first: cd ../agentsview && go build ."
    exit 1
  fi
fi

read_json() {
  node -e "const d = JSON.parse(require('fs').readFileSync('$CREDS', 'utf-8')); console.log(d['$1'] || '');"
}

USERNAME="$(read_json username)"
API_KEY="$(read_json api_key)"
SERVER_URL="$(read_json server_url)"
TKMX_USERNAME="$USERNAME"

export USERNAME TKMX_USERNAME API_KEY SERVER_URL AGENTSVIEW_BIN
export REPORT_DEV_STATS="${REPORT_DEV_STATS:-true}"
export REPORT_SESSION_STATS="${REPORT_SESSION_STATS:-true}"
export REPORT_MACHINE_CONFIG="${REPORT_MACHINE_CONFIG:-true}"
export REPORT_DAYS="${REPORT_DAYS:-7}"
export TEAM="${TEAM:-default}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📡  tkmx-client dev report"
echo "    server:     $SERVER_URL"
echo "    username:   $USERNAME"
echo "    agentsview: $AGENTSVIEW_BIN"
echo "    dev_stats:  $REPORT_DEV_STATS"
echo "    session:    $REPORT_SESSION_STATS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Build the TypeScript sources before running. Idempotent — incremental
# rebuilds are fast.
npm run build --silent

exec node dist/reporter/report.js
