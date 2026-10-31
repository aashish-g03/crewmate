**Codebase Details Goldfish: review of plan lines 74–473 against the Implementation Readiness Standard**

Verdict: **FAILS.** The plan has 2 Blockers and 9 Majors. Several steps fail as written, and several tests assert values or behaviour that the real sources do not support.

## Blockers

**1. Task 1 Step 1: the tag `v0.2.0` already exists.**
- The command is `git tag v0.2.0 7006e7a`.
- `v0.2.0` already exists locally and on `origin`, pointing at `b0f1f02` ("v0.2.0: initial release"). The command fails.
- Separately, `7006e7a` is the correct merge-base of `design/plugin-v1` and `feat/antigravity-worker`.
- The plan must pick another tag name (for example `v0.2-final`) or say to leave the existing tag alone.

**2. Task 1 Step 4 and Global Constraints: the Apache-2.0 header does not exist.**
- The plan says to "Keep the original Apache-2.0 header" with the line `Copyright 2026 OpenAI`.
- None of the four vendored files (`process.mjs`, `args.mjs`, `fs.mjs`, `git.mjs` in `.../cpc/plugins/codex/scripts/lib/`) has any header. Each starts directly with `import` or `export`. Only the repo-level `NOTICE` (13 lines) carries the notice.
- The implementer has to invent the header text. The plan must give the exact lines to prepend.
- The "Only edit" for `git.mjs` is a no-op: it already imports `./fs.mjs` and `./process.mjs`.

## Majors

**3. `parseArgs` cannot handle optional-value flags (`--resume[=id]`, `--diff [ref]`).**
- If declared as boolean, `--resume=abc` becomes `true` and the id is lost (`inlineValue !== "false"`).
- If declared as a value option, a bare `--resume` consumes the next token, which is the prompt.
- The plan does not say how these flags are parsed.

**4. The Review Focus 1 test contradicts the agy `buildArgs` order (Task 5).**
- The test says the prompt "is the last element … right after `-p` for agy".
- The specified agy args are `['-p', prompt, '--output-format', …]`, so the prompt is at index 1, not last.
- Separately, commands pass `$ARGUMENTS` unsplit. The vendored `splitRawArgumentString` in `args.mjs` exists for exactly this, but the plan never mentions it.

**5. The vendored helpers lack two behaviours the plan relies on.**
- `runCommand` does not forward a `timeout` to `spawnSync`. It also maps a `null` status (killed by signal) to `0`.
- So the setup probe's "30 s kill" (Task 9) cannot be built on the vendored helper as listed, and a killed probe looks like exit 0.
- `terminateProcessTree` sends only SIGTERM, with no SIGKILL escalation. It is listed as reused, but Task 6 specifies its own group kill. The plan should say which one is used.

**6. A fixture assertion does not match the recorded data (Task 5).**
- "One `tool` start/done pair for `ls -la`" does not match `codex.ndjson`: the recorded command is `/bin/zsh -lc 'ls -la'`. The plan should state the expected `target` string exactly.
- The other values check out:
  - `01a193d0-87dd-7341-9392-cbf04ee3bb21` and usage 29395 match.
  - `codex-denied.ndjson` has two `agent_message` items, so two notes is correct.
  - `agy2.ndjson` matches: `display_name: RunCommand`, `response: ""`, `permission_mode: request-review`.
  - `agy-plan.ndjson` has `read_file`/`write_file` ACTIVE then DONE with SUCCESS.

**7. The first-model-event deadline is undermined by events emitted before the model replies (Tasks 5–6).**
- For agy, `isModelEvent` is true for any `step_update`. Every agy fixture emits `step_index 0 user_input DONE` right after `init`, before the model replies.
- For codex, `turn.started` counts, and it also appears before model output.
- So a vendor that hangs after these lines (for example, signed out) passes the deadline. Test 5b only covers "init only".
- The plan should exclude `user_input` steps and `turn.started`.

**8. Fixtures and environment values the tests need are never specified.**
- Tests require fixtures that appear in no Files list:
  - a codex line with `exit_code: 1` (test 4);
  - an agy `init.permission_mode: auto` (test 12);
  - 20 consecutive `read_file` DONE steps (merge test).
