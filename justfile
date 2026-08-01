set shell := ["bash", "-cu"]

# Default: list available commands
default:
    @just --list

# Run the Node test suite, separating setup from the suite itself by exit code:
#   2 = setup failed, no test ever ran — NOT a test failure
#   1 = the suite ran and a test failed — the only real red
# Without this every failure was a bare exit 1, so an unreachable registry read
# identically to a broken build. The failing npm/tsc output above the message
# says which part of setup died; the code only has to answer "real red?".
# Deps always sync from the lockfile so the gate fails on code, not on a stale
# node_modules that pre-dates a new dependency.
test:
    npm ci --silent && npm run build && npm run build:tests || { echo "[just test] setup failed (install/compile) — the suite did not run, so this is not a test failure" >&2; exit 2; }
    npm run test:run
