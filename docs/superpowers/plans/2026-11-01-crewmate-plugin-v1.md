# crewmate v1 Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace crewmate v0.2 (Bun mailbox, worker pool, MCP server, subagent) with a zero-dependency Node.js program, shipped as a Claude Code plugin, that runs Codex and Gemini (agy) jobs as detached processes with live, accurate progress.

**Architecture:** One CLI (`plugins/crewmate/bin/crewmate`) implements every command. `ask` and `critique` spawn a detached runner per job (`crewmate _run <id>`). The runner drives one vendor CLI process (`codex exec --json` or `agy -p --output-format stream-json`) through a vendor adapter, and writes `job.json`, `events.ndjson` and `result.md` under `~/.crewmate/workspaces/<slug>-<hash>/jobs/<id>/`. `watch`, `status`, `result` and `cancel` only read and act on that state. The plugin layer is Markdown (commands and one skill) calling `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate"`.

**Tech Stack:** Node.js 20+, ES modules (`.mjs`) with JSDoc types, `node:test` for tests, `tsc --checkJs` (dev only) for type checks. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-01-crewmate-plugin-design.md` (revision 3, approved 2026-11-01). Section numbers below (§4.4 and so on) refer to it. Recorded CLI output lives in `docs/superpowers/specs/egm-review-2026-11-01/*.ndjson`.

## Global Constraints

- Node.js `>=20`. `package.json` has no `dependencies`; `devDependencies` holds only `typescript` and `@types/node`.
- Only `node:` built-in imports in `plugins/crewmate/`.
- Supported platforms: macOS and Linux (process groups, `ps -o lstart=`). Windows is out of scope (plan ruling; the spec is silent).
- State root is always `~/.crewmate/workspaces/<slug>-<hash>/` (`<hash>` = first 16 hex chars of SHA-256 of the workspace root's real path). Never read `CLAUDE_PLUGIN_DATA`. Tests override the home folder with `CREWMATE_HOME`.
- Vendor names: exactly `codex` and `gemini`. Vendor names and job ids must match `/^[a-z0-9][a-z0-9-]{0,63}$/`.
- Final states: `done`, `failed`, `timeout`, `canceled`. Running states: `queued`, `running`.
- Exit codes: 0 done (or job id printed), 1 failed, 2 usage, 3 vendor binary not on PATH (no job created), 4 timeout, 5 canceled, 6 refused (writer busy, or `--resume` while that vendor has a running job), 7 `critique` with no ready vendor.
- Defaults: job timeout 10 minutes; first-model-event deadline 45 s; cancel grace 5 s before SIGKILL; retention 50 finished jobs per workspace; `note` text truncated to 200 chars; agy setup probe limit 30 s.
- Test-only environment overrides (documented in `AGENTS.md`, not in the README): `CREWMATE_HOME`, `CREWMATE_FIRST_EVENT_MS`, `CREWMATE_CANCEL_GRACE_MS`.
- Inside Claude Code, commands and the skill always call `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate" …`, never bare `crewmate`.
- Copied files from openai/codex-plugin-cc keep their Apache-2.0 header line `Copyright 2026 OpenAI`, and the repo gets a `NOTICE` file carrying that notice. crewmate's own code stays MIT.
- No npm publishing in this plan (Aashish, 2026-11-01). `package.json` keeps `"private": true` until then.
- Commit messages carry no Co-Authored-By or Claude attribution trailers (the existing crewmate history has none).

## Review Focus

These five inputs are implied by the spec but easy to miss. Each one's test is added to the task that owns the code.

1. **A prompt containing quotes, newlines or a leading `-`** is passed to the vendor intact and never parsed as a flag. Test in Task 5 (`buildArgs` puts the prompt after `--`, or uses stdin where the CLI supports it). Test in Task 7 (prompt from `--prompt-file` and stdin).
2. **A workspace path with spaces or non-ASCII characters** gives a valid slug and works end to end. Test in Task 2.
3. **A vendor line that is not JSON**, or JSON of an unknown event type, becomes a `note` and never crashes the runner. Test in Task 5.
4. **`watch` started before the runner has written `events.ndjson`** waits for the file instead of exiting or crashing. Test in Task 8.
5. **Two `ask --write` calls started at the same moment**: exactly one gets the writer lock. Test in Task 7.

---

## File Structure

```text
.claude-plugin/marketplace.json          marketplace listing one plugin (Task 1)
NOTICE                                   Apache-2.0 notice for copied files (Task 1)
package.json, tsconfig.json              Node project, checkJs (Task 1)
plugins/crewmate/
  .claude-plugin/plugin.json             plugin manifest (Task 1)
  bin/crewmate                           entry point: #!/usr/bin/env node, dispatches commands (Task 1, grows per task)
  lib/vendored/process.mjs, args.mjs, fs.mjs, git.mjs   copied from codex-plugin-cc (Task 1)
  lib/names.mjs                          name/id validation (Task 2)
  lib/workspace.mjs                      workspace root + state folder (Task 2)
  lib/jobs.mjs                           job records, list, prune (Task 2)
  lib/liveness.mjs                       pid + start time, effective state (Task 3)
  lib/events.mjs                         event append/read (Task 4)
  lib/vendors/codex.mjs, gemini.mjs, index.mjs   adapters (Task 5)
  lib/runner.mjs                         the detached job runner (Task 6)
  lib/commands/ask.mjs, critique.mjs     job start, writer lock, resume (Task 7)
  lib/commands/watch.mjs, status.mjs, result.mjs, cancel.mjs   readers (Task 8)
  lib/commands/setup.mjs                 readiness report (Task 9)
  lib/critique-template.md               critique prompt, adapted from EGM (Task 7)
  commands/*.md, skills/crewmate/SKILL.md   Claude Code layer (Task 10)
tests/
  fixtures/*.ndjson                      recorded vendor output (Task 1)
  fake-bin/codex, fake-bin/agy           fake CLIs replaying fixtures (Task 5)
  helpers.mjs                            temp HOME, PATH with fake-bin, run CLI (Task 2)
  *.test.mjs                             one file per task
```

**Plan ruling (spec §4.2, reused code):** `process`, `args`, `fs` and `git` are copied with only the edits listed in Task 1. For `state`, `tracked-jobs`, `job-control` and `render`, more than half of each would change (shared index removal, start times, the Codex import, Codex-specific review rendering). So `jobs.mjs`, `liveness.mjs` and the command files are written new, following those modules' folder scheme and naming. The spec allows adaptation; this records how far it goes.

---

## Detailed Implementation Plan

### Task 1: Clean slate, packaging and copied modules

**Files:**
- Delete: `src/`, `bin/crewmate` (Bun), `templates/`, `scripts/`, `bun.lock`, `tsconfig.json`
- Create: `.claude-plugin/marketplace.json`, `NOTICE`, `plugins/crewmate/.claude-plugin/plugin.json`, `plugins/crewmate/bin/crewmate`, `plugins/crewmate/lib/vendored/{process,args,fs,git}.mjs`, `tsconfig.json`, `tests/fixtures/` (the five `.ndjson` files from `docs/superpowers/specs/egm-review-2026-11-01/`)
- Modify: `package.json`, `.gitignore`
- Test: `tests/packaging.test.mjs`

**Interfaces:**
- Produces: `bin/crewmate` dispatches `argv[2]` to `lib/commands/<name>.mjs`, which exports `async function run(argv: string[], io: {stdout, stderr, stdin, env, cwd}): Promise<number>` (the exit code). Unknown command → usage text on stderr, exit 2. Every later command file follows this contract.
- Produces (vendored): `runCommand(cmd, args, opts) → {status, stdout, stderr, error}`, `binaryAvailable(cmd, versionArgs) → {available, detail}`, `terminateProcessTree(pid, opts)`, `parseArgs(argv, {valueOptions, booleanOptions, aliasMap}) → {options, positionals}`, `resolveReviewTarget(cwd, {base, scope})`, `collectReviewContext(cwd, target)`.

- [ ] **Step 1:** Tag the old state: `git tag v0.2.0 7006e7a` (the last v0.2 commit on `feat/antigravity-worker`). Do not push the tag until Aashish approves the branch.
- [ ] **Step 2: Write the failing test** `tests/packaging.test.mjs`:
  - `test('plugin manifests are valid')`: `spawnSync('claude', ['plugin','validate','.'])` exits 0. Skip with a message if `claude` is not on PATH.
  - `test('no runtime dependencies')`: `package.json` has no `dependencies` key; every `import` in `plugins/crewmate/**/*.mjs` starts with `node:` or `.`.
  - `test('unknown command exits 2')`: running `node plugins/crewmate/bin/crewmate nope` exits 2 and stderr contains `usage`.
- [ ] **Step 3: Run** `node --test tests/` → FAIL (files missing).
- [ ] **Step 4: Implement.**
  - `marketplace.json`: `{"name":"crewmate","owner":{"name":"Aashish Gupta"},"plugins":[{"name":"crewmate","source":"./plugins/crewmate","description":"Hand work from Claude Code to Codex and Gemini (agy): background jobs, live progress, goldfish critique."}]}`.
  - `plugin.json`: name `crewmate`, version `1.0.0`, the same description, author `Aashish Gupta`.
  - `package.json`: name `crewmate`, version `1.0.0`, `"private": true`, `"type":"module"`, `"engines":{"node":">=20"}`, `"bin":{"crewmate":"plugins/crewmate/bin/crewmate"}`, scripts `test` = `node --test tests/` and `typecheck` = `tsc -p .`.
  - `tsconfig.json`: `allowJs`, `checkJs`, `noEmit`, `strict: false`, `module/moduleResolution: nodenext`, include `plugins/crewmate/**/*.mjs`.
  - Copy the four vendored files from `codex-plugin-cc@main` `plugins/codex/scripts/lib/`. Keep the original Apache-2.0 header and add a line naming the source path. Only edit: `git.mjs` imports from `./fs.mjs` and `./process.mjs` in the same folder.
  - `NOTICE`: the codex-plugin-cc NOTICE text plus one line listing the copied files.
- [ ] **Step 5: Run** `node --test tests/ && npx tsc -p .` → PASS.
- [ ] **Step 6: Commit** `chore: v1 skeleton — Node plugin layout, vendored helpers, v0.2 code removed`.

### Task 2: Names, workspace and job records

**Files:**
- Create: `plugins/crewmate/lib/{names,workspace,jobs}.mjs`, `tests/helpers.mjs`
- Test: `tests/jobs.test.mjs`

**Interfaces:**
- Produces:
  - `assertName(kind: 'vendor'|'job', value: string): string`: throws `UsageError` (exported class, carries exit code 2) unless it matches the global regex.
  - `resolveWorkspace(cwd: string, env = process.env): {root: string, slug: string, stateDir: string}`
    - `root` = git root via `git rev-parse --show-toplevel`, else `realpath(cwd)`.
    - `slug` = `basename(root)` with characters other than `[A-Za-z0-9._-]` replaced by `-` (`workspace` if empty).
    - `stateDir` = `${env.CREWMATE_HOME ?? os.homedir()}/.crewmate/workspaces/${slug}-${hash16}`.
  - `newJobId(vendor: string): string`: `${vendor}-${base36 time}-${4 random base36}`, which satisfies the name regex.
  - `jobDir(ws, id): string`
  - `writeJob(ws, job: Job): void`: atomic (write `job.json.tmp`, then `rename`).
  - `readJob(ws, id): Job | null`
  - `updateJob(ws, id, patch: Partial<Job>): Job`
  - `listJobs(ws): Job[]`: newest first by `createdAt`, read from the job folders (no shared index).
  - `pruneJobs(ws, keep = 50): string[]`: deletes the folders of *finished* jobs beyond the newest `keep` finished ones and returns their ids; running jobs are untouched.
  - `Job` (JSDoc typedef):
    ```text
    {id, vendor, kind: 'ask'|'critique', prompt, promptSummary, flags: {write, yolo, model, effort, timeoutMs, resumeFrom},
     state, createdAt, startedAt, endedAt, runner: {pid, startTime} | null,
     vendorConversationId, outcome: {exitCode, reason, deniedTools[], toolErrors[], usage, answerBytes} | null}
    ```
- Produces (`tests/helpers.mjs`):
  - `tempHome(): {home, cleanup}`
  - `runCli(args: string[], {cwd, env, input}): Promise<{code, stdout, stderr}>`: runs the real `bin/crewmate` with `CREWMATE_HOME` set and `tests/fake-bin` first on PATH.
  - `waitFor(fn, ms)`

- [ ] **Step 1: Write failing tests** in `tests/jobs.test.mjs`:
  - `assertName rejects '../x', 'A', '', 65 chars; accepts 'codex', 'gemini-k2x-ab12'`.
  - `resolveWorkspace` on a temp dir named `my repo ü` (Review Focus 2) → slug `my-repo--`, `stateDir` under `CREWMATE_HOME`, hash = sha256(realpath) first 16 hex.
  - The same folder inside a `git init` subfolder resolves to the git root.
  - `writeJob`/`readJob` round-trip; a leftover `job.json.tmp` never shadows `job.json`.
  - `pruneJobs`: with 52 finished jobs and 3 running jobs, 2 finished folders are removed and all 3 running jobs stay.
- [ ] **Step 2: Run** `node --test tests/jobs.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the three modules per the Interfaces block.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: workspace state folder and job records`.

### Task 3: Runner liveness

**Files:**
- Create: `plugins/crewmate/lib/liveness.mjs`
- Test: `tests/liveness.test.mjs`

**Interfaces:**
- Consumes: `Job` from Task 2.
- Produces:
  - `processStartTime(pid: number): string | null`: trimmed output of `ps -o lstart= -p <pid>`, or `null` if no such process.
  - `isRunnerAlive(job: Job): boolean`: true only if `job.runner` is set, the pid exists and `processStartTime(pid) === job.runner.startTime`.
  - `effectiveState(job: Job): {state, reason}`: returns `{state: 'failed', reason: 'runner died'}` when `job.state` is `queued` or `running` and the runner is not alive; otherwise the stored state and reason.

- [ ] **Step 1: Write failing tests:**
  - A live child (`spawn('sleep', ['30'])`) with its real start time → alive.
  - The same pid with a different stored start time → not alive (pid reuse).
  - A killed child → not alive.
  - `effectiveState` of a `running` job whose runner died → `failed` / `runner died`. A `done` job is unchanged.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat: runner liveness with pid start-time check`.

