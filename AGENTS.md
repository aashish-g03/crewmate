# AGENTS

`crewmate` is a localhost agent mesh. This file documents the **role split** between Claude Code (the orchestrator) and the CLI workers it delegates to, and explains why those roles live where they do.

## The team

| Role | Agent | When to use |
|------|-------|-------------|
| Architect & executor | **Claude Code** (parent process) | Holds project context, edits files, runs builds, makes decisions. Always the entrypoint. |
| Long-context auditor | **gemini-worker** (Gemini CLI, 2M ctx) | Read >50 files, verify a load-bearing claim against actual source, summarize a whole codebase, hallucination check. |
| Deep reasoner | **kimi-worker** (Kimi CLI — placeholder) | Algorithmic problems, second opinion on tricky logic. Wired in the registry; binary not yet installed. |
| Vendor diversity | **codex-worker** (Codex CLI — placeholder) | GPT-family refactor styles, cross-vendor reconciliation when two answers disagree. |

The split is borrowed from https://www.junyi.dev/en/posts/agent-mesh/ and adapted: instead of running each role as a separate orchestrator, we keep Claude Code as the single architect and treat the other CLIs as **specialized oracles** invoked through the mesh.

## Why role specialization lives at the prompt layer

Claude Code's internal Tier-2 subagent system (`SendMessageTool.ts`, `LocalAgentTask.tsx`) makes the dispatcher deliberately dumb: every subagent invocation is the same model with a different system prompt loaded from `.claude/agents/*.md`. The role lives in the prompt; the runtime is fungible.

`crewmate` extends this idea across **process and vendor boundaries**. Each worker shim (`src/agents/*.ts`) is a thin wrapper that knows how to spawn a CLI binary, write a prompt to stdin, and read structured output back. The shim has no opinion about *what* the worker is good at — that opinion lives in:

- `.claude/agents/mesh-router.md` — tells Claude Code when to delegate and to whom.
- `.claude/agents/<worker>.md` — reference cards describing each worker's strengths.
- This file — the human-readable team charter.

Putting role intelligence in shims would couple two things that should evolve independently: the transport (process management, JSON envelopes, timeouts) and the policy (which model is good at what). The transport is solved once. The policy changes every time a new model ships.

## How to add a new worker

