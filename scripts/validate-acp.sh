#!/usr/bin/env bash
# End-to-end validation for the crewmate ACP transport (gemini --acp).
# Exercises multi-turn context over the ACP wire: Turn 1 with --new-context,
# Turn 2 with --context=<id>. Idempotent. CI-friendly. Exits non-zero on
# any failure with a clear [FAIL] line.

set -euo pipefail

# ---------- color helpers ----------
if tty -s 2>/dev/null; then
  GREEN=$'\033[0;32m'
  RED=$'\033[0;31m'
  YELLOW=$'\033[0;33m'
  RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; RESET=""
fi

ok()   { printf '%s[OK]%s %s\n'   "$GREEN"  "$RESET" "$1"; }
fail() { printf '%s[FAIL]%s %s\n' "$RED"    "$RESET" "$1" >&2; }
info() { printf '%s[..]%s %s\n'   "$YELLOW" "$RESET" "$1"; }

# ---------- locate project root ----------
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_ROOT"

# ---------- ensure bun is on PATH ----------
export PATH="$HOME/.bun/bin:$PATH"

# ---------- portable timeout wrapper (macOS lacks GNU `timeout`) ----------
if command -v timeout >/dev/null 2>&1; then
  with_timeout() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  with_timeout() { gtimeout "$@"; }
else
  # Portable timeout. Redirect the watchdog subshell's I/O to /dev/null:
  # without this, the orphan `sleep` child inherits the parent's command-
  # substitution pipe (fd 1) and `$(with_timeout ...)` blocks until the
  # sleep expires naturally, even if the wrapped command exited early.
  with_timeout() {
    local secs="$1"; shift
    "$@" &
    local pid=$!
    ( sleep "$secs" && kill -TERM "$pid" 2>/dev/null && sleep 2 && kill -KILL "$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
    local watchdog=$!
    local exit_code=0
    wait "$pid" 2>/dev/null || exit_code=$?
    # Kill the watchdog and its sleep child (resource hygiene; correctness
    # is already covered by the redirect above).
    pkill -P "$watchdog" 2>/dev/null || true
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    return "$exit_code"
  }
fi

LOG=/tmp/crewmate-validate-acp.log
: > "$LOG"

dump_log_on_fail() {
  printf '\n%s---- last 80 lines of %s ----%s\n' "$YELLOW" "$LOG" "$RESET" >&2
  tail -n 80 "$LOG" >&2 || true
}

# ---------- step 1: sanity checks ----------
info "checking bun"
if ! command -v bun >/dev/null 2>&1; then
  fail "bun not on PATH (looked in \$HOME/.bun/bin). Install from https://bun.sh."
  exit 1
fi
BUN_VERSION="$(bun --version 2>&1)" || { fail "bun --version failed: $BUN_VERSION"; exit 1; }
ok "bun $BUN_VERSION"

info "checking gemini CLI"
if ! command -v gemini >/dev/null 2>&1; then
  fail "gemini CLI not on PATH. Install per https://github.com/google-gemini/gemini-cli."
  exit 1
fi
GEMINI_VERSION="$(gemini --version 2>&1 || true)"
ok "gemini $GEMINI_VERSION"

info "checking gemini --acp support"
# gemini --help should mention --acp if the version supports ACP transport.
if ! gemini --help 2>&1 | grep -q -- '--acp'; then
  fail "gemini CLI does not support --acp. Upgrade to a version with ACP transport."
  exit 1
fi
ok "gemini --acp flag available"

info "checking src/cli.ts"
if [[ ! -f "$PROJECT_ROOT/src/cli.ts" ]]; then
  fail "src/cli.ts not found at $PROJECT_ROOT/src/cli.ts"
  exit 1
fi
ok "src/cli.ts present"

# ---------- step 2: bun install if needed ----------
if [[ ! -d "$PROJECT_ROOT/node_modules" ]]; then
  info "running bun install (node_modules missing)"
  if ! with_timeout 180 bun install >>"$LOG" 2>&1; then
    fail "bun install failed"
    dump_log_on_fail
    exit 1
  fi
  ok "bun install complete"
else
  ok "node_modules present (skipping install)"
fi

# ---------- step 3: crewmate init ----------
info "running crewmate init"
if ! with_timeout 30 bun src/cli.ts init >>"$LOG" 2>&1; then
  fail "crewmate init failed"
  dump_log_on_fail
  exit 1
fi
ok "crewmate init complete"

CREWMATE_DIR="$HOME/.crewmate"
GEMINI_DIR="$CREWMATE_DIR/gemini-worker"
if [[ ! -d "$GEMINI_DIR" ]]; then
  fail "expected $GEMINI_DIR after init, not found"
  dump_log_on_fail
  exit 1
fi

# ---------- step 4: override poolSize=1 for the test ----------
info "writing test config (poolSize=1) to $GEMINI_DIR/config.json"
cat > "$GEMINI_DIR/config.json" <<'JSON'
{ "poolSize": 1, "timeoutMs": 120000 }
JSON
ok "test config written"

# ---------- step 5: start the pool in background ----------
info "starting gemini-worker pool (background)"
bun src/cli.ts up gemini-worker >>"$LOG" 2>&1 &
POOL_PID=$!

cleanup() {
  if kill -0 "$POOL_PID" 2>/dev/null; then
    kill -TERM "$POOL_PID" 2>/dev/null || true
    # give it a moment to drain, then SIGKILL if still around
    for _ in 1 2 3 4 5; do
      kill -0 "$POOL_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$POOL_PID" 2>/dev/null || true
  fi
  wait "$POOL_PID" 2>/dev/null || true
}
trap cleanup EXIT

# ---------- step 6: wait up to 10s for inbox to exist ----------
info "waiting for $GEMINI_DIR/inbox/ (up to 10s)"
WAITED=0
while [[ ! -d "$GEMINI_DIR/inbox" ]]; do
  if (( WAITED >= 10 )); then
    fail "inbox dir never appeared after 10s — pool failed to start"
    dump_log_on_fail
    exit 1
  fi
  # also bail early if the pool died
  if ! kill -0 "$POOL_PID" 2>/dev/null; then
    fail "pool process exited before inbox appeared"
    dump_log_on_fail
    exit 1
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done
ok "inbox ready after ${WAITED}s"

# ---------- JSON field extraction (portable, no jq dependency) ----------
# Single python helper to extract fields (avoids requiring jq).
extract() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
v = d
for part in '$field'.split('.'):
    if isinstance(v, dict):
        v = v.get(part)
    else:
        v = None
        break
if v is None:
    print('')
else:
    print(v)
"
}