### Task 4: Event log

**Files:**
- Create: `plugins/crewmate/lib/events.mjs`
- Test: `tests/events.test.mjs`

**Interfaces:**
- Produces:
  - `appendEvent(dir: string, ev: Event): void`: one `JSON.stringify` line plus `\n`, written with `appendFileSync`; adds `t` (ISO time) and `n` (1-based sequence number, from a counter the runner owns and passes in as `ev.n`).
  - `readEvents(dir: string, sinceN = 0): Event[]`: parses complete lines only; a trailing partial line is ignored until it is complete.
  - `Event` types, exactly as §4.5:
    - `{type:'started', vendor, model}`
    - `{type:'tool', name, target, phase:'start'|'done'|'error'}`
    - `{type:'note', text}` (≤200 chars, enforced here)
    - `{type:'usage', input, output}`
    - `{type:'end', state, outcome}`

- [ ] **Step 1: Write failing tests:**
  - append 3 events then read → 3 events with `n` = 1, 2, 3.
  - A file ending in a half-written line → that line is not returned.
  - `readEvents(dir, 2)` → only `n` = 3.
  - A 500-char `note` is stored truncated to 200 characters with a trailing `…`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat: append-only job event log`.

### Task 5: Vendor adapters and fake CLIs

**Files:**
- Create: `plugins/crewmate/lib/vendors/{index,codex,gemini}.mjs`, `tests/fake-bin/codex`, `tests/fake-bin/agy`, `tests/fixtures/agy-denied-with-answer.ndjson` (synthetic)
- Test: `tests/vendors.test.mjs`

**Interfaces:**
- Produces:
  - `getAdapter(vendor): Adapter` (throws `UsageError` for unknown vendors).
  - `Adapter`:
    ```text
    { binary: 'codex'|'agy',
      buildArgs(job: Job, resultFile: string): string[],
      createParser(): { feed(line: string): Event[], isModelEvent(line: string): boolean, finish(exitCode: number): Outcome },
      expectedPermissionMode: 'request-review' | null }
    ```
    - `Outcome` = `{conversationId, answer, deniedTools: string[], toolErrors: string[], usage, vendorError: string|null, permissionMode: string|null}`
- **Codex `buildArgs`:**
  - Fresh job: `['exec','--json','--skip-git-repo-check','-o',resultFile, ...perm, ...model, ...effort, '--', prompt]`.
  - Resume: `['exec','resume','--json','--skip-git-repo-check','-o',resultFile, ...perm, ...model, ...effort, conversationId, '--', prompt]`.
  - `perm`:
    - default: `['-c','sandbox_mode="read-only"']`
    - `write`: `['-c','sandbox_mode="workspace-write"']`
    - `yolo`: `['--dangerously-bypass-approvals-and-sandbox']`
  - `model`: `['-m', m]`. `effort`: `['-c', 'model_reasoning_effort="<e>"']`.
  - The runner spawns with stdin `'ignore'`.
- **Codex parser:**
  - `thread.started` → `conversationId` (no event).
  - `item.started` / `item.completed` with `item.type === 'command_execution'` → `tool` (`name:'shell'`, `target`: the command truncated to 80 chars). Phase is `start` on started. On completed it is `done` when `exit_code === 0`, else `error`, and the command is pushed to `toolErrors`.
  - `agent_message` → `note`.
  - `turn.completed.usage` → `usage`.
  - `isModelEvent`: `type` starts with `item.` or `turn.`.
  - The answer comes from `resultFile` after exit.
- **Gemini `buildArgs`:**
  - `['-p', prompt, '--output-format','stream-json','--print-timeout', `${secs}s`, '--mode', mode, ...model, ...effort, ...resume]`
  - `mode`: `plan` (default) or `accept-edits` (`write`). With `yolo`, use `--dangerously-skip-permissions` instead of `--mode`.
  - `model`: `--model m`. `effort`: `--effort e`. `resume`: `--conversation <id>`.
- **Gemini parser:**
  - `init` → `conversationId` and `permissionMode` (no event).
  - `step_update` with `step_type==='tool'` → `tool` (`name: tool_name`, `target`: the first string parameter truncated to 80 chars). Phase is `start` for `ACTIVE`, `done` for `DONE` and `error` for `ERROR`. Repeated `ACTIVE` updates for the same `step_index` emit only once.
  - `step_update` `agent_response` with `text_delta` → buffered; emitted as one `note` when the step reaches `DONE`.
  - `result` → `answer` = `response`, `deniedTools` = `denied_actions[].display_name`, `vendorError` when `status !== 'SUCCESS'`.
  - `isModelEvent`: `event` is `step_update` or `result`.
  - `expectedPermissionMode` is `request-review` unless `yolo`, in which case it is `null`.
- **Both parsers:** a line that is not JSON, or has an unknown type, → `{type:'note', text: line}` (Review Focus 3).
- **Fake CLIs** (`tests/fake-bin/codex`, `tests/fake-bin/agy`, executable `#!/usr/bin/env node` scripts):
  - They replay `$FAKE_FIXTURE` line by line, waiting `$FAKE_DELAY_MS` (default 0) between lines, then exit with `$FAKE_EXIT` (default 0).
  - They append their argv as JSON to `$FAKE_ARGV_LOG` when that is set.
  - The codex fake writes `$FAKE_ANSWER` to the file after `-o`.
  - `FAKE_HANG=1` prints nothing and sleeps forever. `FAKE_HANG_AFTER=n` prints n lines, then sleeps.
