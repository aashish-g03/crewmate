# crewmate v1

A Claude Code plugin that hands work to other vendors' coding agents (Codex via `codex exec --json`, Gemini via `agy -p --output-format stream-json`) as detached background jobs with live progress.

## Layout

- `.claude-plugin/marketplace.json`: the repo is a plugin marketplace listing one plugin.
- `plugins/crewmate/bin/crewmate`: the CLI entry point. Every command lives in `plugins/crewmate/lib/commands/<name>.mjs` and exports `run(argv, io) → exit code`; `_run` (the detached job runner) lives in `lib/runner.mjs`.
- `plugins/crewmate/lib/vendored/`: files copied from openai/codex-plugin-cc (Apache-2.0, see `NOTICE`). Do not edit beyond the header line.
- `plugins/crewmate/commands/`, `plugins/crewmate/skills/`: the Claude Code layer.
- `tests/`: `node:test` suites; `tests/fixtures/` holds recorded real CLI output; `tests/fake-bin/` holds fake `codex`/`agy`.

## Commands

- `npm test`: run the test suite.
- `npm run typecheck`: `tsc --checkJs` over the plugin code.

## Rules

- No runtime dependencies. Only `node:` built-ins and relative imports in `plugins/crewmate/`.
- Job state lives in `~/.crewmate/workspaces/<slug>-<hash>/` (tests set `CREWMATE_HOME`).

Spec: `docs/superpowers/specs/2026-11-01-crewmate-plugin-design.md`. Plan: `docs/superpowers/plans/2026-11-01-crewmate-plugin-v1.md`.
