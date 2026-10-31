# crewmate v1: one Claude Code plugin for other vendors' coding agents

Status: draft for review (2026-11-01)
Author: Aashish Gupta (decisions), drafted with Claude
Replaces: the v0.2 architecture (filesystem mailbox, worker pool, MCP server, Bash subagent), described in `README.md` and `docs/superpowers/2026-05-04-acp-transport.md` on this branch.

## 1. Problem

Aashish uses Claude Code as his main agent and wants it to hand work to other vendors' coding agents (OpenAI Codex, Google Gemini through the Antigravity CLI `agy`) for second opinions, large-context reads and delegated work. Today several separate projects each cover a slice of this (OpenAI's `codex-plugin-cc` for Codex, `gemini-mcp-tool` for Gemini, Zen/PAL for multi-model reviews, EGM for zero-context spec reviews). He wants one project that gathers the useful parts, works from any of his sessions, and is simple enough for other people to install and use.

crewmate v0.2 already tries this and fails in three observed ways:

1. **No progress reaches the user.** Claude spawns the `crewmate` Bash-only subagent, which runs `crewmate send` in the foreground. `send` prints each worker tool call to stderr, but that output stays inside the subagent's Bash call. Claude Code shows the parent session only the subagent's final message, so the user sees nothing until the end. The MCP route (`send_and_wait`) does send progress notifications, but they only say "queued", "claimed by pid=…" and "running, 25s elapsed". The real tool-call events are written to `logs/<task>.progress.log` and never forwarded.
2. **Tasks silently stall.** Unless `crewmate up <agent>` is running in another terminal, a task sits in the inbox until its timeout.
3. **Install takes seven steps:** install Bun, clone, `bun install`, `bun link`, `crewmate init`, `crewmate install-claude-agent`, `claude mcp add`, then keep `crewmate up` running.

Two open bugs also matter: failures are reported with status "completed" (issue 1), and `agy` hangs when signed out (issue 2).

## 2. Goals, non-goals, anti-goals

### Goals

1. **Two-command install** in Claude Code, with no Bun, no clone and no `npm install`:
   ```
   /plugin marketplace add aashish-g03/crewmate
   /plugin install crewmate@crewmate
   ```
   The only other prerequisite is the vendor CLI itself (`codex`, `agy`), installed and signed in. `/crewmate:setup` says exactly which one is missing and how to fix it.
2. **Live progress in the conversation.** While a job runs, the user and Claude see one line per meaningful event (tool started or finished, a denied permission, done or failed) without opening another terminal.
3. **Background jobs that outlive the call.** A long job runs detached. Claude keeps working, and is told when the job finishes. Jobs survive the Claude session ending; their results can be read later.
4. **Honest outcomes.** A job ends as exactly one of `done`, `failed`, `timeout`, `canceled`. Tool calls the vendor CLI denied are reported, not hidden.
5. **Goldfish critique.** `/crewmate:critique <path or diff>` sends a document or change to every ready vendor in parallel with no conversation context, in the style of Google's Elephant-Goldfish Model (EGM), and returns each report.
6. **Follow-ups.** `--resume` continues the last conversation with that vendor in this workspace.
7. **Works outside Claude Code.** The engine is a plain command-line program, so Codex, agy, Cursor or a shell can call it too.

### Non-goals (v1)

- Git worktrees or any per-job workspace isolation. Jobs run in the caller's directory. (Aashish ruled this out.)
- A boss-and-crew supervisor that splits work and opens PRs (that is what firstmate does).
- An MCP server. (Decided; see section 7.)
- Kimi, Cursor Agent or other vendors as first-class adapters. Section 4.4 keeps the door open.
- A long-lived broker process, a Stop-hook review gate, or "transfer this session to Codex" (all present in `codex-plugin-cc`).
- Plugin manifests for Codex and agy (EGM ships these). Possible later; nothing in v1 should block it.

### Anti-goals (failure even if it "works")

- A user has to keep a terminal open, or run a daemon, for jobs to start.
- A job reports success when the vendor failed, timed out or was denied the tools it needed.
- crewmate runs a vendor with all permissions bypassed unless the user typed an explicit flag for it.
- crewmate grows its own model-calling logic (API keys, prompt templating beyond the critique prompt, routing heuristics). It drives vendor CLIs the user already has, and nothing else.

## 3. Users and the main flows