- **Synthetic fixture** `agy-denied-with-answer.ndjson`: a copy of `agy2.ndjson` with `"response":"done"`. Its first line is a JSON `note` object saying it is synthetic; the parser skips lines whose `event` is `fixture_note`.

- [ ] **Step 1: Write failing tests**, feeding the real fixtures through `createParser()`:
  - `codex.ndjson` → one `tool` start/done pair for `ls -la`, `conversationId` = `01a193d0-87dd-7341-9392-cbf04ee3bb21`, usage input 29395.
  - `codex-denied.ndjson` → no `tool` events, no `toolErrors`, two notes (the documented limit).
  - `agy2.ndjson` → a tool `error` for `run_command`, `deniedTools` = `['RunCommand']`, `answer` = `''`, `permissionMode` = `request-review`.
  - `agy-plan.ndjson` → `read_file` and `write_file` start/done, `vendorError` null.
  - A non-JSON line → a `note`.
  - `buildArgs`:
    - A prompt `"-rf \"quoted\"\nline2"` is the last element, after `--` for codex and right after `-p` for agy (Review Focus 1).
    - A codex resume job contains `resume`, the conversation id and `sandbox_mode="read-only"`, and no `-s`.
    - An agy `write` job contains `--mode accept-edits`.
    - An agy `yolo` job contains `--dangerously-skip-permissions` and no `--mode`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS. Check by hand, once each, that the real CLIs accept a prompt starting with `-`:
  - `agy -p "-x test" --output-format stream-json --print-timeout 30s`
  - `codex exec --json --skip-git-repo-check -c sandbox_mode="read-only" -- "-x test" < /dev/null`
  - `codex exec resume --json --skip-git-repo-check <id from the previous run> -- "-x again" < /dev/null`

  If one rejects it, prefix the prompt with a space in that adapter's `buildArgs` and record why in a comment.
