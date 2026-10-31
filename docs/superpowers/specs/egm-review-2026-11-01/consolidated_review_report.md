# EGM consolidated review: crewmate v1 plugin design

Target: `../2026-11-01-crewmate-plugin-design.md` (revision 1, commit d08a67f)
Method: the EGM Goldfish Review Protocol (google/elephant-goldfish-model, `skills/egm-review/SKILL.md`), preset "Feature spec only" (no implementation plan in the document), run without stops. Each reviewer was a fresh Opus subagent with no conversation history, reading its EGM persona and standard. Gap: reviewers were not started with `omitClaudeMd`, so they saw the user's global CLAUDE.md (a testing rule).

Stage reports (in this folder):
- Stage 5: `zoom_out_report.md`
- Stage 6: `comprehension_report.md`
- Stage 7: `critic_design.md`, `critic_structural.md`, `critic_style.md`
- Stage 8: `intermediate_zoom_out_report.md`

Recorded CLI output used as evidence (also the planned test fixtures):
- `codex.ndjson`, `codex-denied.ndjson`: codex-cli 0.166.0
- `agy2.ndjson`, `agy-plan.ndjson`: agy 1.4.12

Result: 0 blockers. The Majors were resolved together in revision 2 along the lines of the Stage 8 report: settled as a set, they shrink the design rather than grow it.

## Action items and how revision 2 resolves them

| # | Priority | Action | Source findings | Resolution in revision 2 |
|---|---|---|---|---|
| 1 | 🟡 Major | Use one Codex transport | zoom-out F1; design F6, F7; stage 8 F1 | `codex exec --json` only; app-server moved to alternatives (7.4); ephemeral-thread question gone |
| 2 | 🟡 Major | Use one runner for every job | zoom-out F4; design F4; comprehension F4; style F3; stage 8 F2 | 4.1, 4.3, 4.6: every job is detached, and "foreground" is an inline `watch` |
| 3 | 🟡 Major | Fit Monitor's limits | design F3; comprehension F3; stage 8 F3 | Monitor timeout ≥ job timeout and re-armed; `watch` merges and throttles lines; background Bash fallback; risk row; Monitor defined in Terms |
| 4 | 🟡 Major | Fix the state root | design F1; stage 8 F4 | Fixed `~/.crewmate/workspaces/…`; `CLAUDE_PLUGIN_DATA` is never read |
| 5 | 🟡 Major | Invocation inside Claude Code | zoom-out F2; design F2; stage 8 F5 | Always `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate"`; the false "same layout" claim corrected |
| 6 | 🟡 Major | Name the reused code | zoom-out F3; design F17; stage 8 F6 | 4.2 lists the copied `codex-plugin-cc` modules (with NOTICE); fork and background-Bash alternatives added (7.5, 7.6) |
| 7 | 🟡 Major | Denials and empty answers | comprehension F2; design F6; stage 8 F7 | agy `denied_actions`; empty answer means `failed`; Codex denials stated as a limit; `done`-with-denials rule stated |
| 8 | 🟡 Major | Use the vendors' own permission controls | design F10; stage 8 F8 | Codex `-s`; agy `--mode plan` / `accept-edits` (plan mode recorded); `permission_mode` guard; `--allow-shell` cut |
| 9 | 🟡 Major | No sign-in probe per job | design F8; style F4; stage 8 F9 | 45 s first-event deadline; `codex login status`; agy probe only in `setup`, 30 s |
| 10 | 🟡 Major | Write collisions and stale lock | design F5; stage 8 F10 | Writer rule reuses the dead-runner check (pid plus start time); skill rule against Claude editing during a write job |
| 11 | 🟡 Major | Test the progress path | design F9; stage 8 F12 | `watch` failure modes 13–15; release transcript artifact |
| 12 | 🟡 Major | Fix broken references and undefined terms | structural F1–F3; comprehension F1, F6–F10; style F1, F2 | Path fixed; Terms section; links on first mention; issues described inline (not filed yet) |
| 13 | 🟡 Major | Complete the CLI contract | comprehension F5; design F16 | Exit-code table (including 6, "writer busy"); `--detach`, `--yolo`, `--diff`, `--vendors`; `watch` exit rule |
| 14 | 🟢 Nit | Pid reuse, retention | design F13, F14 | Start-time check; running jobs never pruned |
| 15 | 🟢 Nit | Critique template drift from EGM | zoom-out F5 | Template adapted from EGM's prompts; goldfish limits stated |
| 16 | 🟢 Nit | Migration detail | zoom-out F7; structural F8 | Old-install detection dropped from `setup`; `package.json` / `tsconfig.json` fate stated |
| 17 | 🟢 Nit | Prompt injection through `watch` lines | design F15 | Skill rule covers `watch` lines; `note` truncated |
| 18 | 🟢 Nit | Goal 1 omits Node | design F11; style F5 | Goal 1 lists Node 20+; unchecked user-population claim removed |
| 19 | 🟢 Nit | Wording and structure | style F6–F21; structural F4–F7, F9–F10 | §3 subsections, fence language tags, limits list, plain labels, verification dates |

## Not adopted

- **Stage 8 rejections:**
  - a second completion mechanism (`watch --quiet`)
  - a PATH fallback and minimum-version check
  - a readiness cache
  - a cap on foreground run time
  - likelihood and severity columns in the risks table

  Each is made unnecessary by items 2–5 or adds nothing for this scope.
- **Unverified, left to the builder:**
  - what `init.permission_mode` agy reports when user settings auto-approve
  - whether Monitor is available to every user

  Fallbacks are named in 4.4 and section 9.

## Still open for Aashish

1. Keep the name `crewmate` (collides with firstmate's worker name) or rename.
2. npm publishing in v1 or later.
