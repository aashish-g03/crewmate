# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

crewmate is a localhost agent-mesh CLI that routes work from one coding agent (Claude Code) to others (Gemini, Kimi, Codex) via a filesystem mailbox. Workers are headless CLI processes supervised by a pool manager. Communication uses atomic `rename()` on a maildir-shaped tree under `~/.crewmate/`.

## Commands

```bash
bun install                          # install dependencies
bun src/cli.ts <command>             # run any CLI command from source
bun --watch src/cli.ts               # dev mode with auto-reload
bash scripts/validate.sh             # e2e round-trip test (gemini-worker, requires pool running)
bash scripts/validate-mcp.sh         # e2e MCP adapter test (starts pool + drives JSON-RPC)
bun run validate                     # alias for scripts/validate.sh
```

There is no build step — Bun runs TypeScript directly. There are no unit tests; validation is end-to-end via the bash scripts above, which require a running `gemini` CLI.

Type-check only: `bunx tsc --noEmit`

## Architecture

### Process model

`crewmate up <agent>` spawns a **supervisor** (`src/supervisor.ts`) that forks N **worker** child processes (`src/worker.ts`). Each worker watches `inbox/` via chokidar. When a task file appears, workers race to claim it via atomic `fs.rename()` into `workers/<pid>/` — exactly one wins, the rest get ENOENT. The winner runs the CLI binary via `src/runner.ts` (Bun.spawn), writes the result to `outbox/`, and archives the task to `processed/`.

### Mailbox tree (`~/.crewmate/<agent>/`)

```
inbox/        → pending tasks (FIFO, claimed via rename)
outbox/       → results (written atomically via tmp+rename)
workers/<pid> → claimed tasks, one dir per worker process
processed/    → completed task archive
cancel/       → zero-byte sentinels that trigger abort
logs/         → per-task stdout/stderr captures
contexts/     → v1.1 persistent multi-turn sessions
affinity/     → worker-PID claim sentinels for context routing
```

### Key source files

- **`src/cli.ts`** — Command dispatcher. Hand-rolled arg parser, no framework.
- **`src/envelope.ts`** — Zod schemas for TaskRequest, TaskResult, AgentCard, ContextMeta, ContextTurn. This is the wire protocol.
- **`src/agents/registry.ts`** — Built-in agent definitions (gemini/kimi/codex). Data-driven: add an entry here + `crewmate init` to register a new agent.
- **`src/transports/mailbox.ts`** — All filesystem I/O: atomic writes (tmp+rename), task claim, context CRUD, affinity sentinels.
- **`src/supervisor.ts`** — Pool manager: spawns workers, restarts on crash (1s backoff), recovers orphaned tasks, runs the TTL sweeper.
- **`src/worker.ts`** — Core claim-and-execute loop. v1.1 adds context-aware prompt construction, affinity routing, bloat warnings, and turn persistence.
- **`src/runner.ts`** — Subprocess executor. Substitutes `{prompt}` in `cliCommand` args. Handles timeout/abort with SIGTERM→SIGKILL escalation.
- **`src/mcp/server.ts`** — MCP adapter exposing 9 tools over stdio (uses `@modelcontextprotocol/sdk`).
- **`src/lifecycle/sweeper.ts`** — Archives idle contexts past their TTL.
- **`src/lifecycle/affinity-recovery.ts`** — Clears dead-pid affinity sentinels on supervisor startup and worker death.
- **`templates/mesh-router.md`** — Source template for the Claude Code subagent that `install-claude-agent` writes to `~/.claude/agents/`.

### Two adapters to Claude Code

1. **Bash subagent** — `crewmate install-claude-agent --global` writes `~/.claude/agents/mesh-router.md`. Claude Code spawns it as a Tier-2 subagent that runs `crewmate send`.
2. **MCP server** — `claude mcp add crewmate -- crewmate mcp` registers 9 tools (`crewmate_send_and_wait`, `crewmate_list_agents`, etc.) for structured communication.

### Concurrency invariants

- All writes visible to other processes use **atomic tmp+rename** (`writeJsonAtomic` in mailbox.ts).
- Task claiming uses **POSIX rename** atomicity — one worker wins, others get ENOENT.
- Affinity sentinels use **O_EXCL** (`fs.open(path, 'wx')`) for race-free context ownership.
- Workers are **read-only** relative to user repos. Only the orchestrator (Claude Code) edits files.

### Persistent contexts (v1.1)

Multi-turn sessions stored under `contexts/<contextId>/`. Prior turns are concatenated verbatim (no summarization) into the prompt. Affinity routing ensures only one worker processes a context at a time. TTL defaults to 30 minutes; archived contexts move to `contexts/.archived/`. Caps: 50 per agent, 10 per worker.

### ACP transport (v2.0)

Agents with `transport: 'acp'` in their card use a persistent stdio connection instead of spawn-per-task. The worker keeps a long-lived child process (`acpCommand`) and sends JSON-RPC messages for each task. Sessions are maintained in the agent's memory — no disk-based context concatenation needed. Non-ACP agents (`transport: 'spawn'`, the default) continue using the existing `runCli()` path. Currently only gemini-worker supports ACP via `gemini --acp`.

## Conventions

- Bun 1.1+ runtime, ESM modules, TypeScript with strict mode.
- Zod for all schema validation (envelope.ts is the source of truth for wire types).
- No test framework — validation scripts in `scripts/` are the test suite.
- `CREWMATE_HOME` env var overrides `~/.crewmate` for testing.
- Agent registry is data-driven: transport logic in shims, role intelligence in `.claude/agents/*.md` prompt files. Keep these concerns separate.

## Agent mesh delegation (MCP)

When the `crewmate` MCP server is connected, you have 9 tools for delegating work to external CLI agents. Use them instead of doing large-context reads, cross-vendor checks, or deep reasoning yourself.

### Routing rules

1. Call `crewmate_list_agents` first to discover which workers are ready.
2. Pick the right worker:
   - **gemini-worker** (ACP): Autonomous agent with file access. Can read files, explore the codebase, use tools. Just describe what you need — don't paste file contents. 2M context.
   - **kimi-worker** (spawn): Prompt-and-response only. Include all context in the prompt. Deep reasoning, second opinions.
   - **codex-worker** (spawn): Prompt-and-response only. Include all context in the prompt. Vendor diversity, cross-vendor reconciliation.
3. Call `crewmate_send_and_wait` with a clear prompt. ACP workers (gemini) can read files autonomously — just reference paths. Spawn workers (kimi, codex) need all context pasted inline.
4. Parse the structured result. If `.status != "completed"`, surface `.error`.

### When NOT to delegate

- You need to **edit** files (workers can read but should not write — the orchestrator owns mutations).
- The answer is already in your context.
- Single-file questions you can answer instantly.

### Persistent contexts

For multi-turn work, pass `newContext: true` on the first call, then `contextId` on follow-ups. Workers remember prior turns.
