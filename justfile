set shell := ["bash", "-cu"]

# Default: list available commands
default:
    @just --list

# Give setup its own exit code, so a red says whether the suite ran at all:
#   2 = setup failed, no test ran — no result either way, still needs fixing
#   1 = the suite ran and a test failed
# Both were a bare exit 1 before, so an unreachable registry read like a failing
# assertion; a reviewer bot reported "tests failed" on a docs-only PR that way.
# npm prints the cause above the message, hence no --silent, which muted it.
#
# `npm ci` runs the prepare hook, which builds, so exit 2 covers a compile break
# too: it means "no test result", never "not your fault".
#
# npm ci, not install, so the gate fails on code rather than a stale
# node_modules that pre-dates a new dependency.
test:
    npm ci --no-audit --no-fund || { echo "[just test] setup failed — no test ran, so this is not a test result either way; see the npm/tsc output above" >&2; exit 2; }
    npm test
