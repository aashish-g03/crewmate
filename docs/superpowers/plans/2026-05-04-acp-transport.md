# ACP Transport Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ACP (Agent Context Protocol) transport that keeps persistent stdio connections to CLI agents, running alongside the existing spawn-per-task mailbox model. Agents opt in via a registry flag.

**Architecture:** The worker reads the agent card's `transport` field. When `transport === 'acp'`, instead of calling `runCli()` (spawn-per-task), the worker delegates to an `AcpRunner` that holds a long-lived child process and speaks JSON-RPC over stdin/stdout. The ACP process is spawned once per worker, survives across tasks, and maintains in-memory session state — eliminating the disk-based context concatenation for ACP agents. Non-ACP agents continue using `runCli()` unchanged.

**Tech Stack:** TypeScript/Bun, JSON-RPC 2.0 over stdio, Zod for schema validation. No new dependencies — we implement a minimal JSON-RPC client ourselves (crewmate avoids frameworks).

---

## File Structure

| File | Responsibility |
|---|---|
| Create: `src/transports/acp-runner.ts` | `AcpRunner` class — manages a persistent child process, sends JSON-RPC requests over stdin, reads responses from stdout. Handles initialize handshake, session create/resume, message send, and graceful shutdown. |
| Create: `src/transports/jsonrpc.ts` | Minimal JSON-RPC 2.0 client: line-delimited framing over stdin/stdout streams, request ID tracking, response dispatch, timeout per request. |
| Modify: `src/envelope.ts` | Add optional `transport` field to `AgentCard` schema (`'spawn' | 'acp'`, default `'spawn'`). |
| Modify: `src/agents/registry.ts` | Add `acpCommand` and `transport: 'acp'` to gemini-worker entry. |
| Modify: `src/worker.ts` | Branch on `card.transport`: ACP agents use `AcpRunner`, spawn agents use existing `runCli()`. |
| Modify: `src/supervisor.ts` | No changes needed — workers are still child processes, AcpRunner lives inside each worker. |
| Modify: `src/types.ts` | Add `AcpSessionId` type alias. Extend `RunnerResult` with optional `acpSessionId`. |
| Create: `scripts/validate-acp.sh` | End-to-end test: starts gemini-worker with ACP transport, sends two tasks (one newContext, one continuation), verifies session reuse via turnNumber. |

---

### Task 1: JSON-RPC Client

**Files:**
- Create: `src/transports/jsonrpc.ts`

- [ ] **Step 1: Create the JSON-RPC types and client**

```typescript
// src/transports/jsonrpc.ts
import { EventEmitter } from 'node:events';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type PendingRequest = {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private writeFn: (data: string) => void;
  private defaultTimeoutMs: number;

  constructor(opts: {
    write: (data: string) => void;
    defaultTimeoutMs?: number;
  }) {
    this.writeFn = opts.write;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    this.writeFn(JSON.stringify(req) + '\n');

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout: ${method} (id=${id}, ${timeout}ms)`));
      }, timeout);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.writeFn(JSON.stringify(msg) + '\n');
  }

  cancelAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/transports/jsonrpc.ts
git commit -m "feat(acp): add minimal JSON-RPC 2.0 client for stdio transport"
```

---

### Task 2: AgentCard Schema Extension

**Files:**
- Modify: `src/envelope.ts:84-99` (AgentCard schema)
- Modify: `src/types.ts`

- [ ] **Step 1: Add `transport` and `acpCommand` to AgentCard schema**

In `src/envelope.ts`, replace the `AgentCard` schema with:

```typescript
export const AgentCard = z
  .object({
    name: z.string(),
    description: z.string(),
    model: z.string(),
    contextWindow: z.number().int().positive(),
    strengths: z.array(z.string()),
    cliCommand: z.array(z.string()),
    transport: z.enum(['spawn', 'acp']).default('spawn'),
    acpCommand: z.array(z.string()).optional(),
    setupHint: z.string().optional(),
  })
  .passthrough();
