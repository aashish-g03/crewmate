**Implementation Readiness review: `2026-11-01-crewmate-plugin-v1.md` (lines 74 to end)**

Verdict: **not ready.** Two Blockers and nine Majors leave design decisions to the implementer.

---

**1. Severity: Blocker**
**Scope:** Task 1, Step 1 (line 88)
**Finding & Guidance:** `v0.2.0` already exists, both locally and on origin, and points at `b0f1f02`, not `7006e7a`. Running `git tag v0.2.0 7006e7a` fails. The plan must either name a different tag (for example `v0.2.1-final` on `7006e7a`) or say "already tagged, skip".

**2. Severity: Blocker**
**Scope:** Task 7, `ask --resume[=id]` and `critique --diff [ref]`; Task 1, vendored `args.mjs`
**Finding & Guidance:** The vendored `parseArgs` only supports boolean or value options. It has no optional-value options.
- As a value option, `ask codex --resume "prompt"` takes the prompt as the job id.
- As a boolean option, `--resume=abc` becomes `true` and the id is lost (`inlineValue !== "false"`).
- `--diff [ref]` has the same problem.

Task 1 allows no edits to `args.mjs`. The plan must give the parsing rule, for example "boolean `--resume`, plus `--resume=<id>` handled before `parseArgs`", or allow a named edit to `args.mjs`.

**3. Severity: Major**
**Scope:** Tasks 6 and 7: job creation, `spawnRunner`, `runJob` step 1, `effectiveState`
**Finding & Guidance:**
- **Lost update:** `spawnRunner` writes `runner` into `job.json` after spawning, while the child's `runJob` writes `state: running`. Both go through a read-modify-write `updateJob` in separate processes, so one update can be lost. If `runner` is the one lost, the job looks dead.
- **False "runner died":** between "create the job" and the runner being recorded, `runner` is `null`. `isRunnerAlive` is then false, so `status`, `watch` (Review Focus 4) and `acquireWriter` see `failed / runner died`.

The plan should say who owns each field (for example, the runner records its own pid and start time) and how `queued` with `runner: null` is treated (for example, alive for N seconds after `createdAt`).

**4. Severity: Major**
**Scope:** Task 7, `acquireWriter`
**Finding & Guidance:** Two separate races:
- The lock is taken before the job record exists (check 4 runs before check 5). A second caller reads a holder id that has no `job.json`, and the plan does not say what `readJob === null` means. If it counts as dead, both callers get the lock, and the Review Focus 5 test becomes flaky.
- The stale-lock path ("unlink and retry") races too: A unlinks the stale lock and creates its own, then B unlinks A's fresh lock.

Specify both: a missing holder record counts as alive; and after a successful create, re-read the lock and confirm it holds your own id, or use a rename-based handover.

**5. Severity: Major**
**Scope:** Task 6 steps and file list; Task 7, `releaseWriter`
**Finding & Guidance:**
- Task 7 says "the runner calls `releaseWriter`", but `runJob` (Task 6) has no such step and Task 7 does not list `runner.mjs` under Modify. Today only stale-lock recovery would free the lock.
- Test (8) kills the runner, but the vendor runs in its own detached process group and keeps running. `Job` stores no vendor pid, and `cancel` refuses to signal a dead runner.

Decide whether to record the vendor pid and kill its group when a dead runner is found, or state the leak as accepted.

**6. Severity: Major**
**Scope:** Task 5 fake CLIs; Tasks 7 and 9 tests
**Finding & Guidance:**
- `ask` and `setup` call `binaryAvailable`, which runs `spawnSync(cmd, ['--version'])` with no timeout. With `FAKE_HANG=1` (tests 5, 5b and the Task 9 probe test), that call hangs forever.
- The Task 9 test also needs `codex login status` to exit 0, but the fakes are only specified to replay `$FAKE_FIXTURE`.
- `FAKE_ANSWER` has no default. If it is empty, every codex run ends `vendor returned no answer`, which contradicts tests (4), (10) and Task 8's "exit 0 for `codex.ndjson`".

Specify that the fakes answer `--version` and `login status` immediately, and give `FAKE_ANSWER` a default such as `done`.

