## Design Critic Review (Mode: REVIEW)

**Target:** `/Users/aashish/Codebase/GitHub/crewmate-plugin-v1/docs/superpowers/specs/2026-11-01-crewmate-plugin-design.md` (full file)
**Standard:** feature-spec-standard.md

### What passes the standard

- **Alternatives Rule: met.** Section 7 rejects seven alternatives, each with a specific reason.
- **Required sections are present:** Problem (s.1), Goals / Non-goals / Anti-goals (s.2), Proposed Architecture (s.4), Risks and limits (s.6), Security (s.5).
- **Verified against the real CLIs:**
  - `agy --help` (1.4.12) lists `--output-format stream-json`, `--print-timeout`, `--conversation`, `--settings` and `--dangerously-skip-permissions`.
  - `--print-timeout` defaults to `0s`, so crewmate does need to set it to fix issue 2.
  - `codex --help` (0.166.0) lists `app-server` as `[experimental]`.

The gaps are the load-bearing ones below.

---

### Findings

**1. Severity: Major**
**Affected Scope:** s.4.5, line 132 (state directory), against s.4.6 line 146 ("No hooks in v1") and Goal 7 (line 34).
**Finding & Recommendation:**
- The state root depends on `CLAUDE_PLUGIN_DATA` being in the environment when `crewmate` runs. Claude Code only fills `${CLAUDE_PLUGIN_DATA}` in as a text substitution in plugin files. The Claude Code binary contains the string "`${CLAUDE_PLUGIN_DATA}` is plugin-only".
- `codex-plugin-cc` gets the variable into the Bash tool's environment through its own SessionStart hook: `session-lifecycle-hook.mjs:80` runs `appendEnvVar(PLUGIN_DATA_ENV, …)` into `CLAUDE_ENV_FILE`.
- In this very shell, `CLAUDE_PLUGIN_DATA=/Users/aashish/.claude/plugins/data/codex-openai-codex`. That is the Codex plugin's folder, leaked in by its hook.
- With no hook, crewmate's state root would vary from call to call:
  - If the Codex plugin is installed, a plain `crewmate …` run by the skill writes into **another plugin's data folder**.
  - If it is not installed, the same call writes to `~/.crewmate`.
  - A slash command that substitutes the variable in its text writes to crewmate's own folder.
- `status`, `result` and `--resume` would then disagree about where jobs live. Jobs started by Codex, agy or a shell (Goal 7) can never be seen from Claude Code, and the reverse.
- **Recommendation:** use one fixed root everywhere (for example `~/.crewmate/workspaces/…`) and never read `CLAUDE_PLUGIN_DATA` from the environment. Or add a SessionStart hook and remove "No hooks". Either way, say which one in the spec.

**2. Severity: Major**
**Affected Scope:** s.4.2 lines 93–94 (layout "same as codex-plugin-cc"; `bin/` on PATH); Goal 1.
**Finding & Recommendation:**
- `codex-plugin-cc` has no `bin/` folder. Every command, skill and hook calls `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"`. So the claim "same layout" is false on exactly the point the install promise depends on.
- Claude Code 2.1.316 does support plugin `bin/` folders on PATH. But the binary also has failure branches for it:
  - "leaving plugin bin/ dirs off PATH"
  - "Dropping plugin bin path that holds the PATH delimiter / shell metacharacters"
  - "asset cache and plugin bin/ are on different volumes"
- The spec gives no minimum Claude Code version and no fallback.
- **Recommendation:** state the minimum Claude Code version. Have the commands and skill fall back to `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate"`. Have `setup` report whether `crewmate` is on PATH.

**3. Severity: Major**
**Affected Scope:** Goals 2–3 (lines 29–30), Flow B (line 60), s.4.3 `watch` (line 104), s.4.6 line 143; s.6 has no row for this.
**Finding & Recommendation:** The live-progress design depends on Claude Code's Monitor tool but never checks the design against Monitor's limits:
- **Expiry before the job ends.** Monitor defaults to 5 minutes and caps at 30. The job timeout defaults to 10 minutes (line 102). With defaults, the watch expires before the job's deadline, so "Claude is told when the job finishes" is false unless Claude re-arms it.
- **Auto-stop on volume.** Monitors that emit too many lines are stopped automatically. Flow B's own example (read all of `src/`) gives one `tool` event per file, which is likely to hit that limit. After that the user sees nothing, which is exactly v0.2 failure 1.
- **Context cost.** Each line becomes a conversation message in Claude's context. The spec never estimates this token cost.
- **Availability.** Whether Monitor is available to every user (and not feature-gated) is not verified. That matters for "simple enough for other people".

