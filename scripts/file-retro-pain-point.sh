#!/usr/bin/env bash
# File one retro pain point as a bead, idempotently.
#
# Orchestrator agents end a session with a retro whose findings are only as
# durable as wherever they were written down. A printed PAIN POINT heading
# scrolls away; a bead does not. This script is the difference between the two,
# which is why the id it prints belongs verbatim in the retro heading.
#
# The dedupe key is the whole point (see builder-index-client-080). Filing the
# same finding twice must ESCALATE one bead — an evidence comment plus a
# seen-<N> counter that inbox triage ranks by — rather than mint a second bead
# that splits the recurrence count in half. Hand-filing with `bd create` carries
# no key and cannot do that, so always come through here.
#
# Contract, relied on by the caller:
#   * prints EXACTLY ONE line on stdout
#   * ALWAYS exits 0, so a failure to file can never fail the retro itself
#   * that line is either a bead id, or `unfiled:<reason>`
#
# Reasons split three ways, and the caller treats them differently:
#   DEFERRED (the finding is parked in the drop log; the next run re-files it,
#   so re-running by hand double-counts a single sighting):
#     parked-no-bd     bd is not installed; parked instead
#     parked-create    the create failed; parked instead
#     store-unreadable the bead store could not be queried; parked instead
#   LOST (nothing holds the finding; re-running is the only way to keep it):
#     no-bd            bd is missing AND the drop log could not be written
#     lost             the create failed AND the drop log could not be written
#   LOOK FIRST (the bead may or may not exist; search the fbkey before writing):
#     unconfirmed      a create was issued but could not be confirmed
#   REWRITE:
#     scrubbed         the text carries PII or a secret; anonymize and retry
#
# Usage:
#   file-retro-pain-point.sh --summary '...' --severity 1-4 --recommendation '...'
#                            [--subsystem '...'] [--context '...']
#   file-retro-pain-point.sh --json-stdin   # {"summary":..,"severity":..,...}
#
# Env overrides (used by the tests):
#   BD_BIN         bd executable (default: bd)
#   RETRO_DROP_LOG drop-log path (default: <repo>/.beads/retro-pain-point-drops.jsonl)

# NOTE: deliberately no `set -e`. Every failure here has a defined printed
# outcome, and an unexpected non-zero exit would break the always-exit-0
# contract the caller depends on.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BD_BIN="${BD_BIN:-bd}"
DROP_LOG="${RETRO_DROP_LOG:-$REPO/.beads/retro-pain-point-drops.jsonl}"

SUMMARY=""
SEVERITY=""
RECOMMENDATION=""
SUBSYSTEM=""
CONTEXT=""
JSON_STDIN=0

# One line out, then gone. Every exit path in this script goes through here so
# the "exactly one line, always 0" contract holds even on the error paths.
emit() {
  printf '%s\n' "$1"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --summary)        SUMMARY="${2:-}"; shift 2 ;;
    --severity)       SEVERITY="${2:-}"; shift 2 ;;
    --recommendation) RECOMMENDATION="${2:-}"; shift 2 ;;
    --subsystem)      SUBSYSTEM="${2:-}"; shift 2 ;;
    --context)        CONTEXT="${2:-}"; shift 2 ;;
    --json-stdin)     JSON_STDIN=1; shift ;;
    -h|--help)        sed -n '2,40p' "$0"; exit 0 ;;
    *)                emit "unfiled:bad-args" ;;
  esac
done