```

- [ ] **Step 2: Add AcpSessionId type alias to types.ts**

Append to `src/types.ts`:

```typescript
export type AcpSessionId = string;
```

- [ ] **Step 3: Verify it compiles and existing tests pass**

Run: `bunx tsc --noEmit`
Expected: no errors (default `'spawn'` means all existing cards parse unchanged)

- [ ] **Step 4: Commit**

```bash
git add src/envelope.ts src/types.ts
git commit -m "feat(acp): add transport and acpCommand fields to AgentCard schema"
```

---

### Task 3: Registry — Gemini ACP Entry

**Files:**
- Modify: `src/agents/registry.ts`

- [ ] **Step 1: Add acpCommand and transport to gemini-worker**

Replace the gemini-worker entry in `src/agents/registry.ts`:

```typescript
  'gemini-worker': {
    name: 'gemini-worker',
    description:
      'Long-context auditor and hallucination checker via Gemini CLI',
    model: 'gemini',
    contextWindow: 2_000_000,
    strengths: [
      'large-codebase audit',
      'cross-file verification',
      'hallucination check',
    ],
    cliCommand: [
      'gemini',
      '-p',
      '{prompt}',
      '--approval-mode',
      'auto_edit',
      '--skip-trust',
    ],
    transport: 'acp',
    acpCommand: ['gemini', '--acp'],
  },
```

The `cliCommand` stays as a fallback for spawn-per-task mode. `acpCommand` is what the AcpRunner spawns as a long-lived process.

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/agents/registry.ts
git commit -m "feat(acp): register gemini-worker with ACP transport + acpCommand"
```

---

### Task 4: AcpRunner — Persistent Process Manager

**Files:**
- Create: `src/transports/acp-runner.ts`

- [ ] **Step 1: Create the AcpRunner class**

