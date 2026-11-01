---
description: Show a finished crewmate job's answer and outcome
argument-hint: "<job-id> [--json]"
allowed-tools: Bash(node:*)
---

Run this and show its output unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/crewmate" result $ARGUMENTS
```