- [ ] **Step 5: Commit** `feat: codex and gemini adapters with recorded-fixture parsers`.

### Task 6: The job runner

**Files:**
- Create: `plugins/crewmate/lib/runner.mjs`, wired into `bin/crewmate` as the hidden command `_run <jobId>`
- Test: `tests/runner.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `spawnRunner(ws, job): {pid, startTime}`: `spawn(process.execPath, [binPath, '_run', job.id], {detached: true, stdio: ['ignore', logFd, logFd], cwd: ws.root})`, then `unref()`. Records `runner` on the job before returning.
  - `runJob(ws, jobId): Promise<void>`: the body of `_run`.
- `runJob` behaviour, in order:
  1. Set the job to `running`, append `started`.
  2. Spawn `adapter.binary` with `buildArgs(job, <jobDir>/result.md)` in `ws.root`, `detached: true` (its own group), stdin `'ignore'`.
  3. Feed each stdout line to the parser and append its events.
  4. If `expectedPermissionMode` is set and the parser reports a different `permissionMode` → kill the group and end `failed`, reason `agy permission mode is <x>, expected request-review (check your agy settings)`.
  5. **First-model-event deadline** (`CREWMATE_FIRST_EVENT_MS`, default 45000): if no `isModelEvent` line has arrived by then → kill and end `failed`, reason `vendor did not respond`, plus the `setup` fix text for that vendor.
  6. **Job deadline** `flags.timeoutMs` → kill and end `timeout`.
  7. On SIGTERM to the runner (from `cancel`) → kill the vendor group, end `canceled`.
  8. On vendor exit, `finish(code)`, then decide the state:
     - non-zero exit or `vendorError` → `failed`;
     - empty `answer` (after trim) → `failed`, reason `vendor returned no answer`;
     - otherwise `done`.
  9. Write `result.md` (agy: `answer`; codex: already written by `-o`). Store `vendorConversationId` and `outcome` on the job. Append `end`.
- Killing a group: `process.kill(-pid, 'SIGTERM')`, then `SIGKILL` after `CREWMATE_CANCEL_GRACE_MS` (default 5000).

- [ ] **Step 1: Write failing tests.** Each test creates a job record and calls `spawnRunner`, then waits on `effectiveState`. All use the fakes from Task 5. The numbers are spec §4.11 failure modes.
  - (1) `FAKE_EXIT=2` with `codex.ndjson` → `failed`.
  - (2) agy with `agy-denied-with-answer.ndjson` → `done`, `outcome.deniedTools` = `['RunCommand']`, the event log has a tool `error`.
  - (3) agy with `agy2.ndjson` → `failed`, reason `vendor returned no answer`.
  - (4) codex with a fixture line whose `exit_code` is 1 → `done`, with `toolErrors` length 1.
  - (5) `FAKE_HANG=1`, `CREWMATE_FIRST_EVENT_MS=300` → `failed`, reason `vendor did not respond`, and the fake's process group is gone (`process.kill(-pid, 0)` throws).
  - (5b) `FAKE_HANG_AFTER=1` with an agy fixture (only `init`) and a 300 ms deadline → `failed` (`init` is not a model event).
  - (6) `FAKE_HANG_AFTER=3` with `timeoutMs: 500` → `timeout`, group gone.
  - (12) agy with a fixture whose `init.permission_mode` is `auto` → `failed` before any `tool` event.
  - (8) `kill -9` the runner pid mid-job (`FAKE_DELAY_MS=200`) → `effectiveState` = `failed` / `runner died`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat: detached job runner with deadlines, permission guard and honest final states`.