```typescript
// src/transports/acp-runner.ts
import type { Subprocess } from 'bun';
import type { AgentCard } from '../envelope.ts';
import type { RunnerResult } from '../types.ts';
import { JsonRpcClient } from './jsonrpc.ts';
import { log } from '../logger.ts';

const SIGKILL_GRACE_MS = 5000;
const INITIALIZE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 300_000;

interface AcpSession {
  sessionId: string;
  turnCount: number;
}

export class AcpRunner {
  private proc: Subprocess | null = null;
  private rpc: JsonRpcClient | null = null;
  private sessions = new Map<string, AcpSession>();
  private initialized = false;
  private stderrChunks: string[] = [];
  private card: AgentCard;
  private cwd: string | undefined;

  constructor(card: AgentCard, opts?: { cwd?: string }) {
    this.card = card;
    this.cwd = opts?.cwd;
  }

  async ensureRunning(): Promise<void> {
    if (this.proc && this.initialized) return;
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const argv = this.card.acpCommand;
    if (!argv || argv.length === 0) {
      throw new Error(`Agent ${this.card.name} has no acpCommand`);
    }

    this.proc = Bun.spawn(argv, {
      cwd: this.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });

    const stdin = this.proc.stdin;
    this.rpc = new JsonRpcClient({
      write: (data: string) => {
        stdin.write(data);
        stdin.flush();
      },
      defaultTimeoutMs: REQUEST_TIMEOUT_MS,
    });

    this.drainStdout();
    this.drainStderr();

    const resp = await this.rpc.request(
      'initialize',
      {
        protocolVersion: '1',
        clientInfo: { name: 'crewmate', version: '0.2.0' },
        clientCapabilities: {},
      },
      INITIALIZE_TIMEOUT_MS
    );

    if (resp.error) {
      throw new Error(
        `ACP initialize failed: ${resp.error.message} (code=${resp.error.code})`
      );
    }

    this.rpc.notify('notifications/initialized');
    this.initialized = true;

    log({
      event: 'acp_initialized',
      agent: this.card.name,
      pid: this.proc.pid,
    });
  }

  private drainStdout(): void {
    if (!this.proc?.stdout) return;
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    const rpc = this.rpc!;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          rpc.feed(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) rpc.feed(tail);
      } catch {
        // stream closed
      }
    })();
  }

  private drainStderr(): void {
    if (!this.proc?.stderr) return;
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.stderrChunks.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // stream closed
      }
    })();
  }

  async createSession(opts?: {
    cwd?: string;
  }): Promise<string> {
    await this.ensureRunning();
    const resp = await this.rpc!.request('sessions/create', {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    });
    if (resp.error) {
      throw new Error(`sessions/create failed: ${resp.error.message}`);
    }
    const result = resp.result as { sessionId: string };
    const sessionId = result.sessionId;
    this.sessions.set(sessionId, { sessionId, turnCount: 0 });
    log({
      event: 'acp_session_created',
      agent: this.card.name,
      message: `session=${sessionId}`,
    });
    return sessionId;
  }

  async sendMessage(
    sessionId: string,
    prompt: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RunnerResult> {
    await this.ensureRunning();
    const startedAt = Date.now();

    let aborted = false;
    const onAbort = () => { aborted = true; };
    opts?.signal?.addEventListener('abort', onAbort, { once: true });

    this.stderrChunks = [];

    try {
      const resp = await this.rpc!.request(
        'sessions/message',
        { sessionId, message: { role: 'user', content: prompt } },
        opts?.timeoutMs ?? REQUEST_TIMEOUT_MS
      );

      if (aborted) {
        return {
          exitCode: null,
          stdout: '',
          stderr: this.stderrChunks.join(''),
          durationMs: Date.now() - startedAt,
          hint: 'aborted',
        };
      }

      if (resp.error) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: resp.error.message,
          durationMs: Date.now() - startedAt,
        };
      }

      const result = resp.result as {
        message?: { content?: string };
      };
      const content = result?.message?.content ?? '';

      const session = this.sessions.get(sessionId);
      if (session) session.turnCount++;

      return {
        exitCode: 0,
        stdout: content,
        stderr: this.stderrChunks.join(''),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        exitCode: null,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: Date.now() - startedAt,
        hint: aborted ? 'aborted' : 'timeout',
      };
    } finally {
      opts?.signal?.removeEventListener('abort', onAbort);
    }
  }

  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    this.rpc?.cancelAll('shutdown');

    try {
      this.proc.kill('SIGTERM');
    } catch { /* already exited */ }

    const killTimer = setTimeout(() => {
      try {
        this.proc?.kill('SIGKILL');
      } catch { /* already exited */ }
    }, SIGKILL_GRACE_MS);

    await this.proc.exited;
    clearTimeout(killTimer);

    log({
      event: 'acp_shutdown',
      agent: this.card.name,
      pid: this.proc.pid,
    });

    this.proc = null;
    this.rpc = null;
    this.initialized = false;
    this.sessions.clear();
  }

  get alive(): boolean {
    return this.proc !== null && this.initialized;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/transports/acp-runner.ts
git commit -m "feat(acp): add AcpRunner — persistent stdio process manager with session support"
```

---

### Task 5: Worker Integration — Branch on Transport

**Files:**
- Modify: `src/worker.ts`

This is the critical integration point. The worker needs to:
1. Read `card.transport` at startup
2. If `'acp'`: instantiate an `AcpRunner`, use it for all tasks
3. If `'spawn'` (default): use existing `runCli()` path unchanged

- [ ] **Step 1: Import AcpRunner and add transport branching**

At the top of `src/worker.ts`, add the import:

```typescript
import { AcpRunner } from './transports/acp-runner.ts';
```

- [ ] **Step 2: Instantiate AcpRunner after loading card (in main())**

After line 102 (`const config = await loadAgentConfig(AGENT_NAME);`), add:

```typescript
  const isAcp = card.transport === 'acp' && card.acpCommand && card.acpCommand.length > 0;
  let acpRunner: AcpRunner | null = null;
  if (isAcp) {
    acpRunner = new AcpRunner(card);
    try {
      await acpRunner.ensureRunning();
      log({ event: 'acp_worker_ready', agent: AGENT_NAME, pid });
    } catch (err) {
      log({
        event: 'acp_worker_fallback',
        agent: AGENT_NAME,
        pid,
        error: (err as Error).message,
      });
      acpRunner = null;
    }
  }
```

