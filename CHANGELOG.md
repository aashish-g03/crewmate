# Changelog

All notable changes to crewmate will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/) once we tag the first release.

## [0.2.0] — Persistent worker contexts (v1.1) — pending merge

> Strictly additive over v0.1.0. Every existing CLI invocation and every
> existing MCP tool call produces byte-identical results to v0.1.0 when no
> v1.1 fields are passed. Verified by normalized-diff against the v1.0
> canonical assertion pattern (empty diff modulo timing/UUID/epoch noise).

### Added — context lifecycle

- **Persistent contexts via mailbox-stored history.** Workers now retain
  conversation across `crewmate send` calls when the caller passes a
  `contextId` (continuation) or `--new-context` / `newContext: true` (mint).
  Default behavior is unchanged: every send is fresh-context.
- **Mailbox layout extension.** New per-agent subdirs at
  `~/.crewmate/<agent>/`:
  - `contexts/<contextId>/{meta.json, turn_NNN.json}` — active sessions.
  - `contexts/.archived/<contextId>/` — TTL-expired or explicitly destroyed.
  - `affinity/<contextId>` — atomic O_EXCL claim sentinel for forward-compat
    with v2.1 ACP runner; in v1.1 it serializes per-context turn writes.
- **Envelope additions** (all optional, all backward-compatible):
  - `TaskRequest`: `version`, `contextId`, `newContext`, `ownerHint`, `ttlMs`.
  - `TaskResult`: `contextId` (or null), `turnNumber` (or absent).
- **Lifecycle subsystems**:
  - TTL sweeper (default 30 min idle → archive) running in the supervisor
    every 5 minutes; survives transient errors per-context.
  - Dead-PID affinity recovery on supervisor startup AND after every
    `worker_died` event.
  - Per-worker cap (10 contexts) and per-agent cap (50 contexts), both
    fail-loud with `pool_context_full` rather than silent eviction.

### Added — Bash CLI surface

- `crewmate send <agent> <prompt>` gains four new flags:
  - `--context=<contextId>` — continue an existing conversation.
  - `--new-context` — mint a fresh context; result returns the new
    contextId.
  - `--owner-hint=<tag>` — free-form label stored on the new context's
    `meta.json` for `context list` filtering.
  - `--ttl-ms=<ms>` — override the default 30-minute idle TTL when minting.
- `crewmate context list [<agent>] [--json]` — list active contexts with
  turn count, age, owner hint, total bytes, current affinity holder.
- `crewmate context show <contextId> [--tail=N | --turn=N] [--agent=<name>]`
  — full transcript, with the reconstructed prompt that would be sent for
  the next turn (debugging aid for prompt bloat).
- `crewmate context destroy <contextId> [--agent=<name>]` — archive
  (rename to `.archived/`); does NOT delete from disk.
- `crewmate context purge --older-than=<duration> [--agent=<name>]` —
  permanently delete archived contexts older than the duration. The only
  permanent-delete operation in the mesh.

### Added — MCP adapter

Five new tools (total now 9) plus extensions to `crewmate_send_and_wait`:

- `crewmate_send_and_wait` — added optional `contextId`, `newContext`,
  `ownerHint`, `ttlMs` params. Mutual exclusion of `contextId` +
  `newContext` returns `isError` with a clear message.
- `crewmate_new_context(agent, ownerHint?, ttlMs?)` — mint without sending
  a task. Useful for "establish a session before the first delegation."
- `crewmate_list_contexts(agent?)` — same data as `crewmate context list`,
  always structured.
- `crewmate_show_context(contextId, agent?, tail?, turn?)` — full
  transcript for orchestrator self-inspection.
- `crewmate_destroy_context(contextId, agent?)` — archive a context.
- `crewmate_purge_archived(olderThan, agent?)` — permanent delete.

`crewmate_list_agents` extended with operational state for load-aware
routing: each agent entry now includes `load: { inboxDepth, claimedDepth,
poolSize, loadFactor }`. Orchestrators can route to less-loaded workers
without a second tool call.

`crewmate_send_and_wait` emits a final progress notification including
`contextId` and `turnNumber` when those values are present, so MCP hosts
can show "completed turn N of context ctx_xxx" before the result lands.

### Added — Operational tooling

- `scripts/probe-storage.ts` — storage-layer integration probe (8/8 OK).
- `scripts/probe-context.ts` — worker-side context handling (4/4 turns
  including a v1-shape fallback).
