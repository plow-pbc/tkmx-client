set shell := ["bash", "-cu"]

# Default: list available commands
default:
    @just --list

# Run the Node test suite, separating setup from the suite itself by exit code:
#   2 = setup failed, so no test ever ran — still needs fixing, but nothing
#       here says anything about whether the tests pass
#   1 = the suite ran and a test failed — the only real red
# Every failure used to be a bare exit 1, so an unreachable registry read
# identically to a failing assertion. npm/tsc prints the actual cause above the
# message (hence no --silent, which muted exactly that); the exit code only has
# to answer "did the suite get to run?".
#
# Setup is deliberately one stage, compile included: splitting install from
# compile needs `npm ci --ignore-scripts`, because otherwise the root `prepare`
# hook compiles during install — and that flag also skips better-sqlite3's
# install script, leaving no native binding for the suite to open a Database
# with. So exit 2 covers a broken build too, including a TypeScript error in a
# test file. It means "no test result", never "not your fault".
#
# prepare compiling during install also makes test:setup's src build redundant
# on this path. It stays: half a second, against keeping one stage list that
# `npm test` and `just test` both call.
#
# Deps always sync from the lockfile so the gate fails on code, not on a stale
# node_modules that pre-dates a new dependency.
test:
    npm ci --no-audit --no-fund && npm run test:setup || { echo "[just test] setup failed — the suite never ran, so this is not a passing or failing test result; see the npm/tsc output above" >&2; exit 2; }
    npm run test:run