- [ ] **Step 3: Create ACP-aware task runner function**

Add this function inside `main()`, after the `acpRunner` instantiation:

```typescript
  const runAcpTask = async (
    req: TaskRequest,
    taskId: string,
    ac: AbortController,
    startedAt: number,
    cfg: typeof config
  ): Promise<TaskResult> => {
    if (!acpRunner?.alive) {
      try {
        await acpRunner!.ensureRunning();
      } catch (err) {
        return {
          taskId,
          agent: AGENT_NAME,
          status: 'failed',
          summary: 'ACP process not available',
          result: '',
          error: (err as Error).message,
          usage: { durationMs: Date.now() - startedAt, exitCode: null, stdoutBytes: 0 },
          completedAt: new Date().toISOString(),
        };
      }
    }

    let sessionId: string;
    const isNewContext = req.newContext;
    const existingContextId = req.contextId;

    if (isNewContext || !existingContextId) {
      sessionId = await acpRunner!.createSession({ cwd: req.context?.cwd });
    } else {
      sessionId = existingContextId;
    }

    const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
    const runRes = await acpRunner!.sendMessage(sessionId, req.prompt, {
      timeoutMs,
      signal: ac.signal,
    });

    let status: TaskStatus = 'completed';
    let error: string | null = null;
    if (runRes.hint === 'aborted') {
      status = 'canceled';
      error = 'Canceled by cancel sentinel';
    } else if (runRes.hint === 'timeout') {
      status = 'timeout';
      error = `Exceeded timeoutMs=${timeoutMs}`;
    } else if (runRes.exitCode !== 0 && runRes.exitCode !== null) {
      status = 'failed';
      error = runRes.stderr.trim().slice(-500) || `ACP request failed`;
    }

    const session = acpRunner!.getSession(sessionId);

    return {
      taskId,
      agent: AGENT_NAME,
      status,
      summary: summarize(runRes.stdout, status),
      result: runRes.stdout,
      error,
      usage: {
        durationMs: runRes.durationMs,
        exitCode: runRes.exitCode,
        stdoutBytes: Buffer.byteLength(runRes.stdout, 'utf8'),
      },
      completedAt: new Date().toISOString(),
      contextId: isNewContext ? sessionId : (existingContextId ?? null),
      turnNumber: session?.turnCount,
    };
  };
```

- [ ] **Step 4: Wire ACP runner into runFreshContextTask**

Replace the existing `runFreshContextTask` call site inside `handleTask`. Find the line:

```typescript
        result = await runFreshContextTask(card, req, taskId, ac, startedAt, config);
```

Replace with:

```typescript
        if (acpRunner) {
          result = await runAcpTask(req, taskId, ac, startedAt, config);
        } else {
          result = await runFreshContextTask(card, req, taskId, ac, startedAt, config);
        }
```

- [ ] **Step 5: Wire ACP runner into the context path**

For the v1.1 context path (the `runCli` call around line 429), wrap the existing block. Find:

```typescript
      const runRes = await runCli(card, constructedPrompt, {
```

Replace with:

```typescript
      let runRes: import('./types.ts').RunnerResult;
      if (acpRunner) {
        let acpSessionId: string;
        if (req.newContext || !resolvedContextId) {
          acpSessionId = await acpRunner.createSession({ cwd: cwd });
        } else {
          acpSessionId = resolvedContextId;
        }
        runRes = await acpRunner.sendMessage(acpSessionId, req.prompt, {
          timeoutMs,
          signal: ac.signal,
        });
      } else {
        runRes = await runCli(card, constructedPrompt, {
          cwd,
          timeoutMs,
          signal: ac.signal,
          stdoutLogPath: stdoutLogPath(AGENT_NAME, taskId),
          stderrLogPath: stderrLogPath(AGENT_NAME, taskId),
        });
      }
```

Note: when using ACP, we send the raw prompt (not `constructedPrompt`) since the ACP server maintains session state in-memory. The existing disk-based context concatenation only applies to the spawn path.

