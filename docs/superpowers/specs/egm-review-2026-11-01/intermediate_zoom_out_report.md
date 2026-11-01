The earlier reviewers' fixes add up to a simpler design, not a heavier one, as long as they are settled together. Applied one by one, they would add about fifteen new mechanisms. Settled together, three structural choices cover most of them. The rest are cheap, one-line spec changes or editorial fixes.

## Verdict

The design still passes the Zoom-Out Standard. The choices that matter are right: no MCP server, no subagent, no mailbox, no hooks, no worktrees, a zero-dependency Node program behind thin Markdown commands. Neither recording argues for a different overall shape.

What would hurt is applying the reviewers' advice item by item. That adds:
- a fallback Codex transport and a version check;
- a second "completion" mode for `watch`, plus a rate limiter;
- a cap on foreground run time;
- a readiness cache;
- stale-lock recovery;
- a PATH fallback, a minimum Claude Code version and a PATH check in `setup`;
- a SessionStart hook;
- separate handling for how each vendor reports denials.

The three choices below make most of that unnecessary.

1. **Codex runs through `codex exec --json` only.** The recording `codex.ndjson` (codex-cli 0.166.0) answers the check that zoom_out finding 1 left open:
   - `thread.started` carries `thread_id`.
   - `item.started` and `item.completed` carry `command_execution` with `command`, `exit_code` and `status`.
   - `turn.completed` carries token usage.
   - The CLI help shows `exec resume <SESSION_ID>`, `-s read-only|workspace-write|danger-full-access`, `-m`, `-c` and `-o/--output-last-message <FILE>` (which writes `result.md` directly).
   - `--ephemeral` is opt-in, so sessions are kept by default.

   Codex then has the same shape as agy: one child process per job, NDJSON parsing, cancel by process group.
2. **Every job uses one runner.** Every job is a detached `_run` writing `events.ndjson`. "Foreground" just means running `watch` on that job inline and exiting with the job's exit code. Claude Code waits on a Monitor running `crewmate watch`. One runner, one writer, one state model.
3. **Each vendor's own permission controls replace custom allow-lists.**
   - Codex: `-s`.
   - agy: `--mode plan|accept-edits|auto`.
   - agy reports denials itself, in a structured field.

## Things no earlier reviewer saw

- **agy already reports its denials.** In `agy2.ndjson`, the final `result` event carries `"denied_actions":[{"action":"command","display_name":"RunCommand"}]`. The spec (4.4, line 125), comprehension finding 2 and design-critic finding 6 all assume crewmate must count `state: ERROR` steps and match the text "permission check failed". crewmate should read `denied_actions` instead, and use step events only for live lines.
- **agy can return an empty answer marked SUCCESS.** The same recording has `"response":""` with `"status":"SUCCESS"`. The spec does not cover an empty final answer. It should end as `failed` ("vendor returned no answer"), not `done`, and it needs its own failure-mode test.
- **agy reports its permission mode at start.** The `init` event includes `"permission_mode":"request-review"`. The runner can check this against the expected mode for the job and refuse to continue if it differs. That is a cheap way to enforce design-critic finding 10's read-only concern, instead of trusting the user's `settings.json`.
- **The Codex recording shows a permitted command, not a denial.** `ls -la` ran with `exit_code: 0` under `-s read-only`. So the Codex denied-tool fixture design-critic finding 6 asks for still has to be recorded. Under `exec` a denial will appear as a `command_execution` with a non-zero exit, not as an app-server approval event. Codex does not tell "denied" apart from "command failed", so crewmate should report those as tool errors and not invent a `denied` phase for Codex.
- **The baseline's skill and commands never rely on PATH.** `codex-plugin-cc`'s skill (`skills/codex-cli-runtime/SKILL.md:12`), its agent and all its commands call `node "${CLAUDE_PLUGIN_ROOT}/scripts/…"`, so the variable works in skill text too.

## Where the reviewers conflict, and how to settle it