**Claude Code user (primary).** Installs the plugin, runs `/crewmate:setup` once, then either types a command or lets Claude call crewmate on its own when a second opinion helps (the bundled skill tells Claude when and how).

Flow A, quick question (foreground):
`/crewmate:ask codex "Is the retry logic in src/queue.ts safe under concurrent consumers?"` → crewmate runs Codex read-only in the current directory → progress lines stream into the Bash output → the answer prints → Claude shows it.

Flow B, long job (background):
Claude runs `crewmate ask gemini --background "Read all of src/ and list dead exports"` → prints a job id at once → Claude starts a Monitor on `crewmate watch <id>`, so each event arrives in the conversation as it happens → when the job ends, `watch` prints the final status and exits → Claude reads `crewmate result <id>`.

Flow C, critique:
`/crewmate:critique docs/specs/payment-design.md` → crewmate starts one read-only job per ready vendor with the same critique prompt and only the file paths → Claude watches all of them → Claude presents the reports side by side, marking where vendors agree. Claude (the elephant, with full context) decides which findings matter; crewmate does not merge them with a model.

**Other agents (secondary).** Any agent with a shell can run the same `crewmate` commands. Outside Claude Code the command is installed with `npx crewmate@latest …` (if published to npm) or from a clone.

## 4. Proposed architecture

### 4.1 Shape

```
Claude Code
  ├─ slash commands (/crewmate:ask, critique, status, result, cancel, setup)
  ├─ skill: when and how to delegate, how to watch a job
  └─ Bash tool ──► crewmate (plugin bin/, on PATH)
                      │
                      ├─ foreground: runs the job in-process, streams events
                      └─ --background: spawns a detached runner, returns job id
                                   │
                         job runner ──► vendor adapter ──► vendor CLI
                                   │      (codex app-server | agy stream-json)
                                   ▼
                         state dir: jobs/<id>/{job.json, events.ndjson, result.md}
```

There is no MCP server, no subagent and no mailbox. One program does everything; the plugin is a thin layer of Markdown around it, which is how `codex-plugin-cc` is built.

### 4.2 Runtime and packaging