### Task 7: `ask`, `critique`, writer lock and resume

**Files:**
- Create: `plugins/crewmate/lib/commands/{ask,critique}.mjs`, `plugins/crewmate/lib/lock.mjs`, `plugins/crewmate/lib/critique-template.md`
- Test: `tests/ask.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–6; `binaryAvailable` and `resolveReviewTarget`/`collectReviewContext` (vendored); `watch.run` from Task 8, which `ask` calls inline when `--detach` is absent. Task 8 lands after this task; until then `ask` without `--detach` returns 0 after printing the id, and Task 8 Step 3 switches it to the inline watch.
- Produces:
  - `acquireWriter(ws, jobId): {ok: true} | {ok: false, holder: string}`: `fs.openSync(<stateDir>/writer.lock, 'wx')` and write the job id. On `EEXIST`, read the holder; if the holder job is not alive (`effectiveState` is final), unlink and retry once.
  - `releaseWriter(ws, jobId)`: removes the lock only if it holds `jobId`. The runner calls it when a write or yolo job ends.
- **`ask <vendor> [prompt]`:**
  - Flags: `--detach --resume[=id] --model --effort --write --yolo --timeout --prompt-file --json`.
  - The prompt comes from the positional, else `--prompt-file`, else piped stdin. An empty prompt is exit 2.
  - Order of checks:
    1. `assertName`.
    2. Binary on PATH, else exit 3 with the fix text.
    3. `--resume`: find the target job (the given id, else the newest `ask` job for that vendor in this workspace). If none → exit 2, `nothing to resume`. If any job for this vendor is running → exit 6. Copy its `vendorConversationId`.
    4. Writer lock for `--write`/`--yolo` → exit 6 with the holder id.
    5. `pruneJobs`, create the job, `spawnRunner`.
  - Output: the job id line (`--json`: `{jobId}`), then the inline watch unless `--detach`.
- **`critique <path…> | --diff [ref]`:**
  - Flags: `--vendors codex,gemini`, default all.
  - Ready vendors = binary available. If none → exit 7.
  - The prompt is `critique-template.md` with `{{TARGET}}` replaced by the path list, or by the `--diff` output from the vendored git helpers.
  - Starts one read-only, `kind:'critique'` job per ready vendor, prints one id per line and exits 0.
- **`critique-template.md`:** the five questions from §4.7 in that order, and the severity tags `blocker|major|minor` with file:line. It opens with a comment crediting google/elephant-goldfish-model (Apache-2.0), `agents/comprehension.md` and `agents/design_critic.md`.

- [ ] **Step 1: Write failing tests** (real CLI through `runCli`, fakes on PATH):
  - Missing binary (PATH without `fake-bin`) → exit 3, no job folder created.
  - (9) A second `--write` while the first job (`FAKE_DELAY_MS=300`) runs → exit 6 naming the first id.
    - After the first ends, a new `--write` → exit 0.
    - A lock left by a killed runner does not block.
  - Review Focus 5: two `ask --write --detach` started with `Promise.all` → exactly one exits 0 and one exits 6.
  - (10) `--resume` after a finished codex job → the fake's argv log shows `resume <thread_id>`.
    - Critique jobs are skipped.
    - `--resume` while a codex job runs → exit 6.
  - (16) A resumed codex job without `--write` has `sandbox_mode="read-only"` in argv.
  - (11) `ask ../x hi` → exit 2.
  - Review Focus 1: a prompt from `--prompt-file` containing quotes and newlines arrives byte-identical in the fake's argv log.
  - `critique a.md` with only `codex` on PATH → one job id, exit 0. With no vendors → exit 7.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat: ask and critique commands, atomic writer lock, resume`.