**Recommendation:**
- `watch` should merge and rate-limit events (for example collapse runs of reads, at most N lines per interval).
- The "job finished" signal should use a background Bash call (`run_in_background`) on `crewmate watch --quiet <id>`, which exits when the job ends. Keep Monitor for live lines only.
- Add a risk row covering expiry, auto-stop and token cost.

**4. Severity: Major**
**Affected Scope:** Flow A (line 57), s.4.3 `--timeout` default 10m (line 102), s.4.6 line 143.
**Finding & Recommendation:**
- In the foreground, `ask` runs inside a Bash tool call. That call times out at 120 s by default and 600 s at most. The job's default deadline is 10 minutes.
- So any foreground job over 2 minutes is killed (or pushed to the background) by Claude Code before crewmate's own timeout applies. That breaks the "honest outcomes" goal, and the job folder may be left half-written.
- The "request is clearly long" test (line 143) has no numeric boundary.
- **Recommendation:** cap foreground runs below the Bash limit, or pass an explicit Bash `timeout`, or make background the default and allow foreground only for short questions. Define "long" concretely.

**5. Severity: Major**
**Affected Scope:** s.4.5 line 138 (one-writer lock); s.6 row "Two jobs editing the same files"; Goal 3 ("Claude keeps working").
**Finding & Recommendation:**
- The lock only stops two crewmate writers from overlapping. The likeliest collision is Claude itself editing the same tree while a background `--write` job runs, and there are no worktrees by decision. The risk row's mitigation does not cover that case.
- It is also unspecified how the lock is released when a `--write` runner dies, since staleness is detected only through `status`.
- **Recommendation:** either make `--write` foreground-only, or have the skill forbid Claude from editing files while a `--write` job is running. Define stale-lock recovery (pid check, plus a start-time check so a reused pid is not mistaken for the runner).

**6. Severity: Major**
**Affected Scope:** Goal 4 (line 31), anti-goal line 48, s.4.4 Codex adapter (line 116), event phase `denied` (line 134).
**Finding & Recommendation:**
- For agy, the spec defines the denial signal precisely (`state: ERROR`, "permission check failed"). For Codex it defines none.
- The reference implementation (`codex.mjs:67-68`) runs `approvalPolicy: "never"` with the `read-only` sandbox. Codex then sends no approval request at all: a blocked write or command shows up as a failed command item.
- Without a defined mapping, Codex denials will show as ordinary tool errors or vanish into a "done", which is the outcome anti-goal 2 forbids.
- **Recommendation:**
  - Name the approval policy.
  - Say how a sandbox denial is recognised in `item/completed` (exit status or error text).
  - Add a recorded Codex denied-tool fixture next to the agy one in s.4.11.

**7. Severity: Major**
**Affected Scope:** Goal 6 (line 33), s.4.4 line 116 (thread id stored for `--resume`), s.4.5.
**Finding & Recommendation:**
- `codex-plugin-cc` creates threads with `ephemeral: true` by default (`codex.mjs:70`). It sets `ephemeral: false` only on a path that keeps the thread (`persistThread`, lines 1109/1117). The spec stores the thread id but never says the thread is persisted.
- If threads are ephemeral, `thread/resume` may fail. If every job is persisted, the user's own Codex session history fills up with crewmate jobs.
- "The last conversation with that vendor in this workspace" is ambiguous after a parallel `critique`, or while another job for that vendor is still running.
- **Recommendation:** check `thread/resume` against an ephemeral thread. Decide whether a thread is kept by default or only on request. Define "last": exclude critique jobs, refuse while a job for that vendor is still running, or allow `--resume <id>`.

**8. Severity: Major**
**Affected Scope:** s.4.8 (line 158), every `ask` and `critique` call.
**Finding & Recommendation:**
- Codex has a model-free sign-in check: `codex login status` printed "Logged in using ChatGPT".
- `agy --help` lists no login or status subcommand. The agy "cheap read-only probe" is therefore a model call.
- Since `ask` checks readiness before every job, and `critique` checks every vendor, each call pays an extra model turn plus its latency, on the user's quota.
- **Recommendation:**
  - Name the Codex probe (`codex login status`).
  - For agy, cache readiness per session or time window, or skip the pre-check and detect a signed-out agy from the job's own first events with a short initial deadline.
  - Record the cost in s.6.

