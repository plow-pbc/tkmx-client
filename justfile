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
# Setup means install *and* compile, so a TypeScript error exits 2 as well. In
# reporter/ that is this guard firing, because `npm ci` runs the `prepare` hook,
# which builds; in test/ it's tsc's own code 2 further down, which agrees by
# luck rather than design. Splitting compile back out to exit 1 would take
# --ignore-scripts, and that also skips better-sqlite3's binding install,
# leaving the suite unable to open a Database. So exit 2 means "no test result",
# never "not your fault". Everything past install stays in `npm test`: one entry
# point, nothing here to drift from it.
#
# npm ci, not install, so the gate fails on code rather than a stale
# node_modules that pre-dates a new dependency.
test:
    npm ci --no-audit --no-fund || { echo "[just test] setup failed — no test ran, so this is not a test result either way; see the npm/tsc output above" >&2; exit 2; }
    npm test