# --json-stdin exists because quoting prose into shell flags is where these
# calls actually break: a backtick or $( in a double-quoted argument gets
# command-substituted by the caller's shell and the write dies before it
# reaches us. JSON on stdin passes the text through untouched.
if [[ "$JSON_STDIN" == "1" ]]; then
  PAYLOAD="$(cat)"
  eval "$(PAYLOAD="$PAYLOAD" node -e '
    const q = s => "\x27" + String(s == null ? "" : s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    let p;
    try { p = JSON.parse(process.env.PAYLOAD); } catch { console.log("BAD_JSON=1"); process.exit(0); }
    if (!p || typeof p !== "object") { console.log("BAD_JSON=1"); process.exit(0); }
    console.log("SUMMARY=" + q(p.summary));
    console.log("SEVERITY=" + q(p.severity));
    console.log("RECOMMENDATION=" + q(p.recommendation));
    console.log("SUBSYSTEM=" + q(p.subsystem));
    console.log("CONTEXT=" + q(p.context));
  ' 2>/dev/null)"
  [[ "${BAD_JSON:-0}" == "1" ]] && emit "unfiled:bad-args"
fi

[[ -z "$SUMMARY" || -z "$RECOMMENDATION" ]] && emit "unfiled:bad-args"
[[ "$SEVERITY" =~ ^[1-4]$ ]] || emit "unfiled:bad-args"

ALL_TEXT="$SUMMARY
$RECOMMENDATION
$SUBSYSTEM
$CONTEXT"

# Refuse rather than redact. A finding that names a person, a home directory or
# a credential must be rewritten by its author, who knows which detail carried
# the meaning — silently stripping it would file a bead that no longer says
# what went wrong. `scrubbed` therefore means "rewrite and retry", not "denied".
scrub_hit() {
  local t="$1"
  grep -qE '/(Users|home)/[A-Za-z0-9._-]+' <<<"$t" && return 0
  grep -qE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' <<<"$t" && return 0
  grep -qE '\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b' <<<"$t" && return 0
  grep -qE '\bAKIA[0-9A-Z]{16}\b' <<<"$t" && return 0
  grep -qE '\b[Bb]earer[[:space:]]+[A-Za-z0-9._-]{20,}' <<<"$t" && return 0
  grep -qiE '\b(api[_-]?key|secret|password|passwd|token)\b[[:space:]]*[:=][[:space:]]*[A-Za-z0-9._/+-]{12,}' <<<"$t" && return 0
  return 1
}
scrub_hit "$ALL_TEXT" && emit "unfiled:scrubbed"

# The key must survive incidental rewording of the same finding, so it is taken
# over case- and whitespace-normalised text. It must NOT span `context`, which
# carries run-specific evidence and would differ on every sighting — keying on
# it would defeat the dedupe it exists to support.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  else openssl dgst -sha256 | awk '{print $NF}'
  fi
}
KEY_SRC="$(printf '%s|%s|%s' "$SUMMARY" "$RECOMMENDATION" "$SUBSYSTEM" \
  | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')"
FBKEY="fbkey-$(printf '%s' "$KEY_SRC" | sha256_of | cut -c1-12)"

# Parking is not an error path so much as a slower success path: the finding
# stays on disk and the next run re-files it. That is why the caller is told
# NOT to re-run a parked point by hand — the drop log already holds it, and a
# manual retry would count one sighting twice.
park() {
  local reason="$1"
  mkdir -p "$(dirname "$DROP_LOG")" 2>/dev/null
  SUMMARY="$SUMMARY" SEVERITY="$SEVERITY" RECOMMENDATION="$RECOMMENDATION" \
  SUBSYSTEM="$SUBSYSTEM" CONTEXT="$CONTEXT" FBKEY="$FBKEY" REASON="$reason" \
  node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(), fbkey: e.FBKEY, reason: e.REASON,
      summary: e.SUMMARY, severity: Number(e.SEVERITY),
      recommendation: e.RECOMMENDATION,
      subsystem: e.SUBSYSTEM || undefined, context: e.CONTEXT || undefined,
    }) + "\n");
  ' >> "$DROP_LOG" 2>/dev/null
}

command -v "$BD_BIN" >/dev/null 2>&1 || {
  park "parked-no-bd" && emit "unfiled:parked-no-bd"
  emit "unfiled:no-bd"
}

