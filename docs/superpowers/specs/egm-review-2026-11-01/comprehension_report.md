**What this proposes**

The document plans to replace crewmate v0.2 with crewmate v1. v1 is a Claude Code plugin installed with two commands: a zero-dependency Node.js command-line program wrapped in a few slash-command Markdown files and one skill. The program hands a prompt to a vendor coding agent, either Codex (through `codex app-server` JSON-RPC) or Gemini (through `agy -p --output-format stream-json`). It runs that job in the foreground, or detached in the background, in the caller's directory. Each job's events go to an append-only file under a per-workspace state directory. `crewmate watch` replays and streams those events, and Claude runs it under Claude Code's Monitor so progress shows up in the conversation. Every job ends as exactly one of done, failed, timeout or canceled, and tool calls the vendor denied are always reported. A `critique` command sends a file or diff to every ready vendor at once with no conversation context (the "goldfish" review). Jobs are read-only by default; `--write`, `--allow-shell` and `--yolo` raise permissions step by step, and only one writer job may run per workspace at a time.

**How the existing system works, per this document**

v0.2 runs a filesystem mailbox with a worker pool. Claude reaches it either through a Bash-only subagent that runs `crewmate send`, or through an MCP server (`send_and_wait` and eight other tools). A task does nothing until `crewmate up <agent>` is running in another terminal. Worker progress is printed inside the subagent's Bash call or written to a log file, so the user sees nothing until the end. MCP progress notifications carry only status text. Setup takes seven steps and needs Bun. The document mentions two open bugs: failures are reported as "completed", and `agy` hangs when signed out.

---

**Findings**

1. **Severity:** Major
   **Affected Scope:** Line 5 ("Replaces"), the reference to `docs/superpowers/2026-05-04-acp-transport.md`
   **Discrepancy:** That path does not exist on this branch. The file is at `docs/superpowers/plans/2026-05-04-acp-transport.md`. Line 5 is the only pointer to how v0.2 is built, so a new reader following it hits a dead end.

2. **Severity:** Major
   **Affected Scope:** Goal 4 (line 31), Anti-goals (line 48), Testing failure mode 2 (line 181), section 4.4 agy notes (line 125)
   **Discrepancy:** The anti-goal says it is a failure if "a job reports success when the vendor ... was denied the tools it needed". Test 2 says a job with denied tool steps ends as `done`. The document never says whether `done` counts as "success", or how a reader should square a `done` state with denied tools that may have been needed. Exit code 0 means `done` (line 98), so a script calling crewmate sees success. The intended rule is probably "done plus a visible denied-tools count, not a separate state". It needs to be stated outright, or a builder could fairly pick either reading.

3. **Severity:** Major
   **Affected Scope:** Flow B (line 60), Goal 2 (line 29), sections 4.3 and 4.6 ("Monitor")
   **Discrepancy:** "Monitor" is treated as a known Claude Code feature: "start a Monitor on `crewmate watch <id>`", "designed to be run under Claude Code's Monitor". The document never explains what Monitor is, how it turns stdout lines into conversation events, or where its documentation is. Goals 2 and 3 depend entirely on it, so a reader without that knowledge cannot check that the core fix works.

4. **Severity:** Major
   **Affected Scope:** Problem 1 (line 13) compared with Flow A (line 57)
   **Discrepancy:** Problem 1 blames v0.2's hidden progress on output that "stays inside the subagent's Bash call". Flow A then says foreground progress lines "stream into the Bash output" and are visible. The reason is left implicit: the Bash call now runs in the main conversation, not a subagent, and main-conversation Bash output is shown live. The document should say whether Claude Code actually shows foreground Bash output while the command is running, or only when it finishes. Without that, a reader cannot tell whether Goal 2 holds in foreground mode.

5. **Severity:** Major
   **Affected Scope:** Section 4.3 CLI table (lines 102-103) compared with sections 4.4, 4.7 and 5
   **Discrepancy:** Several flags used elsewhere are missing from the command reference:
   - `--allow-shell` and `--yolo` (lines 126 and 194) are not listed under `ask`.
   - `--diff` and `--diff <ref>` (line 152) are not listed under `critique`.

   The document also gives no exit code for some outcomes:
   - a `--write` job refused because another writer holds the lock (line 138);
   - `ask --background` and `critique`, which return at once.

   A reader treating the table as the interface contract gets an incomplete one.

6. **Severity:** Nit
   **Affected Scope:** "firstmate" (lines 39, 217, 224)
   **Discrepancy:** The document uses firstmate three times, including as a reason to consider renaming the project, but never says what it is or links to it. Line 217 gives a partial description ("a supervisor product of about 125,000 lines of bash"). The first use, on line 39, assumes the reader already knows it.

7. **Severity:** Nit
   **Affected Scope:** EGM, "goldfish" and "elephant" (lines 9, 32, 63, 150, 154)
   **Discrepancy:**
   - EGM first appears on line 9 without its expansion, which comes on line 32. Line 32 also gives no link to the Elephant-Goldfish Model.
   - "the elephant" is used on line 63 but never defined. "Goldfish" is defined only on line 150.
   - Line 154 mentions EGM's "five review stages" without naming them.

8. **Severity:** Nit
   **Affected Scope:** Line 9 and section 7, the external projects
   **Discrepancy:** `codex-plugin-cc`, `gemini-mcp-tool`, Zen/PAL, `acpx`, 9Router and claude-code-router are named without links. `codex-plugin-cc` matters most, because it is the stated model for the state-directory hashing (line 132), the packaging (line 90) and the repo layout (line 93).

9. **Severity:** Nit
   **Affected Scope:** "issue 1" and "issue 2" (lines 17 and 123)
   **Discrepancy:** The document does not say which tracker or repository these issues are in, and gives no link.

10. **Severity:** Nit
    **Affected Scope:** ACP (lines 5, 170, 216)
    **Discrepancy:** ACP is never expanded (presumably Agent Client Protocol) or linked. Line 216 assumes the reader knows what "native ACP" means for a vendor.

11. **Severity:** Nit
    **Affected Scope:** Section 4.10, the list of v0.2 parts to remove (line 170)
    **Discrepancy:** "Sweeper", "affinity recovery" and "contexts" are v0.2 terms with no explanation. This is harmless for a list of things to remove, but the reader cannot tell whether any of them hold behaviour worth keeping.

12. **Severity:** Nit
    **Affected Scope:** Section 4.5, the state directory (line 132)
    **Discrepancy:**
    - The document does not say where `${CLAUDE_PLUGIN_DATA}` comes from (Claude Code sets it for plugins) or what path it resolves to.
    - `<slug>` is undefined. A reader can guess it is the basename of the directory, but the document does not say.

13. **Severity:** Nit
    **Affected Scope:** Section 4.6 (line 143) and section 4.8 (line 158)
    **Discrepancy:** Some wording is vague:
    - The request "is clearly long (a whole-repo read, a write task)" decides between foreground and background, and Claude makes that call without a stated rule. Section 9 leaves only the wording to the builder, not the rule.
    - "A cheap read-only probe" for sign-in names no probe for either vendor.

14. **Severity:** Nit
    **Affected Scope:** Section 4.9 (line 163)
    **Discrepancy:** The document does not explain claudecodemods.dev or its "optional mod path" field, or say whether this repo needs one.

15. **Severity:** Nit
    **Affected Scope:** Testing failure mode 6 (line 185)
    **Discrepancy:** "No job folder left running" mixes up folders and processes. It probably means that no job folder is created and no process is started.

There are no Blockers. Every section could be paraphrased, and the overall design holds together.
