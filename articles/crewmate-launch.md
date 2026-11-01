---
title: I gave Claude Code a crew. Codex and Gemini found a bug in their own harness.
published: false
description: crewmate is a Claude Code plugin that hands work to OpenAI Codex and Google Gemini as background jobs, streams every step into the conversation, and tells you honestly how each job ended.
tags: claudecode, ai, opensource, productivity
cover_image: ../assets/launch/cover.png
---

> **TL;DR** crewmate is a Claude Code plugin that lets Claude hand a task to **OpenAI Codex** or **Google Gemini**, keep working, and watch every step land in the conversation. It installs with **2 commands**, has **0 runtime dependencies**, and passes **16/16** checks against the real `codex` and `agy` CLIs (plus **115** failure-mode tests). Its best moment: asked to review crewmate's own lock code, **Codex and Gemini both found the same race condition**, one my build plan had accepted as too rare to matter. It does **not** beat OpenAI's own Codex plugin if Codex is all you use, and it runs on macOS and Linux only.
>
> [Code](https://github.com/aashish-g03/crewmate) | [End-to-end report](https://github.com/aashish-g03/crewmate/blob/main/docs/release/1.0.0-e2e.md) | [Release check in real Claude Code sessions](https://github.com/aashish-g03/crewmate/blob/main/docs/release/1.0.0-check.md)

![A real crewmate run: Claude asks Codex whether sumTo in calc.js is correct; progress lines stream in (started, two shell commands, the answer) and the job ends "done in 15s".](../assets/launch/ask.gif)

---

## "Ask the other model"

You know the move. Claude has written something you're not sure about, so you open another terminal, paste the code into Codex or Gemini, wait, copy the answer back, and paste it into Claude. Different models miss different things, so the second opinion is often worth it. The copy-paste isn't.

I wanted Claude to do that itself: hand the task to another vendor's agent, keep working, see the progress as it happens, and get an answer it can trust, including when the other agent failed.

## The first version didn't work

crewmate v0.2 was a mailbox of folders, a worker pool, an MCP server and a Bash-only subagent. It "worked" in the sense that tasks went in and answers came out. In practice:

- **You saw nothing while a job ran.** Progress went into the subagent's Bash call, and Claude Code only shows a subagent's final message.
- **Tasks silently stalled** unless you'd left `crewmate up` running in another terminal.
- **Installing it took 7 commands**, and a failed task was reported as "completed".

![Before and after. v0.2: 7 install commands plus a terminal kept open, nothing visible until the end, tasks waiting on an unstarted pool, failures reported as "completed". v1: 2 plugin commands, each step in the chat, no daemon, failures reported with a reason and the denied tools.](../assets/launch/before-after.png)

## What I built instead

I looked at how [OpenAI's codex-plugin-cc](https://github.com/openai/codex-plugin-cc) is packaged and copied the shape, not the code paths:

- **One plugin, two commands to install.** The repo is its own plugin marketplace.
- **One small Node program with zero dependencies.** No MCP server, so nothing to `npm install` and no Bun.
- **Every job runs as a detached background process.** Claude keeps working, the job outlives the session, and the answer stays readable later.
- **Each vendor's own structured output.** Codex via `codex exec --json`, Gemini via the Antigravity CLI's `agy --output-format stream-json`. No screen-scraping.

![Architecture: Claude Code calls crewmate (ask, critique), which starts a detached runner per job. One runner drives Codex with codex exec --json, the other drives Gemini with agy stream-json. Runners write job.json, events.ndjson and result.md under ~/.crewmate, and watch --brief streams them back to Claude through Monitor.](../assets/launch/architecture.png)

The command you'll use most is `critique`: it sends a design doc or a diff to every ready vendor at once, and neither of them sees your conversation. The idea comes from the [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model), an open-source review plugin from Google engineers (not an official Google product). A "goldfish" reviewer with no context finds the gaps the author filled in mentally. crewmate's goldfish just come from other vendors.

![A real critique of a diff, watched with --brief: Codex and Gemini start together, failed tool calls show as they happen, each posts a progress summary at 30 seconds, Codex finishes in 33 s and Gemini in 75 s.](../assets/launch/critique-brief.gif)

## Claude decides when to use it

You don't have to type a slash command. I asked Claude, in plain words: *"I want a second opinion from a different model than you: does add.js handle string inputs safely? Get Gemini's view."* These are the tool calls from that real session, trimmed:

```text
Skill   crewmate:crewmate
Bash    crewmate ask gemini --detach <<'CREWMATE_PROMPT' … CREWMATE_PROMPT
Bash    crewmate watch --brief gemini-mvxp4oxz-o0o6
Bash    crewmate result gemini-mvxp4oxz-o0o6
```

Claude loaded the skill, started the job, watched it, read the result, checked it with its own Node test, and told me where it and Gemini agreed. That's the point: the orchestrating agent picks the vendor and writes the brief. The slash commands are only shortcuts for me.

## How I tested it

I don't trust tests that restate the code, so every test drives something real:

| Layer | What it runs | Result |
|---|---|---|
| Failure-mode tests | the real CLI against **recorded real output** from `codex` and `agy`: denials, empty answers, signed-out agy, timeouts, races, pid reuse | **115** passing |
| End-to-end script | the real `codex` and `agy` in a throwaway git repo: ask, resume, read-only, write + lock, cancel, critique | **16/16** |
| Real sessions | the plugin installed from GitHub, driven by real Claude Code | [release check](https://github.com/aashish-g03/crewmate/blob/main/docs/release/1.0.0-check.md) |

The design doc went through an EGM review first: six zero-context reviewers found **0 blockers** and enough major issues to reshape it (dropping a second Codex transport, one runner for every job instead of two code paths). The build had a fresh code review at three checkpoints and a whole-branch review at the end.

## What didn't work (and what the real CLIs taught me)

Each of these showed up only when I ran the real thing:

- **Gemini's "plan" mode turned questions into plans.** Ask it what a file does and it replied *"I prepared an implementation plan, see plan.md"*. Read-only runs now use agy's headless mode instead. *(Found in a real run.)*
- **agy gives up after any denied tool.** In read-only mode it would try `ls`, get denied, and end with an empty answer, marked `SUCCESS`. crewmate treats an empty answer as a failure, and continues the same conversation once with "that was denied, use your file tools". That recovers a real answer. *(Found in the end-to-end run.)*
- **agy's permission report can't be trusted alone.** With an allow-rule in the user's agy settings, agy wrote a file while still reporting `request-review`. So read-only Gemini jobs now refuse to start when your settings allow more than reading. *(Found by a reviewer, confirmed by hand.)*
- **Live progress can be too live.** Under Claude Code's Monitor, each progress line wakes Claude. A critique woke it about **55 times** to say "still running". `watch --brief` prints the start, errors, a summary a minute and the end: the next critique took **7** turns. *(Found in a real Claude Code session.)*
- **"Did not respond" was wrong for deep thinkers.** Codex at high effort can spend about a minute before its first visible step, and my 45-second check killed it. Its first event now counts. *(Found by the final review.)*
- **The name.** `crewmate` is taken on npm, and another project calls its workers "crewmates". Fine for a plugin; awkward for search.

## The moment that sold me

Late in the build, I ran `/crewmate:critique` on crewmate's own lock code: the part that guarantees only one job edits your files at a time. Codex and Gemini, reading it cold, **both** flagged the same thing. If two jobs both see an abandoned lock at the same moment, one can delete the other's fresh lock, and two writers run at once.

My plan had accepted that race as too rare to matter, and an earlier code review had listed it and set it aside for the same reason. Two different models, with no context, disagreed. The fix serializes the takeover, and a test now reproduces the race with staggered pauses. That's exactly the second opinion I built crewmate to get.

## Try it

- **In Claude Code:** `/plugin marketplace add aashish-g03/crewmate`, then `/plugin install crewmate@crewmate`, then `/crewmate:setup`. You need Node 20+ and at least one of `codex` (signed in) or `agy` (signed in).
- **Ask in plain words:** "get a second opinion from Codex on this migration" or "have Gemini read the whole repo and list dead exports". Claude picks it up from the skill.
- **Critique your own design:** `/crewmate:critique docs/design.md`, or `/crewmate:critique --diff` before you commit.
- **Reproduce my numbers:** `npm test` and `node scripts/e2e-check.mjs` in the repo.

Next, I'd like more vendors behind the same job model and a quota-aware fallback ("Codex is rate-limited, try Gemini"). If you try it, I'd love to hear where the second opinion surprised you.

---

*AI disclosure: I built crewmate with Claude Code as the implementer, working from a design and plan I directed and approved, with Codex, Gemini and fresh Claude reviewers checking the work. This post was drafted with Claude and edited by me. Every number links to a report in the repo, and every terminal frame is real output.*