**7. Severity: Major**
**Scope:** Tasks 5 and 6, agy timeout
**Finding & Guidance:** `--print-timeout` equals `flags.timeoutMs`, which is also the runner's job deadline. Whichever fires first decides the state: if agy stops itself first, its non-zero exit or non-SUCCESS status makes the job `failed`, not `timeout`. That works against Goal 4, and the fake-based test (6) cannot catch it. Either set `--print-timeout` above the job deadline (for example +30 s) or map agy's own timeout to `timeout`.

**8. Severity: Major**
**Scope:** Task 7, `--timeout <duration>`
**Finding & Guidance:** The duration format is never defined (`10m`? `600s`? bare milliseconds?), nor what happens to an invalid value, nor how `${secs}` for agy is rounded. Specify the grammar (for example `^\d+(ms|s|m|h)$`, otherwise exit 2).

**9. Severity: Major**
**Scope:** Task 7, `critique`
**Finding & Guidance:**
- `collectReviewContext` returns an object, and when the diff is large it uses `inputMode: "self-collect"` and inlines no diff. The plan does not say which fields fill `{{TARGET}}`.
- `--diff` with no ref must pass `scope: 'working-tree'`. The default `auto` picks a branch diff when the tree is clean, which contradicts spec §4.3.
- Outside git, `resolveReviewTarget` throws, and no exit code is given.
- Relative paths given from a subfolder are wrong for a vendor running in `ws.root`. The plan should require `ensureAbsolutePath`.
- A large diff passed on argv can exceed ARG_MAX. The plan should set a size cap.

**10. Severity: Major**
**Scope:** Gemini parser (Task 5); `result` (Task 8)
**Finding & Guidance:** The Gemini parser emits no `usage` event, yet the fixtures carry `usage` on each `agent_response` DONE step and on `result`. `Outcome.usage` and the `result` outcome block need a defined source: use `result.usage`, and say whether per-step usage becomes live `usage` events.

**11. Severity: Major**
**Scope:** Task 1 file lists; Task 10 docs
**Finding & Guidance:**
- `.claude/CLAUDE.md` describes the Bun mailbox architecture with `bun install`, and it is the first file a fresh session reads. It is in neither the delete list nor the modify list.
- `.claude/agents/gemini-worker.md` is also unaccounted for.
- `.gitignore` is listed under Modify with no change described.

**12. Severity: Major**
**Scope:** All commands, `--json`
**Finding & Guidance:** Only `ask --json` has a defined shape (`{jobId}`). The JSON output of `status`, `result`, `critique`, `setup` and `cancel` is left to the implementer, even though spec test 2 asserts that denied tools appear in `--json`. Define each schema; `Job` plus `effectiveState` is likely enough.

---

**Nits**
- `appendEvent` both "adds `n`" and takes it from `ev.n`; pick one owner.
- `agent_message` can appear on both `item.started` and `item.completed`; say only `completed` makes a note.
- An empty agy `agent_response` DONE step should not produce an empty note.
- Review Focus 1 says the prompt is "the last element", but for agy it sits right after `-p`, with flags following.
- `_run` lives in `lib/runner.mjs`, which breaks the Task 1 rule that commands live in `lib/commands/<name>.mjs`; state the exception.
- The runner log file name for `logFd` is not given.
- Fixtures for tests (4) (codex `exit_code: 1`), (12) (`permission_mode: auto`) and the 20-`read_file` merge test are synthetic but are not listed under Task 5's Create.
- `cancel`: no exit code is given for "not final after grace + 1 s", and nothing SIGKILLs a runner that ignores SIGTERM.
- `watch`/`status`/`result` behaviour on an unknown id is not given (presumably exit 2).
- The `promptSummary` rule is not given.
- The vendored files have no in-file Apache header to "keep" (they start with `import`). Say to add `// Copyright 2026 OpenAI, Apache-2.0`. Also, `git.mjs` already imports from `./fs.mjs` and `./process.mjs`, so the "only edit" changes nothing.
- `git rev-parse --show-toplevel` should also go through `realpath` before hashing.
- `claude plugin validate .` checks the marketplace root; also validate `plugins/crewmate`.

**Checked and correct:**
- `codex exec resume` accepts `--json`, `-o`, `--skip-git-repo-check` and `-c`, and has no `-s`.
- The agy flags match `agy --help`, and `agy --version` exits 0.
- Fixture ids, `usage` values and `init.permission_mode` placement match the Task 5 tests.
- The slug expectation `my-repo--` is right.
