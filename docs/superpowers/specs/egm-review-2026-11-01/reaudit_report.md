## Re-audit: crewmate v1 design, revision 2

**Mode:** REVIEW. **Target:** `/Users/aashish/Codebase/GitHub/crewmate-plugin-v1/docs/superpowers/specs/2026-11-01-crewmate-plugin-design.md`
**Result:** 0 Blockers, 5 Majors (2 action items NOT RESOLVED, 1 partly resolved, 2 new), 6 Nits.

### Majors

**1. Severity: Major (item 8 NOT RESOLVED for `--resume`)**
Affected scope: lines 64, 157, 166, 169, 267.
Finding: `codex exec resume --help` (local codex-cli) has no `-s/--sandbox` option. It does have `-c`, `--json`, `-o` and `--dangerously-bypass-approvals-and-sandbox`. Lines 166 and 169 resume with `codex exec resume <thread_id> <prompt>` and set permission steps with `-s`. On that command form `-s` is rejected, so a resumed job's sandbox comes from the user's `config.toml`. That breaks the "read-only by default" anti-goal on the resume path.
Recommendation: set the permission step for resume with `-c sandbox_mode="read-only"` / `"workspace-write"` (`-c` works on both subcommands), and add a failure-mode test that a resumed Codex job is still read-only.

**2. Severity: Major (item 6 NOT RESOLVED: the modules are named, but the description is wrong)**
Affected scope: lines 123–130, 188–194.
Finding: these points come from reading `/Users/aashish/.claude/jobs/b7f8910c/tmp/cpc/plugins/codex/scripts`:
- The detached spawn (`spawnDetachedTaskWorker`) is in `codex-companion.mjs`, which is not copied. `job-control` and `tracked-jobs` do not spawn anything, despite line 125.
- `job-control.mjs` imports `getSessionRuntimeStatus` from `codex.mjs`, the file line 130 excludes.
- `state.mjs` imports `workspace.mjs`, which is not listed.
- `state.mjs` keeps a shared `state.json` index that is missing from the 4.5 layout. It writes the index with an unlocked, non-atomic read-modify-write.
- `pruneJobs` sorts by `updatedAt` and keeps 50 regardless of state, which contradicts "running jobs are never pruned" (line 194).
- `tracked-jobs` records `pid` only, with no start time (lines 189 and 193 need one).

A builder following 4.2 will find this is a rewrite, not a copy.
Recommendation: list each module's required changes (cut the `codex.mjs` import, add `workspace`, drop or lock `state.json`, prune only finished jobs, record start time). Also say the spawn is new code.

**3. Severity: Major (new contradiction in 4.11 tests, item 7)**
Affected scope: lines 177, 245, 248–249.
Finding: the only recorded `denied_actions` run is `agy2.ndjson`, and it has `"response":""`. Test 3 makes that run `failed`, but test 2 needs "SUCCESS with denied_actions → done, exit 0". The two tests disagree on the one real recording, and test 2 has no fixture behind it.
Recommendation: record a denial run that still returns an answer, or mark test 2 as a synthetic fixture. State that agy2 is the fixture for test 3.

**4. Severity: Major (item 10 partly resolved)**
Affected scope: line 195.
Finding: only `ask --write` is refused. An `ask --yolo` job can start while a write job is running, so a write collision is still possible. The lock check also races, because it reads and then spawns against the unlocked `state.json` (Nit on its own, since this is a single-user local tool).
Recommendation: refuse any `--write` or `--yolo` job while a writer runs, and take the writer slot with an atomic create such as `fs.openSync(..., 'wx')` on a lock file.

**5. Severity: Major (item 9: claim not backed by evidence)**
Affected scope: lines 31, 182, 223.
Finding: the 45-second first-event deadline is claimed to catch the agy signed-out hang. In every agy recording the `init` event carries only local data (cwd, tools, permission_mode). If a signed-out agy still prints `init`, the deadline is met and the job runs to the full 10-minute timeout. I could not settle this without running a prompt.
Recommendation: start the deadline clock for the first `step_update` (agy) or `item.*`/`turn.*` (Codex) event rather than any event, or record a signed-out run as a fixture.

### Action-item status

| # | Status | Reason |
|---|---|---|
| 1 | RESOLVED | `exec --json` only; app-server moved to alternative 4. The help text confirms `--json`, `-o`, `-m`, `-c`. |
| 2 | RESOLVED | 4.1, 4.3 and 4.6 are consistent: every job is detached and foreground means an inline `watch`. |
| 3 | RESOLVED | Timeout, re-arm, merge/throttle and the background Bash fallback are all stated (Nit 5). |
| 4 | RESOLVED | Fixed root; `CLAUDE_PLUGIN_DATA` is never read. The slug/hash scheme matches `state.mjs`. |
| 5 | RESOLVED | `node "${CLAUDE_PLUGIN_ROOT}/…"`. codex-plugin-cc uses the same form in its commands, SKILL.md and agents, so there is precedent for substitution in skill text. |
| 6 | NOT RESOLVED | Major 2. |
| 7 | RESOLVED (rules) | The `denied_actions`, empty-answer and Codex-limit rules match the fixtures. Test contradiction is Major 3. |
| 8 | NOT RESOLVED | Major 1 (resume path). Fresh-job flags match the help text. |
| 9 | Partly resolved | `codex login status` exists, and the agy probe runs only in `setup`. Deadline claim is Major 5. |
| 10 | Partly resolved | Major 4. |
| 11 | RESOLVED | Tests 13–15 plus the release transcript. |
| 12 | RESOLVED | Terms section, links, path fixed (Nit 4). |
| 13 | RESOLVED, with gaps | Exit-code table and flags are present; gaps are in Nit 3. |

### Nits

1. `codex exec` has `--skip-git-repo-check`, so by default it refuses to run outside a git repository. Line 188 defines a workspace root outside git. Pass the flag or state that Codex needs git.
2. `agy --help` lists `--effort`, but 4.4 maps `--effort` only for Codex, while line 149 presents it for every vendor. Also, agy `--write` (`accept-edits` with `request-review`) cannot run commands, while Codex `workspace-write` can. That contradicts "the same for both vendors" (line 159).
3. Some exit codes are not defined: the `--resume` refusal (line 157; code 6 is reserved for writers), and `critique` with zero ready vendors.
4. Line 245 says "four fixtures", but the folder has five (`agy-accept-edits.ndjson` is not counted).
5. Monitor's line limit is never given as a number, so "stays well under" (lines 191 and 309) cannot be checked. Re-arming `watch` replays the full history each time, and there is no option to resume from a given event.
6. Flow B and 3.1 (lines 79–86) use a bare `crewmate`, while 4.2 says the call is always `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate"`.

I did not re-raise the not-adopted items or the two checks left to the builder. Nothing in revision 2 makes them wrong.