- [ ] **Step 6: Shut down AcpRunner on worker shutdown**

In the `shutdown` function (around line 729), add before `closeLogger()`:

```typescript
    if (acpRunner) {
      await acpRunner.shutdown();
    }
```

- [ ] **Step 7: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/worker.ts
git commit -m "feat(acp): wire AcpRunner into worker — branch on card.transport"
```

---

### Task 6: End-to-End Validation Script

**Files:**
- Create: `scripts/validate-acp.sh`

- [ ] **Step 1: Create the ACP validation script**

```bash
#!/usr/bin/env bash
# End-to-end validation for ACP transport with gemini-worker.
# Verifies: ACP process spawns, session create, message round-trip,
# session continuation (turn 2 uses same session), graceful shutdown.

set -euo pipefail

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

LOG=/tmp/crewmate-validate-acp.log
: > "$LOG"

dump_log_on_fail() {
  printf '\n%s---- last 80 lines of %s ----%s\n' "$YELLOW" "$LOG" "$RESET" >&2
  tail -n 80 "$LOG" >&2 || true
}

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

# ── prerequisites ──
info "checking bun"
command -v bun >/dev/null 2>&1 || { fail "bun not on PATH"; exit 1; }
ok "bun $(bun --version)"

info "checking gemini CLI"
command -v gemini >/dev/null 2>&1 || { fail "gemini CLI not on PATH"; exit 1; }
ok "gemini present"

info "checking gemini --acp support"
if ! gemini --help 2>&1 | grep -q '\-\-acp\|acp'; then
  fail "gemini CLI does not support --acp flag. Update to latest version."
  exit 1
fi
ok "gemini --acp supported"

# ── init ──
info "running crewmate init"
with_timeout 30 bun src/cli.ts init >>"$LOG" 2>&1 || { fail "crewmate init failed"; dump_log_on_fail; exit 1; }
ok "crewmate init"

CREWMATE_DIR="$HOME/.crewmate"
GEMINI_DIR="$CREWMATE_DIR/gemini-worker"
cat > "$GEMINI_DIR/config.json" <<'JSON'
{ "poolSize": 1, "timeoutMs": 120000 }
JSON
ok "test config written (poolSize=1)"

# ── start pool ──
info "starting gemini-worker pool (ACP transport)"
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

info "waiting for inbox (up to 15s)"
WAITED=0
while [[ ! -d "$GEMINI_DIR/inbox" ]]; do
  if (( WAITED >= 15 )); then
    fail "inbox dir never appeared — pool failed to start"
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

# ── turn 1: newContext ──
TOKEN="ACP_T1_$(date +%s)"
PROMPT="Respond with exactly: $TOKEN"
info "sending task (newContext, token: $TOKEN)"

set +e
RESULT="$(with_timeout 150 bun src/cli.ts send gemini-worker "$PROMPT" --timeout=120000 --new-context 2>>"$LOG")"
SEND_EXIT=$?
set -e

if (( SEND_EXIT != 0 )); then
  fail "send exited with $SEND_EXIT"
  dump_log_on_fail
  exit 1
fi

STATUS="$(extract status)"
[[ "$STATUS" == "completed" ]] || { fail ".status was '$STATUS'"; dump_log_on_fail; exit 1; }
ok ".status == completed"

RESULT_TEXT="$(extract result)"
[[ "$RESULT_TEXT" == *"$TOKEN"* ]] || { fail ".result missing token"; dump_log_on_fail; exit 1; }
ok ".result contains token"

CTX_ID="$(extract contextId)"
if [[ -z "$CTX_ID" ]]; then
  fail ".contextId was empty — ACP may not be active"
  dump_log_on_fail
  exit 1
fi
ok ".contextId = $CTX_ID"

TURN="$(extract turnNumber)"
[[ "$TURN" == "1" ]] || { fail ".turnNumber was '$TURN' (expected 1)"; dump_log_on_fail; exit 1; }
ok ".turnNumber == 1"

# ── turn 2: continuation ──
TOKEN2="ACP_T2_$(date +%s)"
PROMPT2="Respond with exactly: $TOKEN2"
info "sending task (context=$CTX_ID, token: $TOKEN2)"

