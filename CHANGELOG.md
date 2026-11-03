# Changelog

All notable changes to crewmate will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] — 2026-11-03

### Added
- `crewmate models` / `/crewmate:models`: models and effort levels per vendor, read from `codex debug models` and `agy models`, with your Codex default from `~/.codex/config.toml` marked.
- `ask` checks `--model` and `--effort` against those lists and fails at once with the valid choices (an unreadable list never blocks a job).
- The skill tells Claude to consult `models` before choosing a model or effort.

## [1.0.0] — 2026-11-01

First public release: a Claude Code plugin around one zero-dependency Node.js CLI.

### Added
- Two-command install: `/plugin marketplace add aashish-g03/crewmate`, `/plugin install crewmate@crewmate`.
- Detached jobs for Codex (`codex exec --json`) and Gemini (`agy -p --output-format stream-json`) that survive the Claude session.
- Live progress: `crewmate watch` streams tool steps, merged and throttled for Claude Code's Monitor.
- Explicit final states (`done`, `failed`, `timeout`, `canceled`) with denied tools and tool errors listed.
- `critique`: zero-context review of files or a diff by every ready vendor (EGM-style goldfish review).
- `--resume`, `--write` / `--yolo` permission steps, one writer per workspace, `setup` readiness checks.
