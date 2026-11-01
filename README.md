# crewmate

**Hand work from Claude Code to Codex and Gemini — and watch it happen.**

You're in Claude Code and want a second opinion from a different model, a read too big for Claude's context, or a task running in parallel. crewmate runs OpenAI Codex or Google Gemini (through the Antigravity CLI, `agy`) as background jobs in your current folder, streams each step into the conversation, and tells you exactly how each job ended.

```text
> /crewmate:ask codex Read add.js and tell me in one sentence what it does.

codex-mvwyfpma-tcdl
codex #1 ● started
codex #3 ▶ shell /bin/zsh -lc 'cat add.js'
codex #4 ✓ shell
codex #5 … `add.js` exports an `add` function that takes two arguments and returns their sum.
codex #7 ■ done in 8s; 29180 in / 85 out tokens
```

## What it is, and what it isn't

- **It is** a Claude Code plugin around one small Node.js program with no dependencies. Jobs run detached, survive the Claude session ending, and their answers stay readable later.
- **It is** honest about outcomes: every job ends `done`, `failed`, `timeout` or `canceled`, and tools the vendor was denied are listed, never hidden.
- **It is** read-only by default. `--write` lets a vendor edit files in the current folder; `--yolo` gives it full access. Claude only adds those when you ask.
  - Codex `--write` may also run shell commands in the folder; Gemini `--write` may edit files but still cannot run shell commands.
  - If your agy settings (`~/.gemini/antigravity-cli/settings.json`) allow write or shell tools, crewmate refuses read-only Gemini jobs instead of pretending they are read-only (agy would apply those rules anyway).
- **It isn't** a model router or an API proxy: it drives the `codex` and `agy` CLIs you already have, with their own sign-in. No API keys.
- **It isn't** a supervisor that opens PRs in git worktrees (see [firstmate](https://github.com/kunchenguid/firstmate) for that).

## Install

```text
/plugin marketplace add aashish-g03/crewmate
/plugin install crewmate@crewmate
```

Then run `/crewmate:setup`. It checks each prerequisite and prints the exact fix:

- **Node.js 20+**
- **Codex CLI** (`npm i -g @openai/codex`, then `codex login`), and/or
- **Antigravity CLI** for Gemini (`curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy` once to sign in)

## Commands

| Command | What it does |
|---|---|
| `/crewmate:ask <codex\|gemini> <prompt>` | Run a job. Flags: `--write`, `--yolo`, `--model <id>`, `--effort <level>`, `--resume[=<job-id>]`, `--timeout <90s\|10m\|1h>`. Long jobs run detached with live progress. |
| `/crewmate:critique <paths> \| --diff[=<ref>]` | Independent, zero-context review by every ready vendor, in parallel. Inspired by Google's [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model): the reviewers never see your conversation, so the gaps you filled in mentally show up. |
| `/crewmate:status [id]` | Jobs in this workspace. |
| `/crewmate:result <id>` | A job's answer plus its outcome (state, duration, tokens, denied tools, tool errors). |
| `/crewmate:cancel <id>` | Stop a running job and its vendor process. |
| `/crewmate:setup` | Check Node and both CLIs. |

Claude can also use crewmate on its own: the bundled skill tells it when a second model helps and how to watch a job.

**Outside Claude Code** the same program works from any shell or agent: `node <clone>/plugins/crewmate/bin/crewmate ask codex "…"`. Every command takes `--json`.

## Where things live

Job state is in `~/.crewmate/workspaces/<folder>-<hash>/jobs/<id>/`: `job.json`, the event log, the prompt and the answer. **Prompts and answers can contain your code**: the folders are created user-only (`0700`); delete them to remove the data. crewmate keeps the newest 50 finished jobs per workspace.

## Upgrading from v0.2

v1 replaces the mailbox, worker pool, MCP server and subagent. Remove the old pieces:

```bash
claude mcp remove crewmate
rm ~/.claude/agents/crewmate.md
rm -rf ~/.crewmate/gemini-worker ~/.crewmate/kimi-worker ~/.crewmate/codex-worker ~/.crewmate/log.jsonl
```

## Credits

- Job handling and the helpers in `plugins/crewmate/lib/vendored/` come from OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0, see `NOTICE`).
- The critique prompt is adapted from Google's [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model) reviewer prompts (Apache-2.0).

## License

MIT, except the files listed in `NOTICE`.
