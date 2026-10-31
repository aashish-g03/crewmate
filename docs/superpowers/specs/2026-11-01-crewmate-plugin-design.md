# crewmate v1: one Claude Code plugin for other vendors' coding agents

Status: draft, revision 3 (2026-11-01), after an EGM goldfish review and its re-audit (reports in [`egm-review-2026-11-01/`](egm-review-2026-11-01/))
Author: Aashish Gupta (decisions), drafted with Claude
Replaces: the v0.2 architecture (filesystem mailbox, worker pool, MCP server, Bash subagent), described in [`README.md`](../../../README.md) and [`docs/superpowers/plans/2026-05-04-acp-transport.md`](../plans/2026-05-04-acp-transport.md).

## Terms

- **Vendor:** a coding-agent CLI crewmate can drive. v1 has two vendor names: `codex` (OpenAI Codex CLI) and `gemini` (Google's Antigravity CLI, `agy`, which runs Gemini models).
- **Job:** one prompt sent to one vendor, with its own id, event log and final answer.
- **Goldfish / elephant:** terms from Google's [Elephant-Goldfish Model (EGM)](https://github.com/google/elephant-goldfish-model) ([egm.dev](https://egm.dev); the repo says it is not an officially supported Google product). The *elephant* is the agent that holds the full conversation and writes a design; a *goldfish* is a reviewer that starts with no conversation context, so gaps the author filled in mentally become visible.
- **Monitor:** a Claude Code tool that runs a command in the background and delivers each line it prints to the conversation as a notification. It has a timeout (default 5 minutes, at most 30), and it stops a command that prints too many lines.
- **ACP:** [Agent Client Protocol](https://agentclientprotocol.com), a JSON-RPC protocol for talking to coding agents. v0.2 used it; v1 does not.

## 1. Problem

Aashish uses Claude Code as his main agent and wants it to hand work to other vendors' coding agents for second opinions, large-context reads and delegated work. Today separate projects each cover a slice of this:
- OpenAI's [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc): Codex only
- [`gemini-mcp-tool`](https://github.com/jamubc/gemini-mcp-tool): Gemini only
- [PAL, formerly Zen](https://github.com/BeehiveInnovations/pal-mcp-server): multi-model tools over provider APIs
- [EGM](https://github.com/google/elephant-goldfish-model): zero-context spec reviews by fresh Claude subagents

He wants one project that covers the goals in section 2, works from any of his sessions, and that other people can install in two commands.

crewmate v0.2 tries this and fails in three observed ways:

1. **No progress reaches the user.** Claude spawns the `crewmate` Bash-only subagent, which runs `crewmate send` in the foreground. `send` prints each worker tool call to stderr, but that output stays inside the subagent's Bash call; Claude Code shows the parent session only the subagent's final message. The MCP route (`send_and_wait`) sends progress notifications, but they only say "queued", "claimed by pid=…" and "running, 25s elapsed"; the real tool-call events are written to `logs/<task>.progress.log` and never forwarded.
2. **Tasks silently stall.** Unless `crewmate up <agent>` is running in another terminal, a task sits in the inbox until its timeout.
3. **Install takes seven commands** (install Bun, clone, `bun install`, `bun link`, `crewmate init`, `crewmate install-claude-agent`, `claude mcp add`) and then a terminal kept open for `crewmate up`.

Two known bugs are in scope (not yet filed as GitHub issues): a failed task is reported with status "completed", and `agy` hangs when it is signed out.

## 2. Goals, non-goals, anti-goals

### Goals

1. **Two-command install** in Claude Code, with no Bun, no clone and no `npm install`:
   ```text
   /plugin marketplace add aashish-g03/crewmate
   /plugin install crewmate@crewmate
   ```
   Other prerequisites: Node.js 20 or later, and the vendor CLIs the user wants (`codex`, `agy`), installed and signed in. `/crewmate:setup` says exactly what is missing and how to fix it.
2. **Live progress in the conversation.** While a job runs, the user and Claude see one line per event (job started, tool started, finished or failed, job ended with any denied tools listed) without opening another terminal.
3. **Jobs that outlive the call.** Every job runs as a detached process. Claude keeps working, and is told when the job ends. Jobs survive the Claude session ending; their results can be read later.
4. **Accurate final states.** A job ends as exactly one of `done`, `failed`, `timeout`, `canceled`. Tools the vendor denied are listed in the job's outcome, never hidden.
5. **Goldfish critique.** `/crewmate:critique <path or diff>` sends a document or change to every ready vendor in parallel, with no conversation context, and returns each report.
6. **Follow-ups.** `--resume` continues an earlier conversation with a vendor.
7. **Works outside Claude Code.** The engine is a plain command-line program with one state folder, so Codex, agy, Cursor or a shell can call it, and their jobs are visible from Claude Code.

### Non-goals (v1)

- Git worktrees or any per-job workspace isolation. Jobs run in the caller's directory. (Aashish ruled this out.)
- A boss-and-crew supervisor that splits work and opens PRs. That is what [firstmate](https://github.com/kunchenguid/firstmate) does.
- An MCP server (section 7, alternative 1).
- Kimi, Cursor Agent or other vendors. The vendor adapter (4.4) is the extension point.
- Anything `codex-plugin-cc` has beyond jobs: its long-lived broker, its Codex `app-server` client, its Stop-hook review gate, and "transfer this session to Codex".
- Plugin manifests for Codex and agy (EGM ships these). Possible later; v1 must not block it.
- Claude Code hooks.

### Anti-goals (counted as failure even when the job completes)

- A user has to keep a terminal open, or run a daemon, for jobs to start.
- A job ends `done` without listing tools the vendor denied, or with an empty answer.
- crewmate runs a vendor with all permissions bypassed unless the user typed `--yolo`.
- crewmate grows its own model-calling logic (API keys, provider routing, prompt rewriting beyond the critique template). It drives vendor CLIs the user already has.

## 3. Users and the main flows

In the flows below, `crewmate` is shorthand: inside Claude Code the actual call is `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate"` (4.2).

### 3.1 Claude Code user (primary)

Installs the plugin, runs `/crewmate:setup` once, then either types a command or lets Claude call crewmate when a second opinion helps (the bundled skill says when).

**Flow A, short question.** `/crewmate:ask codex "Is the retry logic in src/queue.ts safe under concurrent consumers?"`
1. crewmate starts a detached, read-only Codex job and prints its id.
2. The command runs `crewmate watch <id>` inline, which prints events as they happen and exits with the job's exit code.
3. Claude shows the answer from `crewmate result <id>`.
If the Bash call hits Claude Code's Bash time limit (2 minutes by default), only `watch` stops; the job keeps running, and Claude continues with Flow B's watch step.

**Flow B, long job.** Claude runs `crewmate ask gemini "Read all of src/ and list dead exports"` with `--detach`, which prints the job id and returns.
1. Claude starts a Monitor on `crewmate watch <id>`, with a Monitor timeout at least as long as the job timeout. Each event line arrives in the conversation as it happens.
2. When the job ends, `watch` prints the final line and exits; Monitor reports the exit.
3. Claude reads `crewmate result <id>`.

**Flow C, critique.** `/crewmate:critique docs/specs/payment-design.md`
1. crewmate starts one read-only job per ready vendor with the critique prompt (4.7) and prints the ids.
2. Claude watches them all with one Monitor on `crewmate watch <id1> <id2>`.
3. Claude presents the reports side by side and marks where vendors agree. Claude, the elephant, decides which findings matter; crewmate does not merge them with a model.

### 3.2 Other agents (secondary)

Any agent with a shell runs the same commands: `npx crewmate@latest …` if published to npm (section 8), or `node <clone>/plugins/crewmate/bin/crewmate …`. Jobs land in the same state folder as jobs started from Claude Code.

## 4. Proposed architecture

### 4.1 Shape

```text
Claude Code
  ├─ slash commands (/crewmate:ask, critique, status, result, cancel, setup)
  ├─ skill: when and how to delegate, how to watch a job
  └─ Bash tool ──► node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate" <command>
                      │
                      ├─ ask / critique: spawn a detached runner per job, print job id(s)
                      └─ watch / status / result / cancel: read and act on job state
                                   │
                    runner (crewmate _run <id>) ──► vendor adapter ──► vendor CLI process
                                   │                  codex: codex exec --json
                                   │                  gemini: agy -p … --output-format stream-json
                                   ▼
                    ~/.crewmate/workspaces/<slug>-<hash>/jobs/<id>/{job.json, events.ndjson, result.md}
```

There is no MCP server, no subagent and no mailbox. One program implements every crewmate command; the plugin is Markdown around it, which is how `codex-plugin-cc` is built.

Every job, foreground or not, runs through the same detached runner. "Foreground" only means the caller runs `watch` on the job right away. So there is one lifecycle for timeout, cancel and final state, and a job never dies because the command that started it was stopped.

### 4.2 Runtime and packaging

- **Plain Node.js 20+, ES modules, zero runtime dependencies** (only `node:` built-ins), like `codex-plugin-cc`, whose `package.json` lists only dev dependencies. Claude Code copies plugin files but does not run `npm install`, so this is what makes the two-command install work.
- Source is `.mjs` with JSDoc types, type-checked in CI with `tsc --checkJs`. No build step: the files in the repo are the files that run.
- **Repo layout:** the repo root is a plugin marketplace (`.claude-plugin/marketplace.json`) listing one plugin at `plugins/crewmate/`, which holds `.claude-plugin/plugin.json`, `commands/`, `skills/`, `bin/crewmate` (the entry point) and `lib/`. The marketplace-at-root layout matches `codex-plugin-cc` and EGM; `bin/` is crewmate's own, because the same file is also the npm entry point.
- **Invocation inside Claude Code:** commands and the skill always call `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate" …`, the form `codex-plugin-cc` uses everywhere. Nothing depends on Claude Code putting plugin `bin/` folders on PATH.
- **Reused code:** `lib/` is adapted from these modules of `codex-plugin-cc`'s `scripts/lib/` (Apache-2.0, kept with its NOTICE and attribution). This is an adaptation, not a drop-in copy:
  - `process` (process-group termination), `args`, `render`, `fs`, `workspace` (finding the workspace root), `git` (working-tree and base-ref diffs, for `critique --diff`): used with small edits.
  - `state`: keep the slug-plus-hash folder scheme. Changes: remove the `CLAUDE_PLUGIN_DATA` read (4.5); drop its shared `state.json` index and read job folders directly, so there is no unlocked shared file to race on; prune only finished jobs (its `pruneJobs` keeps the newest 50 regardless of state).
  - `tracked-jobs`: keep the job-record and log helpers; add the runner's start time next to its pid.
  - `job-control`: keep the status and listing logic; remove its import of the Codex-specific `codex.mjs`.
  - **New code:** the detached runner spawn (in `codex-plugin-cc` it lives in `codex-companion.mjs`, which is not copied), the event log, `watch`, the vendor adapters and the writer lock.

  Everything Codex-specific in that repo (`codex.mjs`, `app-server*`, `codex-companion.mjs`, the broker, hooks and session transfer) is not copied.
- The old Bun/TypeScript code is removed (4.10). crewmate keeps its MIT license for its own code; the copied files keep Apache-2.0 headers.

### 4.3 Command-line interface

All commands accept `--json`. Exit codes:

| Code | Meaning |
|---|---|
| 0 | done (also: a job id was printed by `ask --detach` or `critique`) |
| 1 | failed |
| 2 | usage error |
| 3 | vendor not ready: binary not on PATH, so no job was started |
| 4 | timeout |
| 5 | canceled |
| 6 | refused: a write job is already running in this workspace, or (`--resume`) a job for that vendor is already running |
| 7 | `critique`: no vendor is ready, so no job was started |

| Command | What it does |
|---|---|
| `crewmate ask <vendor> [prompt]` | Starts one job, then watches it inline unless `--detach`. Flags: `--detach`, `--resume [job-id]`, `--model <id>`, `--effort <level>`, `--write`, `--yolo`, `--timeout <duration>` (default 10m), `--prompt-file <path>`. The prompt can also come on stdin. |
| `crewmate critique <path…>` | Starts one read-only job per ready vendor with the critique prompt (4.7). Flags: `--diff [ref]` (review `git diff` of the working tree, or against `ref`, instead of files), `--vendors <list>`. Prints the job ids and returns. |
| `crewmate watch <id…>` | Prints events for the given jobs, replaying those already written, and exits when every job has a final state. Exit code: the worst final state among the jobs (failed over timeout over canceled over done). |
| `crewmate status [id]` | Lists recent jobs in this workspace (id, vendor, state, age, summary), or one job in full. |
| `crewmate result <id>` | Prints the final answer and an outcome block: state, duration, tokens, denied tools, tool errors. |
| `crewmate cancel <id>` | Stops a running job. |
| `crewmate setup` | Checks Node, and for each vendor: binary on PATH, version, sign-in. Prints `ready` or the exact fix command per vendor. |

**`--resume`:** with no value, continues the most recent `ask` job for that vendor in this workspace (critique jobs are skipped); with a job id, continues that job's vendor conversation. Refused while another job for that vendor in this workspace is running.

**Permission steps** have the same names for both vendors (their powers differ slightly; see 4.4): default read-only, `--write` (edits in the working directory), `--yolo` (everything, no prompts). They map to each vendor's own controls (4.4); crewmate writes no allow-lists of its own.

### 4.4 Vendor adapters

Each vendor is one adapter module with the same small interface: build the command line for a job (prompt, model, effort, permission step, resume id), turn each line of the CLI's output into crewmate events, and extract the final answer, conversation id, token usage and denials. Both v1 vendors are one child process per job that writes newline-delimited JSON, and both are canceled by killing the process group.

**Codex: `codex exec --json`.** Recorded on macOS with codex-cli 0.166.0 (fixtures `codex.ndjson`, `codex-denied.ndjson` in the review folder):
- `thread.started` carries `thread_id`, stored for `--resume` (`codex exec resume <thread_id> <prompt>`). Sessions are kept by default (`--ephemeral` is opt-in).
- `item.started` / `item.completed` carry tool items (for example `command_execution` with `command`, `exit_code`, `status`) and `agent_message` text.
- `turn.completed` carries token usage. `-o <file>` writes the final message straight to `result.md`.
- Permission steps are always passed as `-c sandbox_mode="read-only"` (default) or `-c sandbox_mode="workspace-write"` (`--write`), or as `--dangerously-bypass-approvals-and-sandbox` (`--yolo`). They are not passed as `-s`, because `codex exec resume` has no `-s` option (checked in its help), and without an explicit setting a resumed job would take the sandbox from the user's `config.toml`. `--model` maps to `-m`, `--effort` to `-c model_reasoning_effort=<level>`. `--skip-git-repo-check` is always passed, because crewmate also runs outside git repositories.
- stdin must be closed (`codex exec` otherwise waits on "Reading additional input from stdin").
- **Limit:** Codex does not report a sandbox denial as an event. In the recorded read-only run that was asked to create a file, Codex did not attempt the command at all and only said, in its answer, that the filesystem is read-only. A blocked command that it does attempt shows as a `command_execution` with a non-zero exit. So for Codex, crewmate reports non-zero commands as **tool errors** and does not claim to detect denials.

**Gemini: `agy -p <prompt> --output-format stream-json`.** Recorded on macOS with agy 1.4.12 (fixtures `agy2.ndjson`, `agy-plan.ndjson`):
- `init` carries `conversation_id` (stored for `--resume`, which passes `--conversation <id>`) and `permission_mode`.
- `step_update` events carry `step_type` (`user_input`, `agent_response`, `tool`), `tool_name`, parameters, `state` (`ACTIVE`, `DONE`, `ERROR`) and token usage. These become live events.
- The final `result` event carries `status`, `response` and `denied_actions` (for example `[{"action":"command","display_name":"RunCommand"}]`). crewmate takes denials from `denied_actions`, not from parsing step error text.
- A run can end `status: SUCCESS` with an empty `response` (recorded). crewmate ends such a job `failed` ("vendor returned no answer").
- Permission steps: `--mode plan` (default; recorded: agy read files normally, and its one write went to its own plan folder under `~/.gemini/antigravity-cli/brain/`, not the project), `--mode accept-edits` (`--write`), `--dangerously-skip-permissions` (`--yolo`).
- Read-only guard: in all three recorded runs (default, `--mode plan`, `--mode accept-edits`) `init.permission_mode` was `request-review`, meaning agy denies anything that would need an approval prompt. The runner checks this value on default and `--write` runs and ends the job `failed` with a message naming the setting if it differs (for example because the user's agy settings auto-approve). The builder must confirm what value agy reports when user settings do auto-approve.
- `--model` and `--effort` pass through (`agy models` lists ids; `--model gemini-3.8-flash-low` worked; `agy --help` lists `--effort low|medium|high|xhigh|max`). `--print-timeout` is set to the job timeout.
- Difference from Codex, stated: agy `--write` (`accept-edits`) allows file edits but still denies shell commands, while Codex `workspace-write` can run commands in the workspace. The permission steps have the same names for both vendors, not identical powers.

**First-event deadline (all vendors).** A model event is any agy `step_update` or `result`, or any Codex `item.*` or `turn.*` event. agy's `init` and Codex's `thread.started` do not count, because they carry only local data and may appear even when the vendor cannot reach its model. If a vendor prints no model event within 45 seconds of starting, the job ends `failed` (exit code 1, like any failed job) with reason "vendor did not respond" and the `setup` fix text in its outcome. This is meant to catch a signed-out or hung CLI (the agy hang above) without probing sign-in before every job; the builder records one signed-out agy run as a fixture to confirm which events it prints; `--print-timeout` alone would only stop it at the full job timeout.

**Later vendors** (Kimi, Cursor Agent, others) are new adapter modules. Nothing in v1 may assume there are only two.

### 4.5 Jobs and state

- **State folder:** always `~/.crewmate/workspaces/<slug>-<hash>/`, where `<slug>` is the folder name of the workspace root and `<hash>` the first 16 hex characters of the SHA-256 of its real path. The workspace root is the git root, or the current directory outside git. crewmate never reads `CLAUDE_PLUGIN_DATA` from the environment: in Claude Code that variable is substituted only inside plugin files, and when another plugin sets it for the Bash tool (seen on this machine: it pointed at the Codex plugin's folder) it would send crewmate's state into that plugin's folder. One fixed root also makes jobs started from a shell, Codex or agy visible from Claude Code.
- **Per job:** `jobs/<id>/job.json` (vendor, prompt summary, flags, runner pid, runner start time, state, timestamps, vendor conversation id, outcome), `events.ndjson` (append-only crewmate events), `result.md` (final answer).
- **Events** (one JSON object per line, with a timestamp and a `type`): `started`; `tool` (tool name, short target, phase `start`, `done` or `error`; an agy step in state `ERROR`, including a permission denial, is a live `error`); `note` (short vendor text, truncated to 200 characters); `usage`; `end` (final state and outcome, including the denied-tools list, which for agy comes from `denied_actions`). This list is the interface; how `watch` words each line is left to the builder.
- **`watch` output volume:** consecutive tool events of the same kind are merged into one line (for example "read 14 files"), and `note` lines are throttled, so a job that reads hundreds of files stays well under Monitor's line limit and costs little context.
- **Runner:** `ask` and `critique` spawn `crewmate _run <id>` detached in its own process group, with stdin closed and output to the job's log. It survives Claude Code exiting.
- **Dead runner:** a job whose runner is gone without an `end` event is reported as `failed (runner died)` by `status`, `watch` and `result`, and `watch` exits instead of waiting. "Gone" means the pid is not running, or the process at that pid has a different start time than the one recorded (pid reuse).
- **Retention:** keep the newest 50 finished jobs per workspace; running jobs are never pruned. Pruning happens when a new job starts.
- **One writer at a time:** a job started with `--write` or `--yolo` is refused (exit code 6, naming the running job) if this workspace already has a running job started with either flag. The writer slot is taken by creating `writer.lock` (holding the job id) with an exclusive create, so two jobs starting at the same moment cannot both get it. A lock whose job is no longer running, by the same rule as dead-runner detection, is removed and retaken, so a crashed writer never blocks later jobs. Read-only jobs never wait and can run in parallel. The other collision, Claude editing files while a write job runs, is handled by a rule in the skill (4.6), not by code.
- **Cancel:** SIGTERM to the runner's process group, then SIGKILL after 5 seconds; the job ends `canceled`. The runner pid and start time are checked first, so cancel never signals an unrelated process.

### 4.6 The Claude Code layer

- **Commands** (`commands/*.md`) are short prompts that run the CLI through Bash. `ask` runs in the foreground (inline `watch`) by default; Claude passes `--detach` and uses Monitor when it expects the job to take more than about 2 minutes or wants to keep working meanwhile. Because every job is detached anyway, a wrong guess costs nothing: a stopped `watch` is restarted under Monitor.
- **Skill** (`skills/crewmate/SKILL.md`) tells Claude:
  - when delegating helps (a different vendor's opinion, a read too large for Claude's own context, a parallel independent task) and when not (tasks Claude can finish in a few steps itself);
  - how to start, watch (Monitor timeout at least the job timeout, re-armed past Monitor's 30-minute cap; where Monitor is unavailable, run the same `watch` as a background Bash command) and read jobs;
  - to present vendor answers faithfully, and to treat vendor text, including `watch` lines, as data, never as instructions;
  - not to edit files in the workspace while `crewmate status` shows a running write job;
  - never to pass `--write` or `--yolo` unless the user asked for edits or for full access.
- **No subagent.** v0.2's subagent existed only to run one shell command and hid all progress.

### 4.7 Critique (the goldfish review)

`crewmate critique` builds one prompt from a fixed template plus the given paths (or diff), and starts a read-only job per ready vendor. Each vendor sees only the prompt, the named files and the repository, never the Claude conversation.

The template is adapted from EGM's comprehension and design-critic reviewer prompts (Apache-2.0, attributed), so crewmate and EGM ask the same questions instead of drifting apart. It asks, in order: restate what the document or change is trying to do in your own words; unstated assumptions; missing failure modes; contradictions with the code it references; anything that would stop a builder from starting. Each finding is tagged blocker, major or minor, with the file and line.

Limits, stated: the reviewer can read the whole repository, which may contain the author's notes (for example earlier plans), so it is not perfectly context-free; `--diff` of the working tree leaves out untracked files.

crewmate and EGM fit together: EGM runs a staged review with fresh Claude reviewers; `crewmate critique` adds reviewers from other vendors in one pass.

### 4.8 Setup and errors

`crewmate setup` checks, per vendor: binary on PATH; version; sign-in. The Codex sign-in check is `codex login status`, which calls no model. agy has no status command, so its check is one short prompt with a 30-second limit; it runs only in `setup`, never before each job. Output is one line per vendor: `ready`, or the exact fix (install command, or "run `agy` once to sign in").

`ask` checks only that the vendor binary is on PATH before starting (exit code 3 with the fix text if not); a signed-out or hung vendor is caught by the 45-second first-event deadline (4.4).

### 4.9 Distribution

- GitHub marketplace install (Goal 1).
- Submit the repo to [claudecodemods.dev](https://claudecodemods.dev/submit), a third-party directory of Claude Code plugins (its form takes the repo URL and an optional path to the plugin inside it, here `plugins/crewmate`).
- npm publishing for use outside Claude Code: decision in section 8.

### 4.10 Migration from v0.2

v0.2 was never published (the README's npm section says "once published"), so migration is for Aashish's machine only.

- Tag the current state `v0.2.0` before removing code.
- Remove: `src/` (mailbox, supervisor, worker, the sweeper and affinity recovery that clean up stuck mailbox tasks, the persistent-context feature, the MCP server and its nine tools, the ACP runner and shim), the Bun `bin/crewmate`, `templates/crewmate.md` (the subagent), `scripts/` (probes), `bun.lock`, `tsconfig.json` (replaced by a `--checkJs` config).
- Rewrite: `package.json` (Node, zero dependencies, `bin` pointing at `plugins/crewmate/bin/crewmate`, dev dependency `typescript` only), `README.md`, `AGENTS.md`, `CHANGELOG.md`. Keep `LICENSE`.
- Carried over as ideas: name validation against path traversal (job ids and vendor names are validated the same way), vendors run only in the caller's directory, model and effort passthrough.
- The README tells existing users to remove `~/.crewmate/<agent>/` mailbox folders, the `crewmate` MCP entry (`claude mcp remove crewmate`) and `~/.claude/agents/crewmate.md`. `setup` does not detect them.

### 4.11 Testing

Real flows, failure modes first, no tests that restate the code (Aashish's testing rule in his global `CLAUDE.md`).

One test per failure mode, run through the real CLI against fake vendor CLIs that replay recorded output (the five `.ndjson` recordings in `egm-review-2026-11-01/`, copied to `tests/fixtures/`). `agy2.ndjson` (a denial plus an empty response) is the fixture for test 3. Test 2 uses a fixture derived from it with a non-empty response, marked as synthetic, until a real denial-with-answer run is recorded.

1. Vendor exits non-zero or reports an error → `failed`, never `done`.
2. agy ends `SUCCESS` with `denied_actions` and a non-empty response → `done`, exit code 0; the denied step shows live as a tool `error` line, and the denied tools are listed in `result`, `--json` and the final `watch` line.
3. agy ends `SUCCESS` with an empty response → `failed`.
4. Codex command with non-zero exit → listed as a tool error.
5. Vendor prints nothing → `failed` ("vendor did not respond", exit code 1) at the first-event deadline; process group gone. Vendor binary missing → exit code 3, no job created.
6. Vendor hangs after starting → `timeout` at the job deadline; process group gone.
7. `cancel` → `canceled`; process group gone; a reused pid is not signalled.
8. Runner killed → `status` and `result` show `failed (runner died)`.
9. A `--write` or `--yolo` job while another writer runs → exit code 6; a dead writer's lock does not block.
16. A resumed Codex job without `--write` runs with `sandbox_mode="read-only"` even when the user's `config.toml` sets another sandbox.
10. `--resume` passes the stored conversation or thread id; skips critique jobs.
11. Path-like vendor names or job ids are rejected.
12. agy `init.permission_mode` other than expected → `failed` before any tool runs.
13. `watch` replays events already written, then exits on `end`.
14. `watch` on a dead runner exits instead of hanging.
15. `watch` with several ids exits only when all are final, with the worst state's exit code.

Release check, by hand, kept as the release artifact: install the plugin from a local marketplace path in a scratch Claude Code session, run Flow A against real Codex and Flow C against both real vendors, and save the session transcript showing progress lines arriving in the conversation.

## 5. Security and safety

- **Read-only by default** through each vendor's own sandbox or mode (4.4); `--write` and `--yolo` are explicit, and the skill forbids Claude from adding them on its own.
- **Prompt injection across agents.** Vendors read repository files, which may contain instructions. Vendors stay read-only by default, and the skill tells Claude to treat their answers and `watch` lines as data. `note` text is truncated.
- **No secrets handled.** crewmate never reads or stores API keys; vendors use their own sign-in.
- **Detached processes** run with the user's rights, are bounded by the job timeout, are listed by `status`, and are never restarted automatically.
- **State files** under `~/.crewmate` hold prompts and answers, which may include code. The README says so.

## 6. Risks and limits

| Risk | Effect | Mitigation |
|---|---|---|
| agy's stream-json events are not documented | A future agy renames events | Parse defensively (unknown events become `note`); recorded fixtures catch changes; if parsing fails, fall back to the final `result` event |
| `codex exec --json` event names change | Codex jobs lose live events | Same as above; the final message comes from `-o` regardless |
| Codex sandbox denials are invisible as events | A read-only Codex job may say it could not do something without crewmate listing a denial | Stated limit (4.4); non-zero commands are listed as tool errors |
| Node not installed (Claude Code's native installer does not need Node) | Commands fail | Node 20+ is listed as a prerequisite in Goal 1 and the README's first lines; the error says so |
| Monitor limits: expiry (5 min default, 30 max), automatic stop on too many lines, each line uses context | Progress stops arriving, or context fills | Monitor timeout ≥ job timeout and re-armed past 30 min; `watch` merges and throttles lines; background Bash as fallback (4.6) |
| Vendor rate limits or cost | Long or parallel jobs use the user's vendor quota | 10-minute default timeout; one critique job per vendor; no automatic retries; no sign-in probe per job |
| Claude edits files while a write job runs | Mixed edits | Skill rule (4.6) |
| OpenAI's `codex-plugin-cc` already provides Codex delegation | Little reason to install crewmate for Codex alone | The README states what crewmate adds: several vendors in one install, live progress, goldfish critique |

Limits: 50 finished jobs kept per workspace; one write job per workspace; read-only jobs unlimited (bounded by the user's vendor quotas).

## 7. Alternatives considered

1. **Keep the MCP server and fix its progress.** Rejected: the MCP SDK and zod are runtime dependencies, which forces a bundle or an `npm i -g`; an MCP call is tied to the session; progress shows in `/tasks` rather than in the conversation; and every agent Aashish uses has a shell. An MCP adapter over the same engine can be added later for an agent without a shell.
2. **Keep Bun and ship compiled binaries** (`bun build --compile`). Rejected: per-platform binaries of tens of megabytes in the plugin repo and a release pipeline, to avoid requiring Node, which crewmate's own reference (`codex-plugin-cc`) also requires.
3. **ACP for every vendor**, through crewmate's own client or [`acpx`](https://github.com/openclaw/acpx). Rejected for v1: neither Codex nor agy offers native ACP here (Codex needs a third-party adapter; agy has none), so ACP would be a shim over the same CLIs, while `exec --json` and `stream-json` are each vendor's own structured output.
4. **Codex through `codex app-server`** (what `codex-plugin-cc` uses). Rejected: app-server is marked experimental, needs a JSON-RPC client, and in `codex-plugin-cc` it mainly serves the broker, review gate and session transfer, which are non-goals. `codex exec --json` gives the thread id, tool events and usage (recorded), with the same process shape as agy.
5. **Fork `codex-plugin-cc` and add an agy adapter.** Rejected: about 3,500 lines would come along that v1 rules out (broker, app-server client, session transfer, stop gate, the 1,219-line Codex-specific `codex.mjs`). v1 copies only the generic job modules (4.2).
6. **Use Claude Code's background Bash instead of a detached runner.** Rejected: a background Bash command ends with the session, which breaks Goal 3. `codex-plugin-cc` spawns its own detached worker for the same reason.
7. **Copy [firstmate](https://github.com/kunchenguid/firstmate)** (interactive sessions in tmux, a watcher, worktrees, PRs). Rejected: it is a supervisor product, mostly bash, reads the screen to learn state, and relies on worktrees, which Aashish ruled out.
8. **Install the existing projects side by side** (`codex-plugin-cc`, `gemini-mcp-tool`, PAL). Rejected by the goal: three installs, three styles, three state stores, no shared critique.
9. **Route at the API level** ([9Router](https://github.com/decolua/9router), [claude-code-router](https://github.com/musistudio/claude-code-router): a local proxy that swaps the model behind Claude Code and falls back between providers). Rejected as crewmate's design: it changes which model Claude Code itself talks to, rather than letting Claude hand a task to another vendor's agent, with that agent's tools and sign-in, and get a second answer back. The two can be used together.
10. **Keep the mailbox and worker pool as an optional mode.** Rejected: its only benefit, a queue shared between terminals, has no current user, and it is the cause of the "task waits for `crewmate up`" failure.

## 8. Decisions still open (Aashish)

1. **Name.** firstmate calls its workers "crewmates", so search results will collide. Keep `crewmate`, or rename before the first public release?
2. **npm publishing** in v1 (`npx crewmate@latest` for use outside Claude Code), or later? The npm name must be checked for availability either way.

## 9. Left to the builder

- Internal module layout under `lib/` beyond the reused modules.
- Wording of `watch` lines and the outcome block; the merge and throttle thresholds. Monitor's line limit is not published, so the target is at most about one line per 2 seconds per job on average, checked in the release transcript. `watch` may add a `--since <event-number>` option so a re-armed Monitor does not replay the whole history.
- Exact critique template text, within 4.7.
- Two checks before relying on them, with the fallback named in 4.4 if either fails:
  - what `init.permission_mode` agy reports when user settings auto-approve;
  - that Monitor is available to every Claude Code user. If it isn't, background Bash becomes the default.