1. **Pick a name** following the `<vendor>-worker` convention (e.g. `qwen-worker`).
2. **Write the shim** in `src/agents/registry.ts`: register the binary, args, env, and any output post-processing.
3. **Write the descriptor** at `.claude/agents/<name>.md` with `tools: []` frontmatter and a body covering: strengths, weaknesses, invocation, result shape. Use `gemini-worker.md` as a template.
4. **Add a row to the team table above** so humans know when to reach for it.
5. **Update `mesh-router.md`** with the new role in the "team" section and any decision-heuristic changes.
6. **Materialize the dirs**: `crewmate init` reads the registry and creates `~/.crewmate/<name>/{inbox,outbox,config.json,card.json}`.
7. **Validate**: extend `scripts/validate.sh` with a round-trip test for the new agent (or write `scripts/validate-<name>.sh` if it's heavyweight).

## Triangulation example

When a claim is load-bearing and you're uncertain, fan out to all three workers in parallel and reconcile. From `mesh-router`:

```bash
PROMPT="Does the function applyEdit in src/tools/EditTool.ts mutate its input?"
crewmate send gemini-worker "$PROMPT" --timeout=300000 > /tmp/mesh-gemini.json &
crewmate send kimi-worker   "$PROMPT" --timeout=300000 > /tmp/mesh-kimi.json   &
crewmate send codex-worker  "$PROMPT" --timeout=300000 > /tmp/mesh-codex.json  &
wait
jq -r .result /tmp/mesh-gemini.json /tmp/mesh-kimi.json /tmp/mesh-codex.json
```

Three opinions vote: when two agree and one dissents, the dissent is a flag worth investigating but the majority usually wins. When all three disagree, the question was malformed — re-pose it before acting.

## Working with persistent contexts

v1.1 introduces **persistent worker contexts**: an opt-in way to give a worker memory across multiple `crewmate send` calls. The default is still fresh-context-per-send; nothing changes for v1.0 callers. When you opt in by passing a `contextId` (or asking for a new one with `--new-context`), the worker reads prior turns from disk, prepends them as a transcript prefix to the new prompt, and appends the new turn after responding.

### Why they exist

Two real costs in a multi-vendor mesh push back against the "fresh context every send" default:

1. **No shared prompt cache between vendors.** Gemini, Kimi, and Codex each maintain their own caches. Re-sending a 500K-token codebase reading on every follow-up pays full token cost every time.
2. **The Junyi-mesh peer pattern** ([junyi.dev/en/posts/agent-mesh](https://www.junyi.dev/en/posts/agent-mesh/)) treats Gemini as a long-lived peer that retains codebase understanding across many queries. "Read the entire repo, then answer 20 questions about it" only works as a peer pattern if the peer retains what it read.

Contexts let an orchestrator establish "Gemini as repo expert for `auth/`" once and consult it cheaply across an afternoon's worth of work, instead of paying re-read cost on every question.

### On-disk layout

A context is just a directory under the agent's mailbox tree, alongside the existing `inbox/`, `outbox/`, `workers/`:

```
~/.crewmate/<agent>/
  contexts/
    <contextId>/
      meta.json                  # { ownerHint, createdAt, lastUsedAt, turnCount }
      turn_001.json              # { prompt, result, timestamp, ... }
      turn_002.json
      ...
    .archived/<contextId>/       # contexts past TTL get moved here, not deleted
  affinity/
    <contextId>                  # zero-byte file containing the claiming worker's PID
```

The result envelope gains two fields when contexts are in use: `contextId` (the id, or `null` for fresh-context calls) and `turnNumber` (1-indexed turn count).

### The architectural choice: raw concat over summarization

v1.1 builds the per-turn prompt by **concatenating prior turn JSONs verbatim** as a transcript prefix, with no summarization step. The reasoning:

- Summarization is lossy in ways that are hard to debug. A summarizer that drops the one detail you needed is worse than no summarizer.
- Token cost is at least predictable: the orchestrator can see exactly what's being sent and decide when to mint fresh.
- Adding a summarization layer in v1.1 would require its own model choice, prompt, eval pipeline, and failure mode for "summarizer hallucinated." Punted to v1.2 once we have evidence about which contexts actually need it.

The trade-off is that token cost grows linearly with turn count. Orchestrators are expected to mint fresh contexts when topics shift, and the CLI emits stderr warnings as the concatenated prompt approaches 50K / 100K / 200K chars to make this visible.

### Forward-compat with v2.0 ACP

The envelope additions (`contextId`, `turnNumber`) are deliberately the same shape v2.0 will use when we swap the spawn-per-task runner for an ACP (Agent Context Protocol) persistent runner. In v2.0, `contextId` becomes the ACP `sessionId` — a real session handle the worker process keeps in memory — instead of just a directory name. The wire format for orchestrators stays identical across the upgrade; what changes is what happens behind the mailbox.

This means orchestrators written against v1.1 contexts keep working under v2.0 without code changes. The directory-based concat is a deliberately humble first cut at the same surface.

### Operational notes

- **TTL.** Idle contexts archive after 30 minutes (resets on every use). Archived contexts move to `contexts/.archived/<id>/` instead of being deleted, so you can recover a transcript if you mint-and-regret. Bulk-purge with `crewmate context purge --older-than=7d`.
- **Caps.** 10 contexts per worker, 50 per agent. Both caps fail loud with `error_code: pool_context_full` rather than evicting silently — the orchestrator decides what to discard.
- **Worker crash.** If the worker process holding affinity for a context dies mid-turn, the next send returns `error_code: context_lost`. Turn files on disk are intact; the orchestrator can mint fresh and re-include any critical prior content by hand.
- **No cross-orchestrator sharing.** A `contextId` is meaningful only to the mesh on the machine that minted it. Don't pass one across hosts or users.
- **Inspecting state.** `crewmate context list <agent>`, `crewmate context show <id>`, `crewmate context destroy <id>`. The MCP equivalents are `crewmate_list_contexts`, `crewmate_show_context`, `crewmate_destroy_context`, and `crewmate_new_context`.

## Operational notes

- `crewmate up <agent>` is a long-running supervisor. Start it manually or via `scripts/validate.sh`. Never start it from inside a subagent.
- `crewmate send` is the only mutation a subagent should make against the mesh. It's bounded, idempotent at the protocol level, and always returns JSON.
- Workers are read-only relative to this repo. They cannot edit files or run your build. If a task needs mutation, the architect (Claude Code) does it.