- **Plain Node.js, ES modules, zero runtime dependencies** (only `node:` built-ins). `codex-plugin-cc` does the same; its `package.json` lists only dev dependencies. This is what makes a plugin install work, because Claude Code copies plugin files but does not run `npm install`.
- Source is `.mjs` with JSDoc types, type-checked in CI with `tsc --checkJs`. No build step, so the files in the repo are the files that run.
- Minimum Node version: 20 (the version on Aashish's machine is 20.19.4). `setup` checks it.
- Repo layout: the repo root is a plugin marketplace (`.claude-plugin/marketplace.json`) listing one plugin at `plugins/crewmate/`, which holds `plugin.json`, `commands/`, `skills/`, `bin/crewmate` and `lib/`. Same layout as `codex-plugin-cc` and EGM.
- Plugin `bin/` executables are added to the Bash tool's PATH by Claude Code, so commands and the skill call plain `crewmate …`.

### 4.3 Command-line interface

All commands accept `--json` for machine-readable output. Exit codes: 0 done, 1 failed, 2 usage error, 3 vendor not ready, 4 timeout, 5 canceled.

| Command | What it does |
|---|---|
| `crewmate ask <vendor> [prompt]` | Runs one job. Flags: `--background`, `--resume`, `--model <id>`, `--effort <level>`, `--write`, `--timeout <dur>` (default 10m), `--prompt-file <path>`. Prompt can also come on stdin. |
| `crewmate critique <path…>` | Starts one read-only job per ready vendor with the critique prompt (4.7). Always background; prints the job ids. |
| `crewmate watch <id…>` | Prints one line per event for the given jobs (replaying events already written), and exits when all of them reach a final state. Designed to be run under Claude Code's Monitor. |
| `crewmate status [id]` | Lists recent jobs in this workspace (id, vendor, state, age, summary), or one job in full. |
| `crewmate result <id>` | Prints the job's final answer and its outcome block (state, duration, tokens, denied tools). |
| `crewmate cancel <id>` | Stops a running job. |
| `crewmate setup` | Checks Node, each vendor CLI (installed, version, signed in) and prints exact fix commands. |

Vendor names in v1: `codex`, `gemini`. `gemini` is driven through `agy`; the name is the model family, not the binary, so it survives future CLI changes.

### 4.4 Vendor adapters

Each vendor is one adapter module with the same small interface: check readiness, start a job, turn the CLI's output into crewmate events, cancel, and resume. Two adapters ship in v1:

**Codex: `codex app-server`.** A JSON-RPC connection over stdio, the same one `codex-plugin-cc` uses. The job starts or resumes a thread (`thread/start`, `thread/resume`) and runs one turn (`turn/start`). Notifications `item/started` and `item/completed` become tool events; `turn/completed` ends the job; `turn/interrupt` cancels it. The thread id is stored for `--resume`. Read-only by default; `--write` selects Codex's workspace-write sandbox. `--model` and `--effort` pass straight through.
- Verified on this machine: `codex-cli 0.166.0` lists `app-server` as experimental.
- Fallback if `app-server` is missing or its protocol changes: `codex exec --json`, which gives less detail but the same outcome. The adapter picks at start-up based on `codex --help` / a version check.

**Gemini: `agy -p … --output-format stream-json`.** One process per job. Verified on this machine (agy 1.4.12):
- The stream is newline-delimited JSON with an `init` event (has `conversation_id`), `step_update` events (`step_type` of `user_input`, `agent_response` or `tool`, with `tool_name`, parameters, `state` of `ACTIVE`, `DONE` or `ERROR`, and token usage), and a final `result` event with `status` and `response`.
- `--model gemini-3.8-flash-low` works; `agy models` lists the ids.
- `--print-timeout` bounds the run (this fixes issue 2's hang at the source; crewmate also enforces its own timeout).
- `--conversation <id>` resumes, used for `--resume`.
- In headless mode agy denies any tool that would need a permission prompt (seen: `run_command` for `ls -la` came back `state: ERROR`, "permission check failed", while the final `result.status` was still `SUCCESS`). crewmate must therefore count denied tool steps and report them, and must not treat `SUCCESS` alone as a clean result.
- `--write` passes a session-only `--settings` allow-list that permits file edits in the working directory. Shell commands stay denied unless the user also passes `--allow-shell`. `--dangerously-skip-permissions` is only passed if the user types `--yolo`.

**Later vendors.** An adapter is the unit of extension. A vendor whose CLI only prints text (for example Kimi) could use a small generic "print" adapter driven by a JSON description (command template, how to pass model and prompt). That adapter is not part of v1, and nothing in v1 should assume there are only two vendors.

### 4.5 Jobs and state

- **State directory:** `${CLAUDE_PLUGIN_DATA}/workspaces/<slug>-<hash>/` when running inside Claude Code, else `~/.crewmate/workspaces/<slug>-<hash>/`. The hash is of the real path of the git root (or of the current directory outside git), the same scheme as `codex-plugin-cc`, so jobs from different projects never mix.
- **Per job:** `jobs/<id>/job.json` (vendor, prompt summary, flags, pid, state, timestamps, vendor conversation id, outcome), `events.ndjson` (append-only crewmate events), `result.md` (final answer).
- **Event format** (one JSON object per line): `{t, type, …}` where `type` is one of `started`, `tool` (name, short target, phase `start|done|error|denied`), `note` (short progress text from the vendor), `usage`, `end` (final state). `watch` prints these as single human-readable lines, for example `gemini ▶ read src/worker.ts`, `gemini ✗ denied run_command "ls -la"`, `gemini ■ done in 41s (6.9k in / 0.2k out), 1 tool denied`.
- **Background runs** spawn a detached copy of crewmate (`crewmate _run <id>`) in its own process group, with stdout and stderr going to the job's log. The job keeps running if Claude Code exits.
- **Staleness:** a job whose recorded pid is gone without an `end` event is shown as `failed (runner died)` by `status`, `watch` and `result`.
- **Retention:** keep the newest 50 jobs per workspace; older job folders are deleted when a new job starts.
- **One writer at a time:** a `--write` job takes a per-workspace lock; a second `--write` job in the same workspace is refused with the id of the one holding it. Read-only jobs never take the lock and can run in parallel. (No worktrees, so two writers editing the same tree is the main way to corrupt work.)
- **Cancel:** sends the adapter's interrupt (Codex `turn/interrupt`), then SIGTERM to the process group, then SIGKILL after 5 seconds; the job ends as `canceled`.

### 4.6 The Claude Code layer

- **Commands** (`commands/*.md`) are short prompts that run the CLI through Bash. `ask` decides foreground or background: foreground unless the user passed `--background` or the request is clearly long (a whole-repo read, a write task). For background jobs the command tells Claude to start a Monitor on `crewmate watch <id>`.
- **Skill** (`skills/crewmate/SKILL.md`): tells Claude when delegating helps (a second opinion from a different vendor, a read too large for its own context, a parallel independent task) and when it does not (small tasks Claude can do itself); how to run, watch and read jobs; to show vendor answers faithfully rather than rewriting them; and to never pass `--yolo` unless the user asked.
- **No subagent.** v0.2's subagent existed only to run one shell command and hid all progress; v1 runs the command from the main conversation.
- **No hooks in v1.**

### 4.7 Critique (the goldfish review)

`crewmate critique <path…>` builds one prompt from a fixed template and the given paths, and starts a read-only job per ready vendor. Each vendor sees only the prompt, the named files and the repository; it never sees the Claude conversation. That is the "goldfish" condition from EGM: the reviewer has no access to the author's reasoning, so gaps the author filled in mentally become visible.

The template asks for, in order: what the document or change is trying to do (one paragraph, in the reviewer's own words), unstated assumptions, missing failure modes, contradictions with the code it references, and anything that would block a builder from starting. Each finding is tagged blocker, major or minor, with the file and line it relates to. If a path is a diff (`--diff` uses `git diff` of the working tree, or `--diff <ref>`), the template asks the same questions about the change.

crewmate compared with EGM: EGM's goldfish are fresh Claude subagents run through five review stages. crewmate's goldfish are different vendors' models in one pass. They can be used together: EGM for the staged process, crewmate for vendor diversity.

### 4.8 Setup and errors

`crewmate setup` checks, for each vendor: binary on PATH, version (and, for Codex, whether `app-server` is available), and sign-in (a cheap read-only probe with a short timeout; for agy, a signed-out probe must time out quickly rather than hang). It prints one line per vendor with `ready` or the exact fix command. `ask` on a vendor that is not ready fails at once with exit code 3 and the same fix text, instead of starting a job.

### 4.9 Distribution

- GitHub marketplace install as in Goal 1.
- Submit the repo to claudecodemods.dev (the listing form takes a repo URL and optional mod path).
- Optional: publish the same program to npm so `npx crewmate@latest` works outside Claude Code. The npm package name `crewmate` must be checked for availability first.
- Before publishing, decide the name (section 8).

### 4.10 Migration from v0.2

- Tag the current state `v0.2.0` before removing code.
- Remove: `src/` (mailbox, supervisor, worker, sweeper, affinity recovery, contexts, MCP server and its nine tools, ACP runner and shim), `bin/crewmate` (Bun), `templates/crewmate.md` (the subagent), the `install-claude-agent` command, `scripts/` probes, `bun.lock`.
- Keep and rewrite: `README.md`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE`.
- Ideas carried over from v0.2 code: agent-name validation against path traversal (job ids and vendor names are validated the same way), the read-sandbox rule (vendors run in the caller's directory only), model and effort passthrough.
- Existing users' `~/.crewmate/<agent>/` mailbox folders are left alone. The README says how to remove them and the old `claude mcp` entry and `~/.claude/agents/crewmate.md`. `crewmate setup` detects the old subagent file and MCP entry and prints the removal commands.

### 4.11 Testing

Following Aashish's testing rule (real flows, failure modes first, no tests that restate the code):

Failure modes to cover, one test each:
1. A vendor exits non-zero or reports an error → state `failed`, never `done`.
2. agy returns `result.status: SUCCESS` with denied tool steps → state `done` with the denied tools listed in the outcome and in `watch`.
3. A vendor hangs → state `timeout` at the deadline, process group gone.
4. `cancel` on a running job → `canceled`, process group gone.
5. The runner is killed → `status` shows `failed (runner died)`.
6. Signed-out or missing CLI → `ask` exits 3 at once with the fix text, no job folder left running.
7. Second `--write` job in the same workspace → refused.
8. `--resume` uses the stored conversation or thread id.
9. Path-like vendor names or job ids are rejected.

How: a fake `codex app-server` and a fake `agy` (small scripts that replay recorded real output, including the denied-tool stream captured on 2026-11-01) drive the adapters through the real CLI. One end-to-end run per vendor against the real CLIs, run by hand before each release, saves its event log as the release artifact. Plugin install is checked by installing from a local marketplace path in a scratch Claude Code session.

## 5. Security and safety

- **Default is read-only** for both vendors. Writing needs `--write`; shell for agy needs `--allow-shell`; bypassing all permissions needs `--yolo`. The skill tells Claude never to add these on its own.
- **Prompt injection across agents.** A vendor reads repository files that may contain instructions. crewmate's answer is to keep vendors read-only by default and to show their output as their output; Claude should treat vendor answers as data, which the skill states.
- **No secrets handled.** crewmate never reads or stores API keys; vendors use their own sign-in.
- **Detached processes** run with the user's rights. They are bounded by the timeout and listed by `status`; nothing restarts them.
- **State files** live in the user's plugin data folder and contain prompts and answers, which may include code. The README says so.

## 6. Risks and limits

| Risk | Effect | Mitigation |
|---|---|---|
| `codex app-server` is marked experimental and its protocol may change | Codex jobs break after a Codex update | Fall back to `codex exec --json`; recorded-fixture tests catch shape changes; `setup` reports the Codex version |
| agy's stream-json events are not documented | Events may be renamed | Parse defensively (unknown events become `note`); keep recorded fixtures; on parse failure fall back to the final `result` |
| Node not on PATH (Claude Code's native installer does not need Node) | Plugin commands fail | `setup` and every command print a clear "install Node 20+" message; documented in the README's first lines |
| Vendor rate limits or cost | Long or parallel critique jobs cost money on the user's vendor accounts | Default 10-minute timeout; critique runs one job per vendor, never retries automatically |
| Two jobs editing the same files | Lost or mixed edits | One-writer lock per workspace (4.5) |
| OpenAI's `codex-plugin-cc` already covers Codex well | Little reason to install crewmate for Codex alone | Position crewmate on what it adds: one install for several vendors, live progress, goldfish critique |
| Detached runner orphaned after a crash | A vendor process keeps running | Process-group kill on timeout; `status` marks dead runners; `cancel` works by pid |

## 7. Alternatives considered

1. **Keep the MCP server and fix its progress** (forward real tool events as MCP progress notifications). Rejected: the MCP SDK and zod are runtime dependencies, which forces a bundle or an `npm i -g`; an MCP call is tied to the session and dies with it; progress shows in `/tasks` rather than in the conversation; and every agent Aashish uses has a shell, so a command-line program reaches more of them. An MCP adapter over the same engine can be added later if an agent without a shell needs it.
2. **Keep Bun and ship compiled binaries** (`bun build --compile`). Rejected: per-platform binaries of tens of megabytes each in a plugin repo, and a release pipeline, to avoid a Node requirement that most coding-agent users already meet.
3. **Use ACP for every vendor**, through crewmate's own client or `acpx`. Rejected for v1: neither Codex nor agy offers native ACP here (Codex needs a third-party adapter, agy has none), so ACP would be a shim over the same CLIs. Codex's `app-server` and agy's `stream-json` are each vendor's own structured output. If a vendor adds native ACP, an ACP adapter fits the adapter interface.
4. **Copy firstmate** (interactive sessions in tmux, a watcher, worktrees, PRs). Rejected: it is a supervisor product of about 125,000 lines of bash; it reads the screen to learn state; and it relies on worktrees, which Aashish ruled out.
5. **Depend on the existing projects** (install `codex-plugin-cc`, `gemini-mcp-tool` and PAL side by side). Rejected by the goal: three installs, three styles, three state stores and no shared critique.
6. **Route at the API level instead** (9Router, claude-code-router: a local OpenAI-compatible proxy that swaps the model behind Claude Code and falls back between providers). Rejected as the design for crewmate: it changes which model Claude Code itself talks to, rather than letting Claude hand a task to another vendor's agent, with its own tools and sign-in, and get a second answer back. The two can coexist.
7. **Keep the mailbox and worker pool as an optional mode.** Rejected (YAGNI): its only benefit, a queue shared between terminals, has no current user, and it is the source of the "task waits for `crewmate up`" failure.

## 8. Decisions still open (for Aashish)

1. **Name.** firstmate calls its workers "crewmates", so search results will collide. Keep `crewmate`, or rename before the first public release?
2. **npm publishing** for use outside Claude Code: in v1, or later?

## 9. Left to the builder

- Internal module layout under `lib/`, event line wording, and the exact critique prompt text (within 4.7's content).
- How `ask` words its foreground or background choice in the command prompt.
- The exact agy `--settings` allow-list for `--write`, provided it allows file edits in the working directory only.
- Whether `watch` with several ids prefixes each line with the vendor or the job id.
