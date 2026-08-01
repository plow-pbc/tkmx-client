set shell := ["bash", "-cu"]

# Default: list available commands
default:
    @just --list

# Give a failed install its own exit code, so a red says whose problem it is:
#   2 = couldn't install deps, no test ran — nothing here is about your code
#   1 = your code — a test failed, or it didn't compile
# Both were a bare exit 1 before, so an unreachable registry read like a failing
# assertion; a reviewer bot reported "tests failed" on a docs-only PR that way.
# npm prints the cause above the message, hence no --silent, which muted it.
#
# Only install is wrapped. A compile break is yours to fix like a failing
# assertion is, and `npm ci` runs the `prepare` hook — which compiles — so
# separating compile out would need --ignore-scripts, which also skips
# better-sqlite3's binding install and leaves the suite unable to open a
# Database. Everything after install stays in `npm test`, one entry point with
# nothing here to drift from it.
#
# npm ci, not install, so the gate fails on code rather than a stale
# node_modules that pre-dates a new dependency.
test:
    npm ci --no-audit --no-fund || { echo "[just test] dependency install failed — no test ran, so this is not a test result either way; see the npm output above" >&2; exit 2; }
    npm test