**9. Severity: Major**
**Affected Scope:** s.4.11 (lines 177–190).
**Finding & Recommendation:**
- None of the nine failure modes covers the main observed failure the spec exists to fix (no progress reaches the user). Missing cases include:
  - `watch` replays events already written, then exits on `end`.
  - `watch` on a dead runner exits instead of hanging.
  - `watch` with several ids exits only when every job is final.
  - A line actually arrives in a real Claude Code conversation through the plugin command or skill path.
- The release artifact is a vendor event log, which proves nothing about what the user saw.
- Under the user's stated testing rule ("run the real flow… leave a verifiable artifact"), this is a gap.
- **Recommendation:** add `watch` failure-mode tests. Add one scripted end-to-end run in a scratch Claude Code session per release, with the transcript or screenshot kept as the artifact.

**10. Severity: Major**
**Affected Scope:** s.5 line 194 ("Default is read-only for both vendors"); s.4.4 agy, line 126.
**Finding & Recommendation:**
- For agy, "read-only" is not enforced. It relies on headless mode denying anything that would need a prompt. If the user's own agy `settings.json` already allows edits or shell, or sets an auto mode, a default crewmate job could write.
- agy has explicit controls the spec ignores: `--mode plan|accept-edits|auto` and `--sandbox`.
- **Recommendation:**
  - Pass an explicit read-only setting on every default agy run (for example `--mode plan` and/or a deny-all `--settings` override), and verify it overrides the user's settings.
  - Consider `--mode accept-edits` for `--write` instead of a custom allow-list (s.9 item 3).

**11. Severity: Nit**
**Affected Scope:** Goal 1 (line 28) vs s.4.2 line 92 and s.6 row 3.
**Finding & Recommendation:** Goal 1 says the vendor CLI is "the only other prerequisite", but Node 20+ is also required. Agy-only users on Claude Code's native installer may not have Node. Reword the goal.

**12. Severity: Nit**
**Affected Scope:** Line 5.
**Finding & Recommendation:** The cited `docs/superpowers/2026-05-04-acp-transport.md` does not exist. The file is at `docs/superpowers/plans/2026-05-04-acp-transport.md`.

**13. Severity: Nit**
**Affected Scope:** s.4.5 lines 136–139 (staleness, cancel).
**Finding & Recommendation:** Staleness checks and SIGKILL-by-process-group work by pid alone. After a crash and a pid reuse, `cancel` could signal an unrelated process group. Store the process start time or a pidfile token and check it before signalling.

**14. Severity: Nit**
**Affected Scope:** s.4.5 line 137 (retention).
**Finding & Recommendation:** "Keep the newest 50" can delete the folder of a job that is still running, or finished but never read. Prune only jobs that are final and older than the newest 50.

**15. Severity: Nit**
**Affected Scope:** s.5 line 195 (prompt injection).
**Finding & Recommendation:** The text in `note` events is written by the vendor (and possibly by an injected file in the repo). It enters Claude's context live as Monitor notifications, not only through `result`. The "treat as data" rule in the skill should explicitly cover `watch` lines. Consider shortening or quoting `note` text.

**16. Severity: Nit**
**Affected Scope:** s.4.3 line 98.
**Finding & Recommendation:** Exit codes are not defined for `critique`, which returns at once, or for `watch` with several ids that end in mixed final states. Define them.

**17. Severity: Nit**
**Affected Scope:** s.7.
**Finding & Recommendation:**
- Two viable alternatives are missing:
  - **Fork `codex-plugin-cc` and add an agy adapter.** It already has job control, state, rendering and the app-server client. Alternative 5 only rejects installing the projects side by side, not forking.
  - **Use Claude Code's background Bash for completion** instead of a custom detached runner plus Monitor.
- Each needs an explicit rejection reason to fully meet the Alternatives Rule.

**18. Severity: Nit**
**Affected Scope:** s.4.7 line 150 (goldfish condition).
**Finding & Recommendation:**
- The reviewer can read the whole repository, which may contain the author's reasoning (for example `docs/superpowers/plans/`). That weakens the "no access to the author's reasoning" claim.
- `--diff` against the working tree leaves out untracked files.
- State both limits.

---

**Unverified dependencies (not confirmed as fact):**
- The exact condition under which Claude Code leaves plugin `bin/` off PATH. Only the log strings were seen, not the logic.
- Whether the Monitor tool is available to every user.