- `scripts/probe-lifecycle.ts` — TTL sweeper + dead-pid affinity recovery
  (5/5 OK).
- `scripts/probe-cli-context.ts` — Bash CLI end-to-end (14/14 OK against
  real Gemini).
- `scripts/probe-junyi.ts` — Junyi-pattern peer e2e test (3 follow-ups
  on a context-asymmetric load). Results: caller-side cost reduced 800×
  (0.14% of turn-1 prompt size); semantic continuity confirmed
  (turn 4 quoted exact source from turn 1's inlined content); wall-clock
  reduced 35% (raw-concat ceiling — v1.2 summarization will deliver the
  full <50% target).
- `scripts/check-docs.sh` — doc-vs-code reconciliation gate. Extracts the
  Bash subcommand surface from `crewmate --help` and the MCP tool surface
  from `src/mcp/server.ts`'s `registerTool` calls, fails if any name is
  missing from README / AGENTS / mesh-router docs. Catches drift introduced
  by parallel-agent builds.
- `scripts/validate-mcp.sh` extended from 11 to 33 assertions covering the
  new tools.

### Changed

- `LogEvent` type adds optional fields: `contextId`, `turnNumber`,
  `ownerHint`, `capacity`, `currentCount`, `promptBytes`, `orphanPid`,
  `tool`, `stdoutBytes`. Strictly additive — every prior log event still
  validates.
- README, AGENTS.md, and `templates/mesh-router.md` (plus the
  byte-identical `.claude/agents/mesh-router.md` copy) extended with
  context-discipline guidance: when to use, when not to, the mechanical
  recipes for both Bash and MCP, lifecycle limits.
- Mesh-router subagent template instructs Claude to also call
  `crewmate_list_contexts` (or `crewmate context list`) at session start
  to discover existing peer contexts before minting new ones.

### Fixed

- Dropped the dead `headlessFlag` field from `AgentCard` (was schema-declared,
  registry-set, never consumed by runtime). On-disk `agent-card.json` files
  with the field still load via `.passthrough()`; next `crewmate init`
  rewrites them clean.
- Removed misleading `setupHint` strings that pointed users at editing
  `agent-card.json` for permission overrides — `crewmate init` overwrites
  on every run, so those edits don't survive. v1.1 has no supported
  override path; bounded per-pool ceilings ship in v1.1-perms (separate
  task).
- `validate.sh` portable-timeout wrapper (introduced in 0.1.0) was correctly
  hooked via `pkill -P` so the watchdog's child `sleep` can't keep the
  command-substitution pipe open. Resolved the 150s→9s validation
  regression that surfaced during v1.1 build.

### Migration notes for v1.0 callers

**Nothing changes.** All four assertions of zero-regression were verified:

1. `bash scripts/validate.sh` produces a normalized output identical to
   the v1.0 canonical pattern (empty diff).
2. A `TaskRequest` envelope with no v1.1 fields parses identically.
3. A `TaskResult` from a fresh-context send has no `contextId` /
   `turnNumber` keys (omitted, not null) — same shape as v1.0.
4. The 4 v1.0 MCP tools and their parameter shapes are unchanged.

To opt in: add `--new-context` / `--context=` flags to `crewmate send`,
or pass `contextId` / `newContext` to `crewmate_send_and_wait`. See README
"Persistent contexts" section.

### Known gaps deferred to v1.2 / v2

- **Wall-clock <50% follow-ups.** Raw concat sends a growing prefix; full
  win requires v1.2 summarization (compress prior turns into a recap
  before re-sending) or v2.1 ACP runner (gemini holds session state).
- **No bounded permission override.** Workers run with hardcoded
  read-only flags (`--approval-mode plan`, `--plan`, etc.). v1.1-perms
  (separate work item) adds per-pool ceilings + per-task `--mode=`.
- **No persistent ACP runner.** Each `crewmate send` still spawns a fresh
  CLI subprocess; cold-start tax (~1-2 s/turn) survives. v2.1 wires up
  `gemini --acp` / `kimi acp` for true session reuse.
- **No structured-error envelope with `fix_hint`.** Errors are strings.
  v1 polish work item.
- **No retry / history / budget tools.** v1 polish.

## [0.1.0] — Initial public release — pending tag

The v1.0 baseline: localhost agent-mesh CLI with Bash + MCP adapters,
filesystem mailbox, orphan re-queue, supervised worker pools with atomic
inbox claim. Every `crewmate send` is fresh-context. See README "v1
contract" for full scope.
