# crewmate

## Agent mesh delegation (MCP)

When the `crewmate` MCP server is connected, you have 9 tools for delegating work to external CLI agents (Gemini, Kimi, Codex). Use them instead of doing large-context reads, cross-vendor checks, or deep reasoning yourself.

### Routing rules

1. Call `crewmate_list_agents` first to discover which workers are ready and their current load.
2. Pick the right worker:
   - **gemini-worker**: Large-context reads (>50 files), codebase audits, hallucination checks. 2M context window.
   - **kimi-worker**: Deep reasoning, algorithmic problems, second opinions on tricky logic.
   - **codex-worker**: Vendor diversity, GPT-family refactors, cross-vendor reconciliation.
3. Call `crewmate_send_and_wait` with a **self-contained prompt** — the worker has no access to your conversation, files, or tools. Paste code/paths inline.
4. Parse the structured result. Surface `.result` to the user. If `.status != "completed"`, surface `.error`.

### When to delegate

- The task involves reading more files than fit in your working context
- You want an independent second opinion on a claim
- You need a different vendor's perspective (Gemini vs Claude vs GPT)
- Factual bulk queries ("find all uses of X across 200 files")

### When NOT to delegate

- You need to edit files (workers are read-only)
- The answer is already in your context
- Single-file questions you can answer instantly

### Persistent contexts

For multi-turn work, pass `newContext: true` on the first call, then `contextId` on follow-ups. Workers remember prior turns — no re-reading 500K tokens per follow-up.

### Do not suppress progress

`crewmate_send_and_wait` emits MCP progress notifications (queued, claimed, worker stdout streaming). These are signal, not noise. Do not ask the user to ignore them.