set +e
RESULT="$(with_timeout 150 bun src/cli.ts send gemini-worker "$PROMPT2" --timeout=120000 --context="$CTX_ID" 2>>"$LOG")"
SEND_EXIT=$?
set -e

if (( SEND_EXIT != 0 )); then
  fail "send (turn 2) exited with $SEND_EXIT"
  dump_log_on_fail
  exit 1
fi

STATUS="$(extract status)"
[[ "$STATUS" == "completed" ]] || { fail "turn 2 .status was '$STATUS'"; dump_log_on_fail; exit 1; }
ok "turn 2 .status == completed"

RESULT_TEXT="$(extract result)"
[[ "$RESULT_TEXT" == *"$TOKEN2"* ]] || { fail "turn 2 .result missing token"; dump_log_on_fail; exit 1; }
ok "turn 2 .result contains token"

CTX_ID2="$(extract contextId)"
[[ "$CTX_ID2" == "$CTX_ID" ]] || { fail "turn 2 contextId mismatch: '$CTX_ID2' vs '$CTX_ID'"; dump_log_on_fail; exit 1; }
ok "turn 2 contextId matches"

TURN2="$(extract turnNumber)"
[[ "$TURN2" == "2" ]] || { fail "turn 2 .turnNumber was '$TURN2' (expected 2)"; dump_log_on_fail; exit 1; }
ok "turn 2 .turnNumber == 2"

# ── done ──
printf '\n%s[OK]%s ACP transport validated (2 turns, session reuse confirmed)\n' "$GREEN" "$RESET"
exit 0
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/validate-acp.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/validate-acp.sh
git commit -m "test(acp): add e2e validation script for ACP transport"
```

---

### Task 7: Documentation Updates

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Add ACP transport section to CLAUDE.md**

After the "### Persistent contexts (v1.1)" section in `.claude/CLAUDE.md`, add:

```markdown
### ACP transport (v2.0)

Agents with `transport: 'acp'` in their card use a persistent stdio connection instead of spawn-per-task. The worker keeps a long-lived child process (`acpCommand`) and sends JSON-RPC messages for each task. Sessions are maintained in the agent's memory — no disk-based context concatenation needed. Non-ACP agents (`transport: 'spawn'`, the default) continue using the existing `runCli()` path. Currently only gemini-worker supports ACP via `gemini --acp`.
```

- [ ] **Step 2: Add ACP note to AGENTS.md**

After the "How to add a new worker" section in `AGENTS.md`, add:

```markdown
## ACP transport

Agents whose CLI supports the Agent Context Protocol can set `transport: 'acp'` and `acpCommand` in the registry. The worker spawns the CLI once and sends tasks as JSON-RPC `sessions/message` calls instead of spawning a fresh process per task. Sessions live in the agent's memory, eliminating disk-based context concatenation. Set `transport: 'spawn'` (or omit it) for CLIs that don't support ACP.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/CLAUDE.md AGENTS.md
git commit -m "docs: document ACP transport in CLAUDE.md and AGENTS.md"
```

---

## Self-Review Checklist

1. **Spec coverage:** All components covered — JSON-RPC client (Task 1), schema extension (Task 2), registry (Task 3), AcpRunner (Task 4), worker integration (Task 5), e2e test (Task 6), docs (Task 7).
2. **Placeholder scan:** No TBDs, TODOs, or "implement later" references. Every task has complete code.
3. **Type consistency:** `AcpRunner` returns `RunnerResult` (same type used by `runCli`), `AgentCard.transport` defaults to `'spawn'`, `acpCommand` is `string[]` matching `cliCommand`'s type. `JsonRpcClient.feed()` is called by `AcpRunner.drainStdout()`. All names are consistent.
4. **Backward compatibility:** `transport` defaults to `'spawn'`, so every existing agent card parses identically. The worker only enters the ACP path when `card.transport === 'acp'` AND `acpCommand` is set AND the ACP process starts successfully — otherwise it falls back to `runCli()`.
