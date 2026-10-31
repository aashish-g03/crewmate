**Implementation Readiness re-audit (Stage 9, revision 2): `2026-11-01-crewmate-plugin-v1.md`, lines 114–717**

Six Majors remain. Four of them are new in revision 2 or were missed in round 1.

## Blockers
None.

## Majors

**1. Severity: Major**
**Scope:** Task 5, codex and gemini parser rules; Step 1 test for `codex-denied.ndjson`
**Finding & Guidance:** The codex parser gives `turn.started` no `feed()` rule. It appears only under `isModelEvent`. The catch-all rule ("JSON of an unknown type becomes a `note`") therefore turns it into a note. `codex-denied.ndjson` holds `thread.started`, `turn.started`, two `agent_message` items and `turn.completed`. That yields 3 notes, so the assertion "exactly two notes" fails as written. The agy side has the same gap: the `user_input` `step_update` in every recording has no rule, so every gemini job may emit a junk note. Round 1 missed this. Add "→ no event" bullets for codex `turn.started` and gemini `step_type === 'user_input'`.

**2. Severity: Major (new)**
**Scope:** Task 6, test T5b
**Finding & Guidance:** The test cannot catch what it claims to test.
- `agy-user-input-only.ndjson` starts with the `fixture_note` marker line, then `init`, then `user_input`.
- The fake replays every line, marker included, so `FAKE_HANG_AFTER=2` prints only the marker and `init`.
- The `user_input` step is never printed, so the test passes even if `user_input` counts as a model event.
- Use `FAKE_HANG_AFTER=3`.

**3. Severity: Major (new)**
**Scope:** Task 10, "Commands, general" (line 635) against Task 7 `critique`
**Finding & Guidance:** Revision 2 says the user's free text for `ask` and `critique` goes in on stdin through a heredoc. But `critique` takes `<path>…` or `--diff[=<ref>]` and reads no stdin. Revision 1 passed `$ARGUMENTS`. Following Task 10 as written produces a `/crewmate:critique` that sends no paths. The behaviour for "no paths and no `--diff`" is also undefined. State that `critique.md` passes paths and flags as arguments, and give the exit code for an empty target (presumably 2).

