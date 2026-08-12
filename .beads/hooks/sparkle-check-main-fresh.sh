#!/usr/bin/env bash
# Warn (never block) when sitting on `main` in the Sparkle repo but local main is
# behind the already-fetched origin/main. No network — compares existing refs only.
#
# SECURITY: install-freshness-hooks.sh COPIES this file into the trusted git hooks
# dir and the shim execs it from THERE by absolute path — never out of a checked-out
# worktree. That matters because the hook may live in a global core.hooksPath that
# fires for every repo (including freshly-cloned untrusted ones); routing a global
# hook to an in-tree, path-by-convention script would be arbitrary code execution
# on clone. This script only runs git plumbing and tests file existence; it execs
# nothing from the working tree.
set -uo pipefail

check_main_freshness() {
  local top branch behind
  top=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  # Scope to the Sparkle repo: only warn where the desktop build actually lives,
  # so this stays silent (and correct) in unrelated repos under a global hook.
  [ -n "$top" ] && [ -f "$top/scripts/build-desktop-to-desktop.sh" ] || return 0
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  [ "$branch" = "main" ] || return 0
  git rev-parse --verify --quiet origin/main >/dev/null 2>&1 || return 0
  behind=$(git rev-list --count main..origin/main 2>/dev/null || echo 0)
  case "$behind" in ''|*[!0-9]*) behind=0 ;; esac   # never let the -gt test throw
  if [ "$behind" -gt 0 ]; then
    {
      echo ""
      echo "⚠️  sparkle: local 'main' is $behind commit(s) behind origin/main."
      echo "   Builds from here will be STALE. Update before building:"
      echo "     git pull --ff-only"
      echo ""
    } >&2
  fi
  return 0
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  check_main_freshness
fi
