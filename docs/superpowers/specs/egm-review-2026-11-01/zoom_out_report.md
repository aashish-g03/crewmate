The design passes the Zoom-Out Standard, with four Major and three Nit findings to fix. It is not blocked.

**What already passes**
- **Context:** sections 1 and 2 state the objective and motivation clearly.
- **Root problem:** each of v0.2's three observed failures is fixed at its cause:
  - No progress: the subagent is removed, so output goes to Bash in the main conversation, plus `watch` under Monitor.
  - Stalled tasks: the mailbox and `crewmate up` are removed.
  - Seven-step install: zero-dependency Node in a plugin marketplace.
- **YAGNI calls that are right:** dropping MCP, the subagent, hooks, worktrees and the broker. Rejecting the mailbox as an optional mode (alternative 7) is well argued.
- **Not weeds:** the one-writer lock is cheap, concrete and tied to a named risk. The agy flag details in 4.4 are a verified integration surface.

---

**Finding 1**
- **Severity:** Major
- **Affected Scope:** 4.4 Codex adapter; 4.5 Cancel; section 6, risk row 1; 4.11 (fake `codex app-server`)
- **Simplicity Rationale:** The Codex adapter has two code paths from day one: `app-server` (JSON-RPC, marked experimental) plus a `codex exec --json` fallback, chosen at start-up by reading `codex --help`.
  - The design's reason for `app-server` is that `codex-plugin-cc` uses it. But in `codex-plugin-cc`, `app-server` also backs the broker (`scripts/app-server-broker.mjs`, `broker-lifecycle.mjs`), the Stop-hook gate and session transfer. Section 2 drops all three as non-goals.
  - `codex-cli 0.166.0` on this machine has everything the job model needs: `exec --json` ("Print events to stdout as JSONL"), `exec resume <id>`, `-m`, `-s <sandbox>` and `-c` for effort.
  - Using `exec --json` alone makes Codex the same shape as agy: one process per job, NDJSON parsing, cancel by SIGTERM to the process group. That removes:
    - the JSON-RPC client and `turn/interrupt`
    - the version check
    - risk row 1
    - one of the two fake-CLI fixtures
  - One check is still needed. v0.2's `acp-shim.ts` runs `codex exec` but reads its output as plain text, so the codebase does not prove `exec --json` emits per-tool events and a thread id. Record one real run to confirm.
  - If it does, ship `exec` only and add `app-server` later as its own adapter if needed. If it does not, the design should name that gap as the reason for `app-server` and drop the fallback, not keep both.

**Finding 2**
- **Severity:** Major
- **Affected Scope:** 4.1 diagram ("plugin bin/, on PATH"); 4.2 last two bullets; 4.6
- **Simplicity Rationale:** Every command and the skill call bare `crewmate …`, which relies on "Claude Code adds plugin `bin/` executables to the Bash tool's PATH".
  - The design states this without a source, and calls the layout "the same as `codex-plugin-cc`".
  - That plugin does not rely on it. Every one of its commands calls `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" …`, and it has no `bin/`.
  - None of the plugins installed under `~/.claude/plugins` has a `bin/` directory either.
  - Either cite where Claude Code documents bin-on-PATH, or use the proven `${CLAUDE_PLUGIN_ROOT}` form. `bin/crewmate` can stay for the npm / outside-Claude-Code case in Goal 7.
  - This assumption is load-bearing for Goal 1 and every flow, so it belongs in the risks table if kept.