**4. Severity: Major (round-1 IR #9 only partly resolved)**
**Scope:** Global Constraints, `critique --diff` limit of 200,000 bytes; Task 7 `critique`; Task 6 runner step 2
**Finding & Guidance:**
- **Limit too high for Linux:** the prompt (template plus diff) is one argv string. On Linux a single argument may be at most 131,072 bytes (`MAX_ARG_STRLEN`), so a 150 KB diff makes `spawn` fail with `E2BIG`. Linux is in scope.
- **Untracked files not counted:** `diffBytes` measures only the staged and unstaged diff, but `ctx.content` with `includeDiff: true` also inlines untracked file bodies (up to 24 KB each).
- **Large diffs crash first:** with `includeDiff: true`, `collectWorkingTreeContext` runs `gitChecked` with the default 1 MB `maxBuffer`. A diff over 1 MB throws `ENOBUFS` before the size check runs, so the command crashes instead of exiting 2.
- **Spawn failure unhandled:** runner step 2 has no rule for a spawn `error` event (`E2BIG`, `ENOENT`). The same applies to large `ask --prompt-file` input, which has no cap.

Lower the cap below 128 KB, measured on the final prompt. Call `collectReviewContext` without forcing `includeDiff` first, or catch `ENOBUFS` and exit 2. A spawn error should end the job `failed`. Alternatively, pass the prompt on stdin (codex accepts `-` for stdin).

**5. Severity: Major (new)**
**Scope:** Task 6 `acquireWriter` rule 2 combined with Task 7 `pruneJobs`
**Finding & Guidance:** The new rule treats a missing holder record as alive. Consider this sequence:
1. A write job's runner dies, for example at reboot, and leaves `writer.lock` behind.
2. Later `pruneJobs` calls (more than 50 newer finished jobs) delete that job's folder.
3. Every later `--write`/`--yolo` now exits 6 forever, naming a job that does not exist.

No command clears the lock. Either `pruneJobs` must skip the job named in `writer.lock`, or a missing record should count as dead once the lock's mtime is older than the spawn grace.

**6. Severity: Major**
**Scope:** Task 7 `ask` check 3 and Task 9 `INSTALL_TEXT`
**Finding & Guidance:** At Task 7, `ask` needs "the install text from Task 9", but that text lives in `setup.mjs`, which does not exist yet. `setup.mjs` also imports `findOnPath` from `ask.mjs`, which would make a cycle. Name a shared home for both `INSTALL_TEXT` and `findOnPath`, created in Task 7 (for example `lib/vendors/index.mjs`).

## Nits (new)
- **Spec deviation not marked:** `isModelEvent` now excludes `turn.started` and `user_input`, which contradicts spec §4.4 line 186 ("any agy `step_update` … any Codex `turn.*`"). Mark it as a plan ruling, as the Windows ruling is.
- **Fake CLI wording:** "Replay: *otherwise*" reads as if `FAKE_ARGV_LOG` turns replay off, which would break T10. Write "then".
- **`--since` unusable from Claude:** `watch` lines do not print `n`, so `ask.md` cannot re-arm with `--since=<last n>`.
- **Review Focus 5 timing:** the test sets no `FAKE_DELAY_MS`; set 300 ms, as T9 does.
- **`tsconfig.json`:** appears under both Delete and Create.
- **`critique --diff` outside git:** detection is unspecified (`resolveWorkspace` falls back silently).

## Round-1 findings
**Implementation Readiness report:**
- #1 tag: RESOLVED (`v0.2-final`; `7006e7a` exists; `v0.2.0` is left alone).
- #2 optional-value flags: RESOLVED (`--flag=value` is taken out before `parseArgs`).
- #3 lost update and false "runner died": RESOLVED (the runner owns `job.json`; spawn grace added).
- #4 lock races: RESOLVED (missing holder counts as alive; re-read after create; takeover race explicitly accepted). This creates new Major 5.
- #5 `releaseWriter` and vendor leak: RESOLVED (runner step 9; `vendorProcess` plus `cancel` cleanup).
- #6 fakes: RESOLVED (`--version`, `login status`, `FAKE_ANSWER=done`).
- #7 agy timeout: RESOLVED (`--print-timeout` is the job deadline plus 30 s).
- #8 duration format: RESOLVED.
- #9 `critique`: PARTLY RESOLVED (field, scope, `ensureAbsolutePath` and cap are now given, but the cap value and the `ENOBUFS` path are wrong; see Major 4).
- #10 usage: RESOLVED.
- #11 leftover files: RESOLVED (all tracked files checked).
- #12 `--json` shapes: RESOLVED.

**Codebase Details report:**
- #1, #2, #3, #5, #6, #8, #9, #10, #11: RESOLVED. For #9, the real `codex` and `agy` live in the nvm folder and `~/.local/bin`, so `fakePath` with `:/usr/bin:/bin` cannot find them.
- #4: RESOLVED (agy prompt is at index 1).
- #7: RESOLVED in the rule, but its test is vacuous (Major 2).

**Style report:** #1–#5 RESOLVED (naming block, the `fixture_note` key, observable detach rules, `CREWMATE_PROBE_MS`, the §4.4 citation, which matches spec line 174).

**Verified correct:**
- `includeDiff: true` forces the diff inline.
- `ctx.summary` and `ctx.content` exist.
- agy `--print-timeout`, `--mode` and `models` exist.
- `codex exec resume` accepts `-c`.
- All five recorded `init` lines have `permission_mode` `request-review`.
- The agy2 result has status `SUCCESS`, `response` `""` and `denied_actions` with `RunCommand`.

**Verdict: NOT READY.** Six Majors remain: a test value that fails as written, a test that cannot catch its target, a broken `/crewmate:critique` wiring, the wrong diff cap and size handling, a permanent writer-lock deadlock, and a cross-task dependency. Each fix is a few sentences.