### Task 8: `watch`, `status`, `result`, `cancel`

**Files:**
- Create: `plugins/crewmate/lib/commands/{watch,status,result,cancel}.mjs`
- Modify: `plugins/crewmate/lib/commands/ask.mjs` (inline watch without `--detach`)
- Test: `tests/watch.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces:
  - `formatEvent(job, ev): string | null`: one line, prefixed by the vendor name.
  - **`watch <id…> [--since n]`:**
    - Polls `readEvents` every 250 ms per job.
    - Merges consecutive `tool` events with the same `name` and phase `done` into one line, `<vendor> <name> ×N`, flushed when a different event arrives or after 2 s.
    - Prints `note` lines at most once per 2 s per job; the rest are dropped, and the count is shown on the next line.
    - Exits when every job's `effectiveState` is final, after printing an `end` line per job, which lists denied tools and tool errors.
    - Exit code: the worst state across the jobs (failed 1 > timeout 4 > canceled 5 > done 0).
    - A job folder without `events.ndjson` yet → keep polling while the job's runner is alive (Review Focus 4).
  - **`status [id] [--json]`:** a table of `listJobs` with `effectiveState`, or one job in full.
  - **`result <id> [--json]`:** the contents of `result.md` plus the outcome block: state, duration, usage, denied tools, tool errors, reason.
  - **`cancel <id>`:** if the runner is alive, `process.kill(runner.pid, 'SIGTERM')`, wait up to grace plus 1 s for a final state, then print it. If the job is already final, exit 0 with `already <state>`. Never signal when `isRunnerAlive` is false.

- [ ] **Step 1: Write failing tests:**
  - (13) `watch` on a finished job replays all events and exits 0 immediately.
  - (14) `watch` on a job whose runner was `kill -9`'d exits 1 within 2 s, with `runner died`.
  - (15) `watch a b`, where a is `done` and b is a `FAKE_EXIT=2` job → exits 1 only after both end.
  - Merging: a fixture with 20 consecutive `read_file` DONE steps produces ≤ 3 lines.
  - (7) `cancel` on a `FAKE_HANG_AFTER=2` job:
    - the job ends `canceled` (exit 5 from `watch`) and the vendor group is gone;
    - `cancel` on a job whose stored start time does not match a live pid sends no signal (spy: a child with that pid stays alive).
  - Review Focus 4: `watch` started before the runner's first write still prints the `started` line.
  - `ask` without `--detach` exits with the job's exit code (0 for `codex.ndjson`, 1 for `FAKE_EXIT=2`).
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat: watch with merged progress, status, result, cancel`.

