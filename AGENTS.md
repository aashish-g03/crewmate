# AGENTS.md — working on crewmate

crewmate v1 is a Claude Code plugin around one zero-dependency Node.js CLI. Design: `docs/superpowers/specs/2026-11-01-crewmate-plugin-design.md`. Build plan: `docs/superpowers/plans/2026-11-01-crewmate-plugin-v1.md`.

## Layout
- `.claude-plugin/marketplace.json`: the repo root is a plugin marketplace with one plugin.
- `plugins/crewmate/bin/crewmate`: entry point. Each command is `plugins/crewmate/lib/commands/<name>.mjs` exporting `run(argv, io) → exit code`; the detached runner (`_run`) is `lib/runner.mjs`.
- `plugins/crewmate/lib/vendors/`: one adapter per vendor (`codex.mjs` → `codex exec --json`, `gemini.mjs` → `agy -p --output-format stream-json`).
- `plugins/crewmate/lib/vendored/`: copied from openai/codex-plugin-cc (Apache-2.0). Do not edit beyond the header line.
- `plugins/crewmate/lib/testing-rule.md`: the testing rule carried into critique prompts and, through the skill, into delegated test work.
- `plugins/crewmate/commands/`, `plugins/crewmate/skills/crewmate/`: the Claude Code layer. Always call `node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate"`.

## Commands
- `npm test` — `node:test` suites. Fake `codex`/`agy` in `tests/fake-bin/` replay recordings in `tests/fixtures/` (real CLI output; files starting with a `fixture_note` line are synthetic).
- `npm run typecheck` — `tsc --checkJs`.
- `npm run e2e` — the standalone end-to-end check against the real CLIs (`scripts/e2e-check.mjs`).

## Test-only environment overrides
`CREWMATE_HOME` (replaces the home folder), `CREWMATE_FIRST_EVENT_MS`, `CREWMATE_CANCEL_GRACE_MS`, `CREWMATE_SPAWN_GRACE_MS`, `CREWMATE_PROBE_MS`, `CREWMATE_BRIEF_EVERY_MS`, `CREWMATE_LOCK_TEST_PAUSE_MS` (widens the lock race window in tests). Fakes read `FAKE_FIXTURE`, `FAKE_DELAY_MS`, `FAKE_HANG`, `FAKE_HANG_AFTER`, `FAKE_EXIT`, `FAKE_ANSWER`, `FAKE_ARGV_LOG`, `FAKE_LOGIN_EXIT`, `FAKE_STDERR`, `FAKE_GRANDCHILD_PID_FILE`, `FAKE_BACKGROUND_HOLD`, `FAKE_PWD_FILE`, `FAKE_FIXTURE_RESUME` (agy fixture used when `--conversation` is passed).

## Rules
- No runtime dependencies: only `node:` built-ins and relative imports in `plugins/crewmate/`.
- Tests follow the testing rule in `plugins/crewmate/lib/testing-rule.md`: one test per failure mode, real recordings or real CLIs, no tests that restate the code.
- No Co-Authored-By or AI attribution trailers in commits.