**Finding 3**
- **Severity:** Major
- **Affected Scope:** 4.5 (whole section); section 9, first bullet ("Internal module layout under `lib/`" left to the builder); 4.7 `--diff`
- **Simplicity Rationale:** 4.5 restates code that already exists, under Apache-2.0, in `codex-plugin-cc`'s `scripts/lib/`:
  - `state.mjs`: state dir keyed on slug plus sha256 of the real path, `CLAUDE_PLUGIN_DATA` with a fallback, `MAX_JOBS = 50`
  - `job-control.mjs` and `tracked-jobs.mjs`: detached `spawn` with `unref`, pid tracking
  - `process.mjs`, `workspace.mjs`, `args.mjs`, `render.mjs`
  - `git.mjs`: working-tree and base-ref diff scoping, which is what `critique --diff` needs
  - Whether to copy these modules or rewrite them is the main reuse decision of the design, and section 9 hands it to the builder.
  - State it in the design: `lib/` starts from these modules, with NOTICE attribution, minus the Codex- and broker-specific parts. Then 4.5 can shrink to the parts crewmate adds: the events file and its format, the stale-runner rule, the writer lock, and the fallback location.

**Finding 4**
- **Severity:** Major
- **Affected Scope:** 4.1 diagram ("foreground: runs the job in-process" vs "--background: spawns a detached runner"); 4.3 `ask`; 4.6 foreground/background choice
- **Simplicity Rationale:** There are two ways to run a job: in-process with direct streaming, and a detached `_run` writing to `events.ndjson`. That means two lifecycles to get right for timeout, cancel and the final state, and two sets of failure-mode tests.
  - Simpler: foreground is defined as "start the detached runner, then run `watch` on it inline, and exit with the job's exit code".
  - That leaves one runner, one event writer and one state model. Foreground jobs also get Goal 3 (survive the session ending; result readable later) for free.
  - The only cost is a job folder per foreground call, which the retention rule already caps.
  - It also makes the "foreground or background" wording in 4.6 and section 9 matter much less.

**Finding 5**
- **Severity:** Nit (Major if EGM integration is a real goal)
- **Affected Scope:** 4.7, second and third paragraphs
- **Simplicity Rationale:** The design writes its own critique template (objective in the reviewer's words, unstated assumptions, missing failure modes, contradictions with code, builder blockers) while saying it can be used together with EGM.
  - EGM already ships review personas (`comprehension.md`, `design_critic.md`, `implementation_readiness.md`, `zoom_out.md`) and standards (`feature-spec-standard.md`, `implementation-readiness-standard.md`, and others) covering the same content.
  - A second, hand-written template is where the two will drift apart.
  - Either reuse EGM's comprehension and design-critic prompts as the critique template (or as an option), or say why crewmate needs a different one.
  - A related point: `critique` is "N × `ask --background --prompt-file`" over ready vendors. Keeping it in the CLI is justified only by Goal 7; otherwise it could be a command prompt plus a template file.

**Finding 6**
- **Severity:** Nit
- **Affected Scope:** 4.5 "Event format", the rendered-line examples (`gemini ▶ read …`, `✗ denied`, `■ done in 41s (6.9k in / 0.2k out)`)
- **Simplicity Rationale:** This drops below design level, and it contradicts section 9, which leaves "event line wording" to the builder. Keep the event `type` list and fields, which is the interface; drop or soften the glyph and wording examples.

**Finding 7**
- **Severity:** Nit
- **Affected Scope:** 4.10, last bullet ("`crewmate setup` detects the old subagent file and MCP entry and prints the removal commands")
- **Simplicity Rationale:** This is migration code for a version that, by the README ("From npm (once published)") and the CHANGELOG ("0.2.0 … pending merge"), was never published. Its user base is likely just Aashish. The README removal note the design already plans is enough; drop the detection from `setup`.

**Also noted (Nit)**
- The header's "Replaces" line points to `docs/superpowers/2026-05-04-acp-transport.md`. The file is at `docs/superpowers/plans/2026-05-04-acp-transport.md`.
- Goal 2 says "the user and Claude see" progress in foreground mode. Claude only reads Bash output when the command finishes, so live visibility for Claude depends on the background + Monitor path. Finding 4 makes this the single path.
- Flow B and 4.6 depend on Claude Code's Monitor tool. Neither section 6 nor section 9 says what happens where Monitor is unavailable; polling `status` or `result` is the obvious fallback and could be stated in one line.

No files were modified.