### Task 9: `setup`

**Files:**
- Create: `plugins/crewmate/lib/commands/setup.mjs`
- Test: `tests/setup.test.mjs`

**Interfaces:**
- **`setup [--json]`:**
  - Node: `process.versions.node` major ≥ 20, else a `not ready` line.
  - codex:
    - `binaryAvailable('codex')`, and the version line.
    - `codex login status` exit 0 → `ready`; otherwise `not ready: run \`codex login\``.
    - Not installed → `not ready: npm i -g @openai/codex`.
  - gemini (agy):
    - `binaryAvailable('agy')`, and the version line.
    - The probe `agy -p "Reply with the word ok" --output-format stream-json --mode plan --print-timeout 30s`, with a 30 s kill. Ready when a `result` event has `status` `SUCCESS`; otherwise `not ready: run \`agy\` once to sign in`.
    - Not installed → `not ready: curl -fsSL https://antigravity.google/cli/install.sh | bash`.
  - Exit code 0 when at least one vendor is ready, else 3.

- [ ] **Step 1: Write failing tests** with fakes:
  - The fake `codex` answers `login status` with exit 0 → `codex: ready`.
  - A fake agy replaying `agy-plan.ndjson` → `gemini: ready`.
  - A fake agy with `FAKE_HANG=1` and the probe limit overridden to 300 ms (`CREWMATE_FIRST_EVENT_MS` is reused as the probe limit in tests) → `gemini: not ready` within 2 s.
  - No vendors → exit 3.