# --all matters: a finding that was filed and then closed must still escalate
# its existing bead rather than open a fresh one.
find_existing() {
  "$BD_BIN" list --all --label "$FBKEY" --json --no-pager --limit 0 2>/dev/null \
    | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        try {
          const rows = JSON.parse(s);
          if (Array.isArray(rows) && rows[0] && rows[0].id) process.stdout.write(rows[0].id);
        } catch {}
      });
    ' 2>/dev/null
}

LIST_OUT="$("$BD_BIN" list --all --label "$FBKEY" --json --no-pager --limit 0 2>/dev/null)"
if [[ $? -ne 0 && -z "$LIST_OUT" ]]; then
  park "store-unreadable" && emit "unfiled:store-unreadable"
  emit "unfiled:lost"
fi
EXISTING="$(find_existing)"

if [[ -n "$EXISTING" ]]; then
  # Repeat sighting: escalate. Priority is deliberately left alone — raising it
  # is a human judgement, and the recurrence counter is what surfaces the
  # finding for that judgement to be made.
  SEEN="$("$BD_BIN" label list "$EXISTING" 2>/dev/null | grep -oE 'seen-[0-9]+' | head -1)"
  N="${SEEN#seen-}"
  [[ "$N" =~ ^[0-9]+$ ]] || N=1
  NEXT=$((N + 1))
  {
    printf 'Sighting %s of this pain point, %s.\n\n' "$NEXT" "$(date -u '+%Y-%m-%d %H:%M UTC')"
    printf 'Severity reported this time: %s\n' "$SEVERITY"
    [[ -n "$SUBSYSTEM" ]] && printf 'Subsystem: %s\n' "$SUBSYSTEM"
    printf '\nRecommendation as restated:\n%s\n' "$RECOMMENDATION"
    [[ -n "$CONTEXT" ]] && printf '\nContext from this run:\n%s\n' "$CONTEXT"
  } | "$BD_BIN" comment "$EXISTING" --stdin >/dev/null 2>&1
  [[ -n "$SEEN" ]] && "$BD_BIN" label remove "$EXISTING" "$SEEN" >/dev/null 2>&1
  "$BD_BIN" label add "$EXISTING" "seen-$NEXT" >/dev/null 2>&1
  emit "$EXISTING"
fi

# First sighting. Severity maps onto bd's 0-4 priority inverted: severity 4 is a
# full blocker and must land at P1, severity 1 is a paper cut at P4.
case "$SEVERITY" in
  4) PRIORITY=1 ;;
  3) PRIORITY=2 ;;
  2) PRIORITY=3 ;;
  *) PRIORITY=4 ;;
esac

DESC="$RECOMMENDATION"
[[ -n "$CONTEXT" ]] && DESC="$DESC

Context:
$CONTEXT"
DESC="$DESC

Filed by scripts/file-retro-pain-point.sh from an agent retro. Dedupe key: $FBKEY
(re-filing the same point escalates this bead instead of creating another)."

LABELS="retro-pain-point,$FBKEY,seen-1"
[[ -n "$SUBSYSTEM" ]] && LABELS="$LABELS,subsystem-$(printf '%s' "$SUBSYSTEM" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"

NEW_ID="$("$BD_BIN" create --title "$SUMMARY" --description "$DESC" --type=task \
  --priority="$PRIORITY" -l "$LABELS" --json 2>/dev/null \
  | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const r = JSON.parse(s);
        const row = Array.isArray(r) ? r[0] : r;
        if (row && row.id) process.stdout.write(row.id);
      } catch {}
    });
  ' 2>/dev/null)"

[[ -n "$NEW_ID" ]] && emit "$NEW_ID"

# The create returned nothing usable. It may still have landed, so look the key
# up before deciding anything — writing a second bead here is the exact failure
# this script exists to prevent.
EXISTING="$(find_existing)"
[[ -n "$EXISTING" ]] && emit "$EXISTING"

park "parked-create" && emit "unfiled:parked-create"
emit "unfiled:lost"
