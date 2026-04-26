#!/usr/bin/env bash
# End-to-end validation for the crewmate MCP adapter.
# Spins up the gemini-worker pool, then drives the MCP server over stdio
# (JSON-RPC, line-delimited) from a Python helper.
# Idempotent. CI-friendly. Exits non-zero on any failure with a clear [FAIL] line.

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

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_ROOT"

export PATH="$HOME/.bun/bin:$PATH"

# ---------- portable timeout (mac lacks GNU `timeout`) ----------
if command -v timeout >/dev/null 2>&1; then
  with_timeout() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  with_timeout() { gtimeout "$@"; }
else
  with_timeout() {
    local secs="$1"; shift
    "$@" &
    local pid=$!
    ( sleep "$secs" && kill -TERM "$pid" 2>/dev/null && sleep 2 && kill -KILL "$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
    local watchdog=$!
    local exit_code=0
    wait "$pid" 2>/dev/null || exit_code=$?
    pkill -P "$watchdog" 2>/dev/null || true
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    return "$exit_code"
  }
fi

LOG=/tmp/crewmate-validate-mcp.log
: > "$LOG"

dump_log_on_fail() {
  printf '\n%s---- last 80 lines of %s ----%s\n' "$YELLOW" "$LOG" "$RESET" >&2
  tail -n 80 "$LOG" >&2 || true
}

# ---------- step 1: sanity checks ----------
info "checking bun"
if ! command -v bun >/dev/null 2>&1; then
  fail "bun not on PATH (looked in \$HOME/.bun/bin)."
  exit 1
fi
ok "bun $(bun --version)"

info "checking gemini CLI"
if ! command -v gemini >/dev/null 2>&1; then
  fail "gemini CLI not on PATH."
  exit 1
fi
ok "gemini $(gemini --version 2>&1 || echo unknown)"

info "checking python3"
if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 required for JSON-RPC framing."
  exit 1
fi
ok "python3 $(python3 --version 2>&1)"

info "checking src/cli.ts"
if [[ ! -f "$PROJECT_ROOT/src/cli.ts" ]]; then
  fail "src/cli.ts not found at $PROJECT_ROOT/src/cli.ts"
  exit 1
fi
ok "src/cli.ts present"

# ---------- step 2: bun install if needed ----------
if [[ ! -d "$PROJECT_ROOT/node_modules/@modelcontextprotocol" ]]; then
  info "running bun install (MCP SDK missing)"
  if ! with_timeout 180 bun install >>"$LOG" 2>&1; then
    fail "bun install failed"
    dump_log_on_fail
    exit 1
  fi
  ok "bun install complete"
else
  ok "node_modules + MCP SDK present (skipping install)"
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

# ---------- step 4: shrink pool for the test ----------
info "writing test config (poolSize=1) to $GEMINI_DIR/config.json"
cat > "$GEMINI_DIR/config.json" <<'JSON'
{ "poolSize": 1, "timeoutMs": 120000 }
JSON
ok "test config written"

# ---------- step 5: start the worker pool in background ----------
info "starting gemini-worker pool (background)"
bun src/cli.ts up gemini-worker >>"$LOG" 2>&1 &
POOL_PID=$!

cleanup() {
  if kill -0 "$POOL_PID" 2>/dev/null; then
    kill -TERM "$POOL_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$POOL_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$POOL_PID" 2>/dev/null || true
  fi
  wait "$POOL_PID" 2>/dev/null || true
}
trap cleanup EXIT

info "waiting for $GEMINI_DIR/inbox/ (up to 10s)"
WAITED=0
while [[ ! -d "$GEMINI_DIR/inbox" ]]; do
  if (( WAITED >= 10 )); then
    fail "inbox dir never appeared after 10s — pool failed to start"
    dump_log_on_fail
    exit 1
  fi
  if ! kill -0 "$POOL_PID" 2>/dev/null; then
    fail "pool process exited before inbox appeared"
    dump_log_on_fail
    exit 1
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done
ok "inbox ready after ${WAITED}s"

# ---------- step 6: drive the MCP server via Python ----------
TOKEN="CREWMATE_MCP_OK_$(date +%s)"
info "driving MCP server (token: $TOKEN)"

# We pipe Python -> bun (stdin: requests, stdout: responses parsed by Python).
# Python prints "PASS:<line>" / "FAIL:<msg>" on stderr so we can log it.
python3 - "$PROJECT_ROOT" "$TOKEN" "$LOG" <<'PYEOF' 2>&1
import json, os, subprocess, sys, time, threading, queue, signal

project_root, token, logpath = sys.argv[1], sys.argv[2], sys.argv[3]
logf = open(logpath, "a")

def emit(tag, msg):
    print(f"{tag}:{msg}", flush=True)
    logf.write(f"[mcp-driver] {tag}:{msg}\n"); logf.flush()

# Spawn the MCP server.
proc = subprocess.Popen(
    ["bun", "src/cli.ts", "mcp"],
    cwd=project_root,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)

stderr_q = queue.Queue()
def drain_stderr():
    for line in iter(proc.stderr.readline, ""):
        stderr_q.put(line)
        logf.write(f"[mcp-stderr] {line}"); logf.flush()
threading.Thread(target=drain_stderr, daemon=True).start()

# Reader thread: pulls JSON-RPC responses, dispatches by id.
responses = {}
notifications = []
resp_event = threading.Event()
def drain_stdout():
    for line in iter(proc.stdout.readline, ""):
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:
            logf.write(f"[mcp-stdout-bad-json] {line!r}: {e}\n"); logf.flush()
            continue
        logf.write(f"[mcp-stdout] {line}\n"); logf.flush()
        if "id" in msg and ("result" in msg or "error" in msg):
            responses[msg["id"]] = msg
            resp_event.set()
        elif "method" in msg:
            notifications.append(msg)
threading.Thread(target=drain_stdout, daemon=True).start()

def send(req):
    line = json.dumps(req) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()
    logf.write(f"[mcp-stdin] {line}"); logf.flush()

def recv(req_id, timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if req_id in responses:
            return responses.pop(req_id)
        resp_event.wait(0.5); resp_event.clear()
        if proc.poll() is not None:
            raise RuntimeError(f"server died (exit={proc.returncode})")
    raise TimeoutError(f"no response for id={req_id} within {timeout}s")

failed = False
def assert_(cond, msg):
    global failed
    if cond:
        emit("PASS", msg)
    else:
        emit("FAIL", msg)
        failed = True

try:
    # 1. initialize
    send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"validate-mcp","version":"0.0.1"}}})
    r = recv(1, timeout=15)
    assert_("result" in r, "initialize returned a result")
    assert_(r.get("result",{}).get("serverInfo",{}).get("name") == "crewmate", "serverInfo.name == crewmate")

    # initialized notification (per MCP handshake)
    send({"jsonrpc":"2.0","method":"notifications/initialized"})

    # 2. tools/list
    send({"jsonrpc":"2.0","id":2,"method":"tools/list"})
    r = recv(2, timeout=15)
    tools = r.get("result", {}).get("tools", [])
    names = sorted(t["name"] for t in tools)
    expected = [
        "crewmate_cancel",
        "crewmate_destroy_context",
        "crewmate_list_agents",
        "crewmate_list_contexts",
        "crewmate_new_context",
        "crewmate_send_and_wait",
        "crewmate_show_context",
        "crewmate_status",
    ]
    assert_(names == expected, f"tools/list returned exactly the 8 expected tools (got {names})")

    # 3. tools/call -> crewmate_list_agents
    send({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"crewmate_list_agents","arguments":{}}})
    r = recv(3, timeout=15)
    sc = r.get("result", {}).get("structuredContent", {})
    agents = sc.get("agents", [])
    gemini = next((a for a in agents if a.get("name") == "gemini-worker"), None)
    assert_(gemini is not None, "list_agents includes gemini-worker")
    assert_(bool(gemini and gemini.get("ready")), "gemini-worker is ready")

    # 4. tools/call -> crewmate_send_and_wait (with progressToken)
    prompt = f"Respond with exactly the single token: {token}"
    send({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
        "name":"crewmate_send_and_wait",
        "arguments":{"agent":"gemini-worker","prompt":prompt,"timeoutMs":120000},
        "_meta":{"progressToken":"prog-1"}}})
    r = recv(4, timeout=180)
    res = r.get("result", {})
    sc = res.get("structuredContent", {})
    text = "".join(c.get("text","") for c in res.get("content", []) if c.get("type") == "text")
    assert_(sc.get("status") == "completed", f"send_and_wait status == completed (got {sc.get('status')})")
    assert_(token in text, f"send_and_wait text contains the unique token (got {text[:200]!r})")
    task_id = sc.get("taskId")
    assert_(isinstance(task_id, str) and len(task_id) == 36, f"send_and_wait returned a UUID taskId (got {task_id!r})")

    # progress notifications: at least one of "queued"/"claimed"/"running, Ns elapsed"
    progress_msgs = [n for n in notifications if n.get("method") == "notifications/progress"
                     and n.get("params",{}).get("progressToken") == "prog-1"]
    assert_(len(progress_msgs) >= 1, f"received >=1 progress notification (got {len(progress_msgs)})")

    # 5. tools/call -> crewmate_status with taskId
    send({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{
        "name":"crewmate_status","arguments":{"taskId": task_id}}})
    r = recv(5, timeout=15)
    sc = r.get("result", {}).get("structuredContent", {})
    assert_(sc.get("state") == "completed", f"status({task_id}).state == completed (got {sc.get('state')})")
    assert_(sc.get("agent") == "gemini-worker", f"status({task_id}).agent == gemini-worker (got {sc.get('agent')})")

    # ─── v1.1 context tools ─────────────────────────────────────────────────
    import re
    CTX_RE = re.compile(r"^ctx_[a-z0-9]{8}$")

    # 6. crewmate_list_contexts (empty case): zero active contexts before we mint one.
    send({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{
        "name":"crewmate_list_contexts","arguments":{"agent":"gemini-worker"}}})
    r = recv(6, timeout=15)
    sc = r.get("result", {}).get("structuredContent", {})
    initial_contexts = sc.get("contexts", [])
    assert_(initial_contexts == [], f"list_contexts (empty) -> [] (got {initial_contexts})")

    # 7. crewmate_send_and_wait with newContext=true, ownerHint -> turn 1 of a fresh context.
    prompt2 = f"Reply with exactly: {token}-T1"
    send({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{
        "name":"crewmate_send_and_wait",
        "arguments":{
            "agent":"gemini-worker",
            "prompt":prompt2,
            "timeoutMs":120000,
            "newContext":True,
            "ownerHint":"mcp-validate",
        }}})
    r = recv(7, timeout=180)
    sc = r.get("result", {}).get("structuredContent", {})
    ctx_id = sc.get("contextId")
    assert_(isinstance(ctx_id, str) and bool(CTX_RE.match(ctx_id)),
            f"newContext send returned a contextId matching ctx_xxxxxxxx (got {ctx_id!r})")
    assert_(sc.get("turnNumber") == 1, f"newContext send returned turnNumber == 1 (got {sc.get('turnNumber')})")
    assert_(sc.get("status") == "completed", f"newContext send status == completed (got {sc.get('status')})")

    # 8. crewmate_list_contexts: one entry, correct agent / turnCount / ownerHint.
    send({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{
        "name":"crewmate_list_contexts","arguments":{"agent":"gemini-worker"}}})
    r = recv(8, timeout=15)
    sc = r.get("result", {}).get("structuredContent", {})
    ctxs = sc.get("contexts", [])
    assert_(len(ctxs) == 1, f"list_contexts after mint -> 1 entry (got {len(ctxs)})")
    if ctxs:
        e = ctxs[0]
        assert_(e.get("agent") == "gemini-worker", f"list entry agent == gemini-worker (got {e.get('agent')})")
        assert_(e.get("contextId") == ctx_id, f"list entry contextId matches (got {e.get('contextId')})")
        assert_(e.get("turnCount") == 1, f"list entry turnCount == 1 (got {e.get('turnCount')})")
        assert_(e.get("ownerHint") == "mcp-validate", f"list entry ownerHint == mcp-validate (got {e.get('ownerHint')})")

    # 9. crewmate_send_and_wait with contextId -> turn 2 of the same context.
    prompt3 = f"Reply with exactly: {token}-T2"
    send({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{
        "name":"crewmate_send_and_wait",
        "arguments":{
            "agent":"gemini-worker",
            "prompt":prompt3,
            "timeoutMs":120000,
            "contextId":ctx_id,
        }}})
    r = recv(9, timeout=180)
    sc = r.get("result", {}).get("structuredContent", {})
    assert_(sc.get("contextId") == ctx_id, f"continuation send carried same contextId (got {sc.get('contextId')})")
    assert_(sc.get("turnNumber") == 2, f"continuation send turnNumber == 2 (got {sc.get('turnNumber')})")
    assert_(sc.get("status") == "completed", f"continuation send status == completed (got {sc.get('status')})")

    # 10. crewmate_show_context full transcript: 2 turns, expected prompts.
    send({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{
        "name":"crewmate_show_context","arguments":{"contextId":ctx_id}}})
    r = recv(10, timeout=15)
    sc = r.get("result", {}).get("structuredContent", {})
    turns = sc.get("turns", [])
    assert_(len(turns) == 2, f"show_context full -> 2 turns (got {len(turns)})")
    if len(turns) >= 2:
        assert_(turns[0].get("prompt") == prompt2, "show_context turn 1 prompt matches")
        assert_(turns[1].get("prompt") == prompt3, "show_context turn 2 prompt matches")

    # 11. crewmate_show_context with tail=1 -> only 1 turn.
    send({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{
        "name":"crewmate_show_context","arguments":{"contextId":ctx_id,"tail":1}}})
    r = recv(11, timeout=15)
    sc = r.get("result", {}).get("structuredContent", {})
    turns = sc.get("turns", [])
    assert_(len(turns) == 1, f"show_context tail=1 -> 1 turn (got {len(turns)})")
    if turns:
        assert_(turns[0].get("prompt") == prompt3, "show_context tail=1 returns the most recent prompt")

    # 12. crewmate_destroy_context -> archived.
    send({"jsonrpc":"2.0","id":12,"method":"tools/call","params":{
        "name":"crewmate_destroy_context","arguments":{"contextId":ctx_id}}})
    r = recv(12, timeout=15)
    res = r.get("result", {})
    sc = res.get("structuredContent", {})
    assert_(not res.get("isError"), f"destroy_context succeeded (isError={res.get('isError')})")
    assert_(sc.get("contextId") == ctx_id, f"destroy_context returned contextId (got {sc.get('contextId')})")
    assert_(sc.get("agent") == "gemini-worker", f"destroy_context returned agent (got {sc.get('agent')})")

    # 13. crewmate_list_contexts: empty again (the destroyed one is no longer active).
    send({"jsonrpc":"2.0","id":13,"method":"tools/call","params":{
        "name":"crewmate_list_contexts","arguments":{"agent":"gemini-worker"}}})
    r = recv(13, timeout=15)
    sc = r.get("result", {}).get("structuredContent", {})
    ctxs = sc.get("contexts", [])
    assert_(ctxs == [], f"list_contexts after destroy -> [] (got {ctxs})")

    # 14. crewmate_send_and_wait with both newContext and contextId -> tool error.
    send({"jsonrpc":"2.0","id":14,"method":"tools/call","params":{
        "name":"crewmate_send_and_wait",
        "arguments":{
            "agent":"gemini-worker",
            "prompt":"should not run",
            "newContext":True,
            "contextId":"ctx_aaaaaaaa",
        }}})
    r = recv(14, timeout=15)
    res = r.get("result", {})
    text = "".join(c.get("text","") for c in res.get("content", []) if c.get("type") == "text")
    assert_(bool(res.get("isError")), f"mutual-exclusion -> isError true (got {res.get('isError')})")
    assert_("mutually exclusive" in text, f"mutual-exclusion message present (got {text!r})")

finally:
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    logf.close()

sys.exit(1 if failed else 0)
PYEOF
PYRC=$?

if (( PYRC != 0 )); then
  fail "MCP driver exited with $PYRC"
  dump_log_on_fail
  exit 1
fi
ok "all MCP assertions passed"

printf '\n%s[OK]%s crewmate MCP adapter validated\n' "$GREEN" "$RESET"
exit 0