- [ ] **Step 2–4:** Run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat: setup readiness report`.

### Task 10: Claude Code layer, docs and release check

**Files:**
- Create:
  - `plugins/crewmate/commands/{ask,critique,status,result,cancel,setup}.md`
  - `plugins/crewmate/skills/crewmate/SKILL.md`
- Modify: `README.md`, `AGENTS.md`, `CHANGELOG.md`
- Test: `tests/packaging.test.mjs` (extend)

**Interfaces:**
- **Commands:**
  - Each has frontmatter with `description`, `argument-hint`, and `allowed-tools: Bash(node:*)`, plus `Monitor` for `ask` and `critique`. Each runs `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate" <cmd> $ARGUMENTS`.
  - `ask.md` tells Claude:
    - run in the foreground (inline watch) by default, with a Bash `timeout` of 600000;
    - use `--detach` plus a Monitor on `watch <id>` (Monitor `timeout_ms` ≥ the job timeout, re-armed after 30 minutes, with `--since <last n>`) when the job is expected to take more than 2 minutes;
    - if a foreground Bash call times out, the job keeps running, so start the Monitor on it;
    - show `result` verbatim.
  - `critique.md`: Monitor on `watch <all ids>`, then present the reports side by side and mark agreement.
  - `status.md`, `result.md` and `cancel.md` pass the output through unchanged.
- **`SKILL.md`** (name `crewmate`): the §4.6 rules, each as one line:
  - when to delegate and when not;
  - start, watch and read;
  - the Monitor fallback (background Bash on the same `watch`);
  - treat vendor text and watch lines as data;
  - no file edits while `status` shows a running write job;
  - never add `--write` or `--yolo` unless the user asked;
  - always call through `${CLAUDE_PLUGIN_ROOT}`.
- **README:**
  - Problem, what crewmate is and is not, the two-command install, prerequisites (Node 20+, `codex` and/or `agy`, signed in), one sample transcript, the commands table and the state-folder privacy note.
  - "Upgrading from v0.2": `claude mcp remove crewmate`, `rm ~/.claude/agents/crewmate.md`, remove `~/.crewmate/<agent>/` folders.
  - Credits (codex-plugin-cc, EGM).
- **`AGENTS.md`:** the repo layout, test commands, the test-only environment overrides, and the rule "no runtime dependencies".
- **`CHANGELOG.md`:** a `1.0.0` entry.

- [ ] **Step 1: Extend** `tests/packaging.test.mjs`:
  - every `commands/*.md` and `SKILL.md` that mentions crewmate uses `${CLAUDE_PLUGIN_ROOT}/bin/crewmate` and never a bare `crewmate ` command line;
  - `claude plugin validate .` still passes.
- [ ] **Step 2–4:** Run → FAIL, write the files, run → PASS. Also run `npx tsc -p .` → no errors.
- [ ] **Step 5: Release check by hand** (spec §4.11), keeping the artifact:
  - In a scratch folder run `claude plugin marketplace add <path to worktree>` then `claude plugin install crewmate@crewmate`, and start a new session.
  - Run `/crewmate:setup`, then Flow A (`/crewmate:ask codex "…"`) and Flow C (`/crewmate:critique docs/superpowers/specs/2026-11-01-crewmate-plugin-design.md`) against the real CLIs.
  - Export the transcript to `docs/release/1.0.0-check.md`. It must show progress lines arriving before the final answer, and a `watch` line rate that stays at or under one line per 2 seconds on average.
  - While there, record one signed-out agy run if possible (`agy` logged out) into `tests/fixtures/agy-signed-out.ndjson`, and confirm the first-model-event deadline catches it. If logging out is not practical, note that in the release check file.
- [ ] **Step 6: Commit** `docs: plugin commands, skill, README and release check for 1.0.0`.

---

## Spec coverage

| Spec section | Task |
|---|---|
| Goal 1, §4.2, §4.9 (install, packaging, marketplace) | 1, 10 |
| Goal 2, §4.5 events, `watch` merging | 4, 8 |
| Goal 3, §4.1 one detached runner | 6, 7 |
| Goal 4, final states, denials, empty answer | 5, 6 |
| Goal 5, §4.7 critique | 7, 10 |
| Goal 6, `--resume` | 7 |
| Goal 7, fixed state root | 2 |
| §4.3 exit codes and flags | 7, 8, 9 |
| §4.4 adapters, permission steps, first-event deadline, permission guard | 5, 6 |
| §4.5 retention, dead runner, writer lock, cancel | 2, 3, 7, 8 |
| §4.6 commands and skill | 10 |
| §4.8 setup | 9 |
| §4.10 migration | 1, 10 |
| §4.11 tests 1–16, release check | 6, 7, 8, 10 |
| §5 security rules | 5 (permission flags), 10 (skill) |