| Conflict | Settle it by |
|---|---|
| zoom_out F1 (use `exec` only) against design-critic F6 and F7 (written for app-server: `approvalPolicy`, `item/completed`, ephemeral threads and `thread/resume`) | Use `exec`. F7 no longer applies, because `exec` keeps sessions by default and `exec resume <id>` takes the stored id. F6 shrinks to "record one Codex sandbox-failure fixture". |
| zoom_out F3 (reuse `codex-plugin-cc`'s `state.mjs`) against design-critic F1 (never read `CLAUDE_PLUGIN_DATA`) | Reuse the module but drop the environment read. Its `state.mjs:9` reads `CLAUDE_PLUGIN_DATA`, which is only correct there because its own SessionStart hook sets it (`session-lifecycle-hook.mjs:80`). In this shell the variable points at the Codex plugin's folder (`/Users/aashish/.claude/plugins/data/codex-openai-codex`), so the risk is real. Use a fixed `~/.crewmate/workspaces/<slug>-<hash>`. This also covers Goal 7 (jobs started from a shell, Codex or agy are visible from Claude Code). |
| zoom_out F2 (use `${CLAUDE_PLUGIN_ROOT}`) against design-critic F2 (keep `bin/` on PATH, add a fallback, a minimum version and a PATH check) | Make `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate"` the only form used inside Claude Code. The fallback, the minimum version and the `setup` PATH check then have nothing to do. Keep `bin/` only for `npx`. |
| zoom_out F4 (one runner) against design-critic F4 (cap foreground runs below Bash's 120 s / 600 s limit) and F5 (make `--write` foreground-only) | With one runner, Bash timing out ends only the `watch` call, never the job, so honest outcomes hold without a cap. "Clearly long" (critic_style F3, comprehension F13) stops mattering. "Foreground-only" for `--write` has no force once foreground is just a `watch`; the skill rule does the work. |
| design-critic F3 (Monitor for live lines plus a background Bash `watch --quiet` for completion) against zoom_out's note (poll `status` as a fallback) | Neither is needed. `watch` exits when the job ends, and Monitor reports that exit, so Monitor is already the completion signal. Two rules are enough: the Monitor timeout is at least the job timeout (Monitor's 30-minute cap covers the 10-minute default; re-arm above that), and `watch` merges runs of reads into one line. Where Monitor is unavailable, the same `watch` command runs as a background Bash call (one line in the skill). |
| design-critic F8 (cache readiness per session, or detect sign-out from the job) | Don't cache. Only `setup` probes sign-in. `ask` checks that the binary is on PATH (Codex can also use `codex login status`, which calls no model). Add one rule for every vendor: no vendor event within N seconds ends the job as `failed`, with the `setup` fix text. `--print-timeout` alone does not cover a signed-out agy hang: it limits the whole run, so the job would still wait out the full 10 minutes. |
| design-critic F17 (fork `codex-plugin-cc`; use background Bash instead of a detached runner) | Reject both, with one line each in section 7. A fork brings in about 3.5k lines of things section 2 rules out (broker, app-server client, session transfer, stop gate, the Codex-specific 1,219-line `codex.mjs`). Background Bash cannot meet Goal 3, because jobs must outlive the session. The baseline itself spawns its own detached worker for that reason (`codex-companion.mjs:671`). |

## Recommendations to reject or downgrade

- **design-critic F3's second completion mechanism (`watch --quiet`):** reject. Monitor's exit notification already signals completion.
- **design-critic F2's fallback, minimum version and PATH check:** reject once `${CLAUDE_PLUGIN_ROOT}` is the only form used inside Claude Code.
- **design-critic F7 (ephemeral threads):** no longer applies once Codex runs through `exec`.
- **design-critic F8's readiness cache:** reject. It adds state to save a probe that should not run on every `ask` anyway.
- **design-critic F4's foreground cap or explicit Bash timeout:** not needed once there is one runner.
- **design-critic F10's suggestion to use `--mode accept-edits` for `--write`:** accept, because it removes section 9 item 3 (the hand-written allow-list). Its suggestion to use `--mode plan` for read-only is unverified. Before the spec commits to it, the builder should check that `--mode plan` overrides a user `settings.json` that allows edits. Otherwise use the `init.permission_mode` check above.
- **critic_structural F2 and F3, and critic_style F1 (unlinked issues and projects, "Google's" EGM):** these are editorial, not architectural. They don't change the design.
- **critic_structural F6 (add likelihood and severity columns to the risks table):** downgrade to Nit or drop. For a tool used by one person, extra columns add no information.

## Findings

**Finding 1: settle the Codex transport as `exec --json` only**
- **Severity:** Major
- **Affected Scope:** 4.4 Codex adapter; 4.5 Cancel; section 6 risk row 1; 4.11 (the fake `codex app-server`)
- **Simplicity Rationale:**
  - The recording answers zoom_out F1's question in favour of `exec`.
  - Keeping app-server plus a fallback chosen at start-up means two transports, a JSON-RPC client, `turn/interrupt` and a version probe. None of the features that justify app-server in `codex-plugin-cc` (broker, stop gate, session transfer) are goals here.
  - Remove the app-server text, the fallback sentence and risk row 1, and cancel Codex by process group like agy.
  - With app-server gone, design-critic F7 is moot.

**Finding 2: one runner for every job**
- **Severity:** Major
- **Affected Scope:** 4.1 diagram; 4.3 `ask`; 4.6 first bullet; section 9 bullet 2; Flow A
- **Simplicity Rationale:**
  - Two run paths means two lifecycles for timeout, cancel and final state.
  - The in-process path is also the one Bash's 600-second limit can cut off, which breaks Goal 4 (design-critic F4).
  - Defining foreground as "detached runner plus inline `watch`" removes:
    - the foreground cap;
    - the numeric definition of "clearly long" (critic_style F3, comprehension F13);
    - the question of whether foreground Bash output is shown live (comprehension F4).
  - Jobs started in the foreground also survive the session ending.

**Finding 3: Monitor is the only notifier, with timeout alignment and line merging**
- **Severity:** Major
- **Affected Scope:** Goals 2–3; Flow B; 4.3 `watch`; 4.6; section 6 (missing row)
- **Simplicity Rationale:**
  - design-critic F3 is right about expiry and volume, but its fix stacks a second mechanism.
  - The minimal change has three parts:
    - The skill sets the Monitor timeout to at least the job timeout, and re-arms the Monitor above 30 minutes.
    - `watch` merges runs of the same tool kind into one line.
    - The skill names background Bash on the same command as the fallback where Monitor is unavailable.
  - Add one risk row that names Monitor's limits (expiry, automatic stop on volume, each line costing context).
  - Whether Monitor is available to every user is unverified. The builder should check this, but the fallback above makes it non-blocking.

**Finding 4: use a fixed state root and drop the `CLAUDE_PLUGIN_DATA` read**
- **Severity:** Major
- **Affected Scope:** 4.5 State directory
- **Simplicity Rationale:**
  - This is confirmed in this environment: the variable belongs to another plugin.
  - A fixed `~/.crewmate` root is simpler than adding a SessionStart hook, which would contradict "No hooks in v1".
  - It is also the only choice that serves Goal 7 (jobs started from a shell, Codex or agy are visible from Claude Code).

**Finding 5: use `${CLAUDE_PLUGIN_ROOT}` as the only invocation form inside Claude Code**
- **Severity:** Major
- **Affected Scope:** 4.1 diagram; 4.2 last two bullets; 4.6
- **Simplicity Rationale:**
  - This is the baseline's proven pattern for commands, the agent and the skill.
  - It removes the dependence on Claude Code putting plugin `bin/` folders on PATH, and with it every mitigation design-critic F2 proposes.
  - Fix the false "same layout as codex-plugin-cc" claim: the baseline has no `bin/` folder.

**Finding 6: name the reused baseline modules**
- **Severity:** Major
- **Affected Scope:** 4.5; section 9 bullet 1; section 7
- **Simplicity Rationale:**
  - This is zoom_out F3, kept but bounded.
  - Copy these modules from `codex-plugin-cc`'s `scripts/lib/` with NOTICE attribution, roughly 1.8k lines:
    - `state` (without the environment read);
    - `job-control`;
    - `tracked-jobs`;
    - `process` (its `terminateProcessTree` already kills by process group);
    - `args`;
    - `render`;
    - `git` (for `critique --diff`);
    - `fs`.
  - Section 4.5 then shrinks to what crewmate adds: `events.ndjson`, the staleness rule and the writer rule.
  - Add the fork rejection from design-critic F17 to section 7.

**Finding 7: denial and empty-answer rules taken from the recordings**
- **Severity:** Major
- **Affected Scope:** Goal 4; anti-goal at line 48; 4.4 agy (line 125); 4.11 failure mode 2
- **Simplicity Rationale:**
  - Read agy's `result.denied_actions` rather than parsing step error text.
  - Record Codex sandbox failures as tool errors (they come as a `command_execution` with a non-zero exit). Record one Codex fixture.
  - State the rule outright: a job with denied tools still ends `done` with exit code 0, and the denied list appears in the outcome block, in `--json` and in the end line of `watch`. Reword the anti-goal to "reports success without listing denials".
  - An empty final answer ends `failed`.
  - This also settles comprehension F2 without adding a fifth state.

**Finding 8: map the permission ladder onto each vendor's own controls**
- **Severity:** Major
- **Affected Scope:** 4.4 agy bullet on `--write`; section 5 first bullet; section 9 bullet 3
- **Simplicity Rationale:**
  - Codex `-s read-only|workspace-write|danger-full-access` and agy `--mode` already cover read-only, write and everything.
  - A hand-written `--settings` allow-list is a crewmate invention to maintain. Enforce read-only on agy by checking `init.permission_mode`.
  - YAGNI check: `--allow-shell` is a fourth step that exists for one vendor only. Unless there is a known use, cut v1 to three steps for both vendors (default, `--write`, `--yolo`).

**Finding 9: no readiness probe on every `ask`**
- **Severity:** Major
- **Affected Scope:** 4.8; 4.11 failure mode 6
- **Simplicity Rationale:**
  - The agy probe calls a model, so running it on every `ask` costs quota and latency.
  - Use a first-event deadline that applies to every vendor; it also covers issue 2's hang.
  - Run the sign-in probe in `setup` only, and use the model-free `codex login status` for Codex. Do not cache readiness.

**Finding 10: the writer rule reuses the staleness rule**
- **Severity:** Nit
- **Affected Scope:** 4.5 "One writer at a time"; section 6 row 5
- **Simplicity Rationale:**
  - Drop the separate lock file. "Writer busy" means a job record in this workspace with `--write`, state running and a live pid. Stale writers then clear through the existing runner-died rule, and design-critic F5's stale-lock recovery has nothing left to do.
  - The collision that actually happens is Claude editing the same tree while a `--write` job runs. That is a skill rule ("do not edit while `status` shows a running `--write` job"), not a code mechanism.
  - Pid reuse (design-critic F13): the baseline has no guard either. Before signalling, a one-line check that the process command line contains `_run <id>` is enough.
  - Retention (design-critic F14): prune only finished jobs. This changes one word.

**Finding 11: the remaining `--resume` question**
- **Severity:** Nit
- **Affected Scope:** Goal 6; 4.3
- **Simplicity Rationale:** With `exec`, only design-critic F7's "which job is last" question remains. Define last as the most recent `ask` job for that vendor in this workspace, excluding critique jobs, and accept `--resume <job-id>`.

**Finding 12: keep the test additions small**
- **Severity:** Nit
- **Affected Scope:** 4.11
- **Simplicity Rationale:**
  - Because `watch` becomes the only consumer, add only its three failure modes:
    - replay already-written events, then exit on `end`;
    - exit (not hang) on a dead runner;
    - exit only when every one of several ids is final.
  - Add the empty-answer case from finding 7.
  - Fold design-critic F9's "real Claude Code session" artifact into the existing local-marketplace install check instead of a second release step.

**Finding 13: editorial fixes, one combined pass**
- **Severity:** Nit (several reviewers marked these Major)
- **Affected Scope:** Line 5; Goal 5; lines 9, 17, 63, 150; sections 4.3 and 4.8
- **Simplicity Rationale:** These are reference and definition fixes, not design changes:
  - the wrong path on line 5 (flagged by three reports; the file is in `docs/superpowers/plans/`);
  - define goldfish, elephant, EGM and Monitor where they first appear;
  - link the external projects and the two issues;
  - list `--allow-shell` (if kept), `--yolo` and `--diff` in the 4.3 table, with exit codes for "writer busy" and for commands that return a job id at once;
  - put seconds on the probe and first-event deadline values;
  - drop the glyph examples from 4.5 (section 9 already leaves that wording to the builder);
  - drop the old-install detection from `setup` (zoom_out F7).

## The minimal set of changes that resolves the Majors

1. Codex runs only through `exec --json`.
2. One detached runner. Foreground means an inline `watch`.
3. Monitor on `watch` is the only notifier. Its timeout is at least the job timeout, `watch` merges runs of reads, and background Bash is the fallback.
4. Fixed state root at `~/.crewmate`.
5. `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate"` everywhere inside Claude Code.
6. Copy the named baseline modules with NOTICE attribution.
7. Use agy's `denied_actions`, treat an empty answer as `failed`, and state the `done`-with-denials rule. Record one Codex sandbox-failure fixture.
8. Use the vendors' own permission controls, with a check of agy's `init.permission_mode`. Decide whether `--allow-shell` stays.
9. A first-event deadline instead of a sign-in probe on every `ask`.

Taken together, these delete more of the spec than they add. App-server, the version check, risk row 1, the custom agy allow-list, the separate lock and the foreground/background rule all go. The new rules (first-event deadline, `permission_mode` check, timeout alignment, line merging) are each one line. The builder should verify two things before the spec relies on them: that `--mode plan` overrides a user's agy settings, and that Monitor is available to every user.

I reviewed the spec and the five earlier reports, and checked them against the two recordings, `codex exec --help`, `agy --help` and the baseline at `/Users/aashish/.claude/jobs/b7f8910c/tmp/cpc/plugins/codex`. No files were modified.
