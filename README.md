# crewmate

A localhost **agent-mesh CLI** that lets a single user run a small fleet of
headless coding-agent processes — Gemini, Kimi, Codex, anything with a
prompt-and-flag interface — and route work to them through a plain-old
filesystem mailbox.

It is inspired by Claude Code's internal Tier-2 cross-process mailbox pattern
(the leaked CC source ships a `~/.claude/teams/{team}/{recipient}.mailbox`
append-only file for cross-tmux teammates). `crewmate` generalizes that idea
into a per-task, per-agent mailbox tree with a supervised worker pool.

## Why

When you want a long-running auditor (Gemini's 2M context), a second-opinion
reasoner (Kimi), and a vendor-diversity refactorer (Codex) all reachable
from inside Claude Code or any other agent, you need a small, dumb routing
layer. `crewmate` is that layer:

- **Dumb on purpose.** It transports prompts and runs CLIs. No personas, no
  prompt templating, no role logic. Personality lives in
  `.claude/agents/*.md` files — a separate concern.
- **Filesystem-native.** No daemon, no socket, no port. Workers and senders
  rendezvous through atomic `rename()` calls on a maildir-shaped tree.
- **Supervised.** A parent process keeps N worker children alive and
  propagates signals correctly.

## Install & quickstart

### Prerequisites

- [Bun](https://bun.sh) 1.3+ (`curl -fsSL https://bun.sh/install | bash`)
- At least one CLI agent installed and authenticated:
  - **Gemini CLI**: `npm i -g @google/gemini-cli` then `gemini` once to authenticate
  - **Kimi CLI** (optional): `uv tool install --python 3.13 kimi-cli` then `kimi` once to set model + API key
  - **Codex CLI** (optional): `npm i -g @openai/codex`

### From npm (once published)

```bash
npm i -g crewmate
```

### From source (development / before npm publish)

```bash
git clone https://github.com/aashish-g03/crewmate.git
cd crewmate
bun install
bun link          # makes `crewmate` available globally in your shell
```

### Setup

```bash
# Create ~/.crewmate and seed the built-in agent dirs
crewmate init

# Check which agents are ready (CLI binary installed + on PATH)
crewmate doctor
```

### Connect to Claude Code

Two adapters — use one or both:

```bash
# Option A: Bash subagent (always available, zero extra deps)
crewmate install-claude-agent --global
# → writes ~/.claude/agents/crewmate.md
# → any Claude Code session can now spawn the crewmate subagent

# Option B: MCP adapter (adds streaming progress + structured tools)
claude mcp add crewmate -- crewmate mcp
# → registers 9 tools: send_and_wait, list_agents, status, cancel,
#   new_context, list_contexts, show_context, destroy_context, purge_archived
```

**Verify:**
```bash
crewmate doctor                        # gemini-worker: ready
ls ~/.claude/agents/crewmate.md        # exists
claude mcp list                        # shows crewmate (if MCP added)
```

### Daily use

```bash
# Start a worker pool (blocks — run in a dedicated terminal or tmux pane)
crewmate up gemini-worker

# In another shell — delegate a task
crewmate send gemini-worker "Audit src/ for dead code" --timeout=120000

# Or let Claude Code delegate for you:
# just ask Claude and crewmate will route to the right worker.

# Useful companions while a delegation runs:
crewmate watch                         # tail per-task stdout/stderr logs
crewmate status                        # queue depths per agent
crewmate list                          # agents + readiness + load
crewmate tail                          # mesh-wide event log
```

See `crewmate --help` for the full command grid.

## Mailbox layout

```
~/.crewmate/
  log.jsonl                              # mesh-wide append-only NDJSON event log
  <agent>/
    agent-card.json                      # capability self-description
    config.json                          # { poolSize: 1, timeoutMs: 300000 }
    inbox/<taskId>.task.json             # FIFO; workers race to claim via rename
    outbox/<taskId>.result.json          # results
    cancel/<taskId>                      # zero-byte sentinel for cancellation
    workers/<pid>/<taskId>.task.json     # claimed work, owned by one worker
    processed/<taskId>.task.json         # archive of completed tasks
    logs/<taskId>.{stdout,stderr}.log    # captured CLI streams
```

## Envelopes

Every task on the wire is a JSON `TaskRequest` (uuid, prompt, optional
`context.cwd`, `timeoutMs`, `createdAt`). Every reply is a `TaskResult` —
the shape is intentionally identical to Claude Code's `<task-notification>`:

```json
{
  "taskId": "…",
  "agent": "gemini-worker",
  "status": "completed",
  "summary": "First line of stdout, truncated to 200 chars",
  "result": "…full stdout…",
  "error": null,
  "usage": { "durationMs": 12345, "exitCode": 0, "stdoutBytes": 4096 },
  "completedAt": "2026-04-26T16:30:00.000Z"
}
```

## Concurrency model

`crewmate up <agent>` reads `~/.crewmate/<agent>/config.json` for `poolSize`
(default 1, auto-scales to `maxWorkers` which defaults to 5) and spawns N child processes via `Bun.spawn`. The parent
*supervises*: if a child exits unexpectedly it gets respawned after a 1 s
backoff. SIGINT/SIGTERM propagates downward.

Each child:

1. Watches `inbox/` with chokidar (`awaitWriteFinish` so we never see a
   half-written task).
2. On every `add` event, attempts `fs.rename(inbox/<id>, workers/<pid>/<id>)`.
   POSIX rename is atomic — exactly one worker wins, the rest get `ENOENT`
   and silently move on. This is the "atomic-claim trick" that lets the pool
   stay coordination-free.
3. Runs the CLI via `runner.ts` (`Bun.spawn` with stdin ignored, stdout/stderr
   tee'd to `logs/<id>.{stdout,stderr}.log`).
4. Writes the `TaskResult` to `outbox/<id>.result.json.tmp` then renames to
   `<id>.result.json` so the sender never reads a partial JSON object.
5. Moves the claimed file into `processed/`.

Cancellation rides a parallel chokidar watch on `cancel/`. When
`cancel/<id>` appears for a task the worker owns, the worker aborts an
`AbortController`; the runner SIGTERMs the child, waits 2 s, then SIGKILLs.

## Built-in agents

| name              | model  | context  | transport    | strengths                                     |
| ----------------- | ------ | -------- | ------------ | --------------------------------------------- |
| `gemini-worker`   | gemini | 2 M      | ACP (native) | large-codebase audit, hallucination check     |
| `kimi-worker`     | kimi   | 256 K    | ACP (shim)   | deep reasoning, second opinion                |
| `codex-worker`    | codex  | 200 K    | ACP (shim)   | OpenAI-family refactors, vendor diversity     |

Add your own by appending to `src/agents/registry.ts` and re-running
`crewmate init`, or by hand-writing an `agent-card.json` under
`~/.crewmate/<your-agent>/`.

## Connecting Claude Code (and friends)

Two adapters, same engine underneath. Pick one or use both.

### Option A — MCP (recommended for Claude Code, Cursor, Zed)

MCP gives you structured tools, streaming progress, and per-tool
permissions. This is the recommended path for daily use.

```bash
claude mcp add crewmate -- crewmate mcp
```

Claude Code gets 9 tools directly — no subagent needed:

| Tool | Purpose |
|---|---|
| `crewmate_list_agents` | Discover ready workers + load |
| `crewmate_send_and_wait` | Delegate and wait for result (with streaming progress) |
| `crewmate_status` | Non-blocking poll of a task or queue depths |
| `crewmate_cancel` | Abort a stuck task |
| `crewmate_new_context` | Mint a persistent context before first turn |
| `crewmate_list_contexts` | List active persistent contexts |
| `crewmate_show_context` | Inspect a context's transcript |
| `crewmate_destroy_context` | Archive a context |
| `crewmate_purge_archived` | Permanently delete old archived contexts |

Routing guidance (when to pick which worker) is in `.claude/CLAUDE.md` —
Claude Code reads it automatically when working in this project. For
global use, copy the routing section to `~/.claude/CLAUDE.md`.

### Option B — Bash subagent (universal, works from any shell)

For non-MCP clients, or when you want a dedicated routing subagent:

```bash
crewmate install-claude-agent --global    # → ~/.claude/agents/crewmate.md
```

This installs `crewmate`, a subagent that delegates via
`crewmate send` in Bash. It discovers workers via `crewmate doctor --json`
and only delegates to ready ones. Stderr streams live worker output.

```bash
# Or use crewmate send directly from any terminal:
crewmate send gemini-worker "audit src/ for dead code" --timeout=120000
```

### Which to choose?

| | MCP | Bash subagent |
|---|---|---|
| Streaming progress | Native MCP notifications | Stderr lines |
| Tool discovery | Shows in Claude Code UI | Hidden behind crewmate subagent |
| Works outside Claude Code | No (MCP-aware clients only) | Yes (any shell) |
| Routing logic lives in | `.claude/CLAUDE.md` | `crewmate.md` template |
| Setup | `claude mcp add` (one command) | `crewmate install-claude-agent` |

Both adapters call into the same `crewmate core` — same mailbox, same
workers, same result envelopes. A future A2A adapter would slot in the
same way.

## v1 contract (read this before delegating)

The mesh ships **read-only and non-interactive by default**, on purpose:

1. **Workers cannot ask for permissions.** Their stdin is the mailbox,
   not a terminal — an interactive approval prompt would hang the worker
   forever. v1 hardcodes read-only flags at launch:
   - `gemini-worker` launches with `--approval-mode plan` (read-only).
   - `kimi-worker` launches with `--quiet --plan` (read-only).
   - `codex-worker` launches with `exec --skip-git-repo-check`.

   v1 has **no supported override path**. Editing
   `~/.crewmate/<agent>/agent-card.json` on disk does *not* survive the
   next `crewmate init` — it gets overwritten from the registry. The
   trust boundary is intentionally locked at the package level for v1.

   v1.1 adds bounded per-pool ceilings (`permissions.allowed_modes` in
   `agent-card.json`) plus a per-task `--mode=` flag rejected if it
   exceeds the pool's ceiling. The orchestrator picks within the
   envelope a human set at `crewmate up` time; it cannot escalate
   itself. Tracked at the bottom of this README.

2. **Workers cannot ask the orchestrator clarifying questions.** Each
   `send` is a fresh worker context **by default**: prompt in, text out.
   If the worker's answer is "I need more info, can you clarify X?",
   that's just text in the result. The orchestrator (Claude Code,
   crewmate subagent, …) reads it, decides, and issues a *new* `send` with the
   clarification appended. No multi-turn protocol at the mesh level.

   v1.1 adds **opt-in persistent contexts** (`--context=`, `--new-context`,
   `contextId` on the MCP tool) that let a worker retain prior turns
   across sends — see "Persistent contexts (v1.1)" below. Fresh-context-
   per-send remains the default; existing v1 callers do not break.
   ACP agents maintain session state in-memory; the worker maps between
   crewmate context IDs (`ctx_...`) and ACP session IDs.

3. **The orchestrator can still talk to the user.** That happens through
   Claude Code's normal subagent conversation flow — `crewmate` is a
   regular subagent and has multi-turn dialogue with the user for the
   duration of its `Task` invocation. The mesh has nothing to do with
   that path; it only governs *downward* delegation to workers.

If you need a worker that asks for permissions, runs interactively, or
holds a multi-turn session, that is a v2 feature ("permission proxy" /
"persistent runner") and not in this release. Don't try to retrofit it
through the mailbox — it won't end well.

## Persistent contexts (v1.1)

Workers can now retain conversation history across `crewmate send` calls.
Pass a `contextId` to continue a prior conversation; mint a fresh one
when topics shift. The default is unchanged — every send is fresh-context
unless you explicitly opt in.

### Bash

```bash
# First turn — mint a context
crewmate send gemini-worker --new-context --owner-hint=auth-audit \
  "Read src/auth/ and summarize the architecture" --timeout=300000
# → TaskResult JSON includes "contextId": "ctx_a3k7m2p9", "turnNumber": 1

# Follow-up — pass the contextId back
crewmate send gemini-worker --context=ctx_a3k7m2p9 \
  "Now check JWT validation specifically" --timeout=300000
# → "turnNumber": 2; the worker has full prior context, no re-reading

# Another follow-up
crewmate send gemini-worker --context=ctx_a3k7m2p9 \
  "List every place a token is decoded" --timeout=300000
# → "turnNumber": 3
```

`--context`, `--new-context`, and `--owner-hint` interact: `--owner-hint`
is only meaningful when minting (with `--new-context`); `--context` and
`--new-context` together is an error. Manage contexts directly with:

```bash
crewmate context list [<agent>]                  # list active contexts
crewmate context show <contextId>                # dump meta + turn history
crewmate context destroy <contextId>             # explicit cleanup
crewmate context purge --older-than=7d           # bulk-clean archives
```

### MCP

```
// First turn
result = crewmate_send_and_wait({
  agent: "gemini-worker", prompt: "...", newContext: true, ownerHint: "auth-audit"
})
// result.structuredContent.contextId === "ctx_a3k7m2p9"

// Follow-up
result = crewmate_send_and_wait({
  agent: "gemini-worker", prompt: "...", contextId: "ctx_a3k7m2p9"
})
```

Companion tools: `crewmate_new_context(agent, ownerHint?)`,
`crewmate_list_contexts(agent?)`, `crewmate_show_context(contextId)`,
`crewmate_destroy_context(contextId)`. As with the CLI, `contextId` and
`newContext` on `crewmate_send_and_wait` are mutually exclusive.

### Result envelope additions

The `TaskResult` shape gains two fields when contexts are in use:

```json
{
  "taskId": "…",
  "agent": "gemini-worker",
  "status": "completed",
  "result": "…",
  "contextId": "ctx_a3k7m2p9",   // null for fresh-context calls
  "turnNumber": 2,                // 1-indexed; null for fresh-context calls
  "usage": { "durationMs": 12345, "exitCode": 0, "stdoutBytes": 4096 },
  "completedAt": "2026-04-26T16:30:00.000Z"
}
```

### Why this exists

Gemini, Kimi, and Codex don't share a prompt cache. Re-sending a 500K-token
codebase reading on every follow-up pays full token cost on every call.
Persistent contexts let you read once, ask many times — the cost-asymmetric
read pattern from the [Junyi-mesh peer model](https://www.junyi.dev/en/posts/agent-mesh/).

v1.1 uses **raw transcript concatenation** under the hood, not summarization:
every follow-up re-sends prior turns verbatim, so token cost grows linearly
with turn count. Mint fresh when topics shift; the CLI emits stderr
warnings as the concatenated prompt crosses 50K / 100K / 200K chars.

### Lifecycle and limits

- **TTL**: 30 minutes idle, archived (not deleted) under `contexts/.archived/`.
- **Caps**: 10 contexts per worker, 50 per agent. Both fail loud with
  `error_code: pool_context_full`.
- **Worker crash mid-context**: returns `error_code: context_lost`; turn
  files on disk are intact, mint fresh and re-include critical content.
- **No cross-orchestrator sharing.** A `contextId` is meaningful only on
  the host that minted it.

See [`AGENTS.md`](./AGENTS.md#working-with-persistent-contexts) for the
deeper "when to use" guide and the on-disk layout, and
[`templates/crewmate.md`](./templates/crewmate.md) for the orchestrator
playbook.

## Design notes (Tier-2 inspiration)

The reference pattern in Claude Code's `LocalAgentTask` / `SendMessageTool`
keeps a single append-only mailbox per recipient. That works great for
chat-style notifications — order matters, broadcast is rare. For a worker
pool the requirements flip: many workers per recipient, work needs to be
exclusively claimed, results need to be addressable by id. The maildir
shape (`new/`, `cur/`, `tmp/`) is the canonical answer to that, so
`crewmate` borrows it: `inbox/` is `new/`, `workers/<pid>/` is `cur/`, and
the atomic-rename claim is exactly the `Maildir++` recipe.

## Development

For contributors running from source:

```bash
bun install
bun src/cli.ts init
bun src/cli.ts up <agent>
bun src/cli.ts send <agent> "prompt"
```

Use `bun link` to test the `crewmate` binary globally.
