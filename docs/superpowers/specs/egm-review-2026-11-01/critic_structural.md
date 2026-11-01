**Mode:** REVIEW (no Mode was given; I inferred it from the TargetFile/standard task shape). **Standard:** feature-spec-standard.md. **Target:** the full file.

## Structure map

- H1: crewmate v1: one Claude Code plugin for other vendors' coding agents
- H2: 1. Problem
- H2: 2. Goals, non-goals, anti-goals
  - H3: Goals / Non-goals (v1) / Anti-goals
- H2: 3. Users and the main flows (its subsections use bold labels, not headings)
- H2: 4. Proposed architecture
  - H3: 4.1 to 4.11
- H2: 5. Security and safety
- H2: 6. Risks and limits
- H2: 7. Alternatives considered
- H2: 8. Decisions still open
- H2: 9. Left to the builder

**Blueprint compliance.** Every required area in the standard is present:
- Problem Statement is §1.
- Goals & Non-Goals is §2.
- Proposed Architecture is §4.
- Alternatives Considered is §7. It lists seven rejected options, each with a reason.
- Risks & Mitigations is §6, with §5 covering security.

Heading levels nest correctly (H1, then H2, then H3) with no skipped levels. The numbers 1 to 9 and 4.1 to 4.11 are sequential with no gaps. Code fences are all closed. Both tables (§4.3 and §6) have consistent columns and separator rows. Internal cross-references resolve: "section 7", "Section 4.4", "(4.7)", "(4.5)", "section 8" and "Goal 1" all point at the right content. I checked the claim "MCP server and its nine tools" against `src/mcp/server.ts`: it has 9 `registerTool` calls and 9 files in `src/mcp/tools/`, so it is accurate.

## Findings

1. **Major.** Line 5, header metadata ("Replaces:").
   - The named path `docs/superpowers/2026-05-04-acp-transport.md` does not exist. The file is at `docs/superpowers/plans/2026-05-04-acp-transport.md`.
   - A fresh reader following the provenance pointer hits a dead reference. This breaks the link-compliance vector.

2. **Major.** §1 line 17, §4.4 line 123, §2 Goal 4 (implied).
   - "issue 1" and "issue 2" are cited as bare numbers with no URL or title.
   - `gh issue list --state all` on `aashish-g03/crewmate` returned nothing from this checkout, so a reader cannot resolve what they refer to.
   - Link them in full (`https://github.com/aashish-g03/crewmate/issues/N`), or describe them inline and drop the numbers.

3. **Major.** §1, §2, §3, §4, §7 (whole document).
   - Many external projects are named with no link: `codex-plugin-cc`, `gemini-mcp-tool`, Zen/PAL, EGM ("Google's Elephant-Goldfish Model"), firstmate, `acpx`, 9Router, claude-code-router and claudecodemods.dev.
   - The design leans on them as reference implementations ("same layout as codex-plugin-cc and EGM", "the same scheme as codex-plugin-cc"). Without links, a reader new to the codebase cannot check those claims, which goes against the standard's core principle.
   - Fix: add a references list, or inline links on first mention.

4. **Nit.** §3, lines 54 to 65.
   - The user types and Flows A, B and C use bold text and run-in labels, while every other multi-part section uses H3 headings.
   - Use H3s (for example `### 3.1 Claude Code user`, then the flows) or a consistent labelled list, so §3 matches §2 and §4.

5. **Nit.** §4.1, line 71.
   - The architecture diagram's code fence has no language tag. The install block at line 24 has none either.
   - Use `text` for the diagram and `text` or `shell` for the commands.

6. **Nit.** §6, risks table.
   - The table has Risk, Effect and Mitigation columns, but nothing for likelihood or severity, and no scalability-limit rows.
   - The standard asks for "scalability limits" explicitly. The relevant facts (50-job retention, one critique job per vendor in parallel, one writer per workspace) are scattered through §4.5 and §6 instead of being stated as limits.
   - Add a short "Limits" sub-list or rows such as job count, concurrent jobs and event-log size.

7. **Nit.** §5 and §6 are split.
   - Security risks (§5) and operational risks (§6) sit in separate H2s with different formats: a bulleted list versus a table.
   - This is acceptable, but a single "Risks & Mitigations" section, or a pointer from §6 to §5, would align better with the standard's single requirement heading.

8. **Nit.** §4.10, lines 170 to 171.
   - The Remove and Keep lists are not exhaustive. `package.json` and `tsconfig.json` exist at the repo root and appear in neither list.
   - `package.json` still describes the v0.2 Bun mailbox and lists `./bin/crewmate`. A builder cannot tell whether it is deleted, rewritten, or replaced by `plugins/crewmate/plugin.json`.

9. **Nit.** §4.11, line 190.
   - "the denied-tool stream captured on 2026-11-01" is named as a test fixture, but no file path is given and no such fixture is in the repo.
   - Give its intended location so it can be referenced.

10. **Nit.** §2 heading and §8 heading.
    - The heading "Goals, non-goals, anti-goals" uses lowercase list style, while §8 is "Decisions still open (for Aashish)", carrying a parenthetical audience note.
    - Heading style is a little inconsistent, with no effect on meaning.

## Verdict

The document is structurally compliant with the Feature Specification Standard: all required sections are present, the hierarchy is sound, and the Markdown is well-formed. There are no Blockers. There are three Majors, all about references a reader cannot follow:
- the wrong path on line 5
- the unlinked issue numbers
- the unlinked external projects
