---
name: gemini-worker
description: Reference card for the Gemini CLI worker. Do NOT invoke this directly; mesh-router routes tasks to it via crewmate send.
tools: []
---

This file is a **reference card**, not an executable subagent. It documents what `gemini-worker` is so that `mesh-router` (and humans reading this repo) know when and how to delegate to it. The `tools: []` frontmatter is intentional — Claude Code should not pick this descriptor up and try to run it as a subagent.

## What it is

A pool of supervised Gemini CLI processes managed by the `crewmate` mesh. Configured at `~/.crewmate/gemini-worker/config.json`, with cards visible via `crewmate list`.

## Strengths

- **2M-token context window.** Use it when you need to read a directory tree wholesale, audit a large generated file, or cross-reference dozens of source files in one shot.
- **Hallucination check.** A second model with a fresh window is a cheap way to verify a load-bearing claim before you act on it.
- **Cheap bulk summarization.** Long-context summaries that would chunk-and-stitch in Claude can be one-shot here.

## Weaknesses

- No access to your conversation, your tools, or your file system context. Prompts must be self-contained — paste code or use absolute paths the worker can read on disk.
- Read-only relative to the project. The worker cannot edit files, run your build, or commit.
- Latency is non-trivial; budget 5–60s per call.

## Invocation (from mesh-router or shell)

```bash
crewmate send gemini-worker "<your full prompt here>" --timeout=300000
```

Optional: `--cwd=/abs/path` to set the worker's working directory.

## Result shape

`crewmate send` exits 0 and prints a single JSON `TaskResult` to stdout:

```json
{
  "taskId": "uuid",
  "agent": "gemini-worker",
  "status": "completed" | "failed" | "timeout" | "canceled",
  "summary": "...",
  "result": "<the model's output>",
  "error": null,
  "usage": { "durationMs": 1234, "exitCode": 0, "stdoutBytes": 42 },
  "completedAt": "ISO-8601"
}
```

Read `.result` on `status == "completed"`; read `.error` otherwise.