# ==========================================================================
# Turn 1: send with --new-context
# ==========================================================================
TOKEN="CREWMATE_ACP_$(date +%s)"
PROMPT_T1="Respond with exactly the single token: ${TOKEN}-T1"
info "Turn 1: sending task with --new-context (token: ${TOKEN}-T1)"

START_NS=$(python3 -c 'import time;print(int(time.time()*1000))')
set +e
RESULT_T1="$(with_timeout 150 bun src/cli.ts send gemini-worker "$PROMPT_T1" --timeout=120000 --new-context --owner-hint=acp-validate 2>>"$LOG")"
SEND_EXIT_T1=$?
set -e
END_NS=$(python3 -c 'import time;print(int(time.time()*1000))')
ELAPSED_T1=$((END_NS - START_NS))

if (( SEND_EXIT_T1 != 0 )); then
  fail "Turn 1: crewmate send exited with $SEND_EXIT_T1"
  printf '%s---- send stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT_T1" >&2
  dump_log_on_fail
  exit 1
fi
if [[ -z "$RESULT_T1" ]]; then
  fail "Turn 1: crewmate send produced empty stdout"
  dump_log_on_fail
  exit 1
fi

# Validate Turn 1 JSON shape
info "Turn 1: validating JSON shape"
if ! printf '%s' "$RESULT_T1" | python3 -c 'import sys,json; json.loads(sys.stdin.read())' 2>>"$LOG"; then
  fail "Turn 1: result was not valid JSON"
  printf '%s---- raw stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT_T1" >&2
  dump_log_on_fail
  exit 1
fi
ok "Turn 1: JSON parses"

# Assert .status == completed
STATUS_T1="$(extract "$RESULT_T1" status)"
if [[ "$STATUS_T1" != "completed" ]]; then
  fail "Turn 1: .status was '$STATUS_T1' (expected 'completed')"
  printf '%s---- raw stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT_T1" >&2
  dump_log_on_fail
  exit 1
