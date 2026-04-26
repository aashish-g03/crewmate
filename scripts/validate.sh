#!/usr/bin/env bash
# End-to-end validation for the crewmate gemini-worker round-trip.
# Idempotent. Exits non-zero on any failure. CI-friendly.

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

LOG=/tmp/crewmate-validate.log
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

info "checking src/cli.ts"
if [[ ! -f "$PROJECT_ROOT/src/cli.ts" ]]; then
  fail "src/cli.ts not found at $PROJECT_ROOT/src/cli.ts (is the TS code built yet?)"
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

# ---------- step 7: send a deterministic test ----------
TOKEN="CREWMATE_OK_$(date +%s)"
PROMPT="Respond with exactly the single token: $TOKEN"
info "sending test task (token: $TOKEN)"

START_NS=$(python3 -c 'import time;print(int(time.time()*1000))')
set +e
RESULT="$(with_timeout 150 bun src/cli.ts send gemini-worker "$PROMPT" --timeout=120000 2>>"$LOG")"
SEND_EXIT=$?
set -e
END_NS=$(python3 -c 'import time;print(int(time.time()*1000))')
ELAPSED_MS=$((END_NS - START_NS))

if (( SEND_EXIT != 0 )); then
  fail "crewmate send exited with $SEND_EXIT"
  printf '%s---- send stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT" >&2
  dump_log_on_fail
  exit 1
fi
if [[ -z "$RESULT" ]]; then
  fail "crewmate send produced empty stdout"
  dump_log_on_fail
  exit 1
fi

# ---------- step 8: assertions ----------
info "validating JSON shape"
if ! printf '%s' "$RESULT" | python3 -c 'import sys,json; json.loads(sys.stdin.read())' 2>>"$LOG"; then
  fail "result was not valid JSON"
  printf '%s---- raw stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT" >&2
  dump_log_on_fail
  exit 1
fi
ok "JSON parses"

# Single python helper to extract fields (avoids requiring jq).
extract() {
  local field="$1"
  printf '%s' "$RESULT" | python3 -c "
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

STATUS="$(extract status)"
if [[ "$STATUS" != "completed" ]]; then
  fail ".status was '$STATUS' (expected 'completed')"
  printf '%s---- raw stdout ----%s\n%s\n' "$YELLOW" "$RESET" "$RESULT" >&2
  dump_log_on_fail
  exit 1
fi
ok ".status == completed"

RESULT_TEXT="$(extract result)"
if [[ "$RESULT_TEXT" != *"CREWMATE_OK_"* ]]; then
  fail ".result did not contain 'CREWMATE_OK_' substring; got: $RESULT_TEXT"
  dump_log_on_fail
  exit 1
fi
ok ".result contains CREWMATE_OK_ token"

EXIT_CODE="$(extract usage.exitCode)"
if [[ "$EXIT_CODE" != "0" ]]; then
  fail ".usage.exitCode was '$EXIT_CODE' (expected 0)"
  dump_log_on_fail
  exit 1
fi
ok ".usage.exitCode == 0"

TASK_ID="$(extract taskId)"
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if [[ ! "$TASK_ID" =~ $UUID_RE ]]; then
  fail ".taskId is not a UUID; got: $TASK_ID"
  dump_log_on_fail
  exit 1
fi
ok ".taskId is a UUID ($TASK_ID)"

# ---------- step 9: success summary ----------
printf '\n%s[OK]%s Gemini round-trip validated in %sms\n' "$GREEN" "$RESET" "$ELAPSED_MS"
exit 0