- Codex jobs reach `done` only if the fake writes a non-empty `-o` file. No default `FAKE_ANSWER` is given, so tests (4) and Task 8 "exits 0 for `codex.ndjson`" fail with "vendor returned no answer" unless it is set.
- The synthetic fixture is described both as "a JSON `note` object" and as having `event: fixture_note`, which is inconsistent.

**9. The missing-binary tests are not isolated from real CLIs (Tasks 7 and 9).**
- "PATH without fake-bin" will still find the real `codex` (0.166.0) and `agy` (1.4.12) on this machine.
- The plan must say the PATH is a temp dir holding only a `node` symlink.
- `critique` "with only codex on PATH" needs a separate fake-bin dir, since `tests/fake-bin` holds both fakes.

**10. The writer lock and job-state lifecycle have gaps.**
- `releaseWriter` is "called by the runner", but Task 6's step list (written before `lock.mjs` exists) never adds it. No task modifies `runner.mjs` later.
- `acquireWriter` does not say what happens when the holder's `readJob` returns `null`. The lock is taken before the job is created, so a racing second caller could unlink a fresh lock, which breaks Review Focus 5.
- `effectiveState` marks a `queued` job with `runner: null` (the window before `spawnRunner`) as `failed / runner died`.

**11. The Task 1 scope is incomplete.**
- **`package.json`:** it is not said whether this is a full replacement. The existing `files`, `description`, `keywords`, `repository` and `dependencies` would stay stale under a merge.
- **`.gitignore`:** marked "Modify" with no content given.
- **`npx tsc -p .`:** requires `npm install` of the dev dependencies. That step is missing, and so is a lockfile policy now that `bun.lock` is deleted.
- **Tracked v0.2 files left untouched:**
  - `.claude/CLAUDE.md` (Bun commands and the mailbox design)
  - `.claude/agents/gemini-worker.md`
  - `.claude/scheduled_tasks.lock`
  - `templates/crewmate.md` (only the folder is listed)
  - `docs/superpowers/plans/2026-05-04-acp-transport.md`

## Nits

- **Event `n` (Task 4):** described as both "adds `n`" and "the runner passes it in as `ev.n`". The test "append 3 → n=1,2,3" is ambiguous about which side owns the counter.
- **`--diff [ref]` (Task 7):**
  - Which call: `resolveReviewTarget(cwd, {base: ref})` or `scope: 'working-tree'`? The plan does not say.
  - Which field of `collectReviewContext` fills `{{TARGET}}`? It returns an object; `content` is the likely field.
  - Truncation: above 2 files or 256 KB it inlines only a summary ("self-collect"), and the plan does not mention this.
- **Gemini parser:**
  - No `usage` event or `Outcome.usage` source is specified, though `result.usage` and step `usage` exist.
  - An `agent_response` DONE with no buffered text (`agy-plan` step 1) would emit an empty note. The plan does not say whether to skip it.
- **Codex `Outcome.answer`:** comes from `resultFile`, but `finish(exitCode)` has no access to that path. The plan does not say who reads it.
- **`spawnRunner`:** neither the `logFd` file path nor how `binPath` is resolved is specified.
- **"Ready" means two different things:** for `critique`, ready means "binary on PATH"; for `setup`, it also means signed in.
- **`processStartTime`:** `ps -o lstart=` output has trailing spaces, so the trim is required. It is specified correctly.

## Verified correct

- Vendored exports and signatures: `runCommand`, `binaryAvailable`, `terminateProcessTree`, `parseArgs`, `resolveReviewTarget`, `collectReviewContext`.
- `codex exec` and `codex exec resume` take `--json`, `--skip-git-repo-check`, `-o`, `-c` and `-m`. `resume` has no `-s`, so using `-c sandbox_mode` is correct.
- `codex login status` exists.
- agy has `--mode {accept-edits, auto, plan}`, `--effort`, `--conversation`, `--print-timeout` and `--dangerously-skip-permissions`.
- `claude plugin validate <path>` exists.
- Node is v20.19.4.
