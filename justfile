set shell := ["bash", "-cu"]

# Default: list available commands
default:
    @just --list

# Split setup from the suite by exit code, so a red says whether tests ran:
#   2 = setup died, no test ran — no result either way, but still needs fixing
#   1 = a test failed — the only real red
# Every failure used to be a bare exit 1, so an unreachable registry read like a
# failing assertion. npm/tsc prints the cause above the message — hence no
# --silent, which muted exactly that.
#
# Setup is one stage on purpose, compile included, so a TypeScript error in a
# test file exits 2 too. Separating them needs `npm ci --ignore-scripts`, since
# the root `prepare` hook compiles during install — and that flag also skips
# better-sqlite3's binding install, leaving the suite unable to open a Database.
# prepare is likewise why test:setup's src build is redundant here; it stays,
# at 0.5s, to keep one stage list that `npm test` and `just test` both call.
#
# npm ci, not install, so the gate fails on code rather than a stale
# node_modules that pre-dates a new dependency.
test:
    npm ci --no-audit --no-fund && npm run test:setup || { echo "[just test] setup failed — the suite never ran, so this is not a passing or failing test result; see the npm/tsc output above" >&2; exit 2; }
    npm run test:run