fi
ok "Turn 1: .status == completed"

# Assert .contextId is present and matches expected pattern
CONTEXT_ID="$(extract "$RESULT_T1" contextId)"
CTX_RE='^ctx_[a-z0-9]{8}$'
if [[ ! "$CONTEXT_ID" =~ $CTX_RE ]]; then
  fail "Turn 1: .contextId is not in ctx_xxxxxxxx format; got: '$CONTEXT_ID'"
  dump_log_on_fail
  exit 1
fi
ok "Turn 1: .contextId present ($CONTEXT_ID)"

# Assert .turnNumber == 1
TURN_T1="$(extract "$RESULT_T1" turnNumber)"
if [[ "$TURN_T1" != "1" ]]; then
  fail "Turn 1: .turnNumber was '$TURN_T1' (expected '1')"
  dump_log_on_fail
  exit 1
fi
ok "Turn 1: .turnNumber == 1"

info "Turn 1 completed in ${ELAPSED_T1}ms"

# ==========================================================================
# Turn 2: send with --context=<id from Turn 1>
# ==========================================================================
PROMPT_T2="Respond with exactly the single token: ${TOKEN}-T2"
info "Turn 2: sending task with --context=$CONTEXT_ID (token: ${TOKEN}-T2)"

START_NS=$(python3 -c 'import time;print(int(time.time()*1000))')
set +e
RESULT_T2="$(with_timeout 150 bun src/cli.ts send gemini-worker "$PROMPT_T2" --timeout=120000 --context="$CONTEXT_ID" 2>>"$LOG")"
SEND_EXIT_T2=$?
set -e
END_NS=$(python3 -c 'import time;print(int(time.time()*1000))')
ELAPSED_T2=$((END_NS - START_NS))

if (( SEND_EXIT_T2 != 0 )); then
  fail "Turn 2: crewmate send exited with $SEND_EXIT_T2"
  printf '%s---- send stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT_T2" >&2
  dump_log_on_fail
  exit 1
fi
if [[ -z "$RESULT_T2" ]]; then
  fail "Turn 2: crewmate send produced empty stdout"
  dump_log_on_fail
  exit 1
fi

# Validate Turn 2 JSON shape
info "Turn 2: validating JSON shape"
if ! printf '%s' "$RESULT_T2" | python3 -c 'import sys,json; json.loads(sys.stdin.read())' 2>>"$LOG"; then
  fail "Turn 2: result was not valid JSON"
  printf '%s---- raw stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT_T2" >&2
  dump_log_on_fail
  exit 1
fi
ok "Turn 2: JSON parses"

# Assert .status == completed
STATUS_T2="$(extract "$RESULT_T2" status)"
if [[ "$STATUS_T2" != "completed" ]]; then
  fail "Turn 2: .status was '$STATUS_T2' (expected 'completed')"
  printf '%s---- raw stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT_T2" >&2
  dump_log_on_fail
  exit 1
fi
ok "Turn 2: .status == completed"

# Assert .contextId matches Turn 1
CONTEXT_ID_T2="$(extract "$RESULT_T2" contextId)"
if [[ "$CONTEXT_ID_T2" != "$CONTEXT_ID" ]]; then
  fail "Turn 2: .contextId was '$CONTEXT_ID_T2' (expected '$CONTEXT_ID')"
  dump_log_on_fail
  exit 1
fi
ok "Turn 2: .contextId matches Turn 1 ($CONTEXT_ID)"

# Assert .turnNumber == 2
TURN_T2="$(extract "$RESULT_T2" turnNumber)"
if [[ "$TURN_T2" != "2" ]]; then
  fail "Turn 2: .turnNumber was '$TURN_T2' (expected '2')"
  dump_log_on_fail
  exit 1
fi
ok "Turn 2: .turnNumber == 2"

info "Turn 2 completed in ${ELAPSED_T2}ms"

# ---------- success summary ----------
TOTAL_MS=$((ELAPSED_T1 + ELAPSED_T2))
printf '\n%s[OK]%s ACP transport validated: 2-turn context round-trip in %sms (T1=%sms, T2=%sms)\n' \
  "$GREEN" "$RESET" "$TOTAL_MS" "$ELAPSED_T1" "$ELAPSED_T2"
exit 0
