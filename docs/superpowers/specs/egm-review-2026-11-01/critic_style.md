Mode was not specified. I ran this as REVIEW (document audit) because the caller asked for an audit of a document file. Scope was the full file, `/Users/aashish/Codebase/GitHub/crewmate-plugin-v1/docs/superpowers/specs/2026-11-01-crewmate-plugin-design.md`.

**Overall:** The tone is mostly dry, direct and factual. Most claims are tied to observed behaviour, version numbers or commands, and there is little marketing language. The real problems are three terms the document never defines, a few thresholds that are not quantified, and a small number of claims nobody can check.

---

### Major

1. **Severity:** Major
   **Affected Scope:** Lines 32 and 154 (Goal 5 and the "crewmate compared with EGM" paragraph in §4.7)
   **Style Rationale:** "in the style of Google's Elephant-Goldfish Model (EGM)" says EGM comes from Google, but gives no source. A reader cannot check it. Either cite a source or drop "Google's".

2. **Severity:** Major
   **Affected Scope:** Line 32 (Goal 5, "Goldfish critique") and line 63 ("Claude (the elephant, with full context)")
   **Style Rationale:** Both terms are used before they are defined. "Goldfish" is first explained at line 150. "Elephant" is never defined; line 63 only hints at it. A new reader meets the jargon in the goals with nothing to explain it. Define both terms where they first appear, or point forward to §4.7.

3. **Severity:** Major
   **Affected Scope:** Line 143 (§4.6, "the request is clearly long (a whole-repo read, a write task)")
   **Style Rationale:** "Clearly long" is a judgement call, not a rule. The two examples do not make it one. A builder cannot tell where the line between foreground and background falls. §9 (line 230) leaves only the *wording* of this choice to the builder, not the rule itself. State the rule exactly, or say plainly that Claude decides.

4. **Severity:** Major
   **Affected Scope:** Line 158 (§4.8, "a cheap read-only probe with a short timeout", "must time out quickly rather than hang")
   **Style Rationale:** "Cheap", "short" and "quickly" have no numbers. The rest of the document does give numbers (10m default timeout at line 102, 5 seconds before SIGKILL at line 139), so these stand out. They are also the behaviour that fixes issue 2 and that test 6 checks, so they need a value in seconds.

5. **Severity:** Major
   **Affected Scope:** Line 215 (§7 alternative 2, "a Node requirement that most coding-agent users already meet")
   **Style Rationale:** This is an unchecked claim about a population of users, and it is used to justify rejecting an option. Line 206 says Claude Code's native installer does not need Node, which weakens the claim. Back it with evidence, or reword it to what is known (for example, that Codex is distributed through npm, if that is the case).

### Nit

6. **Severity:** Nit
   **Affected Scope:** Line 9 ("gathers the useful parts", "simple enough for other people to install and use")
   **Style Rationale:** Neither phrase can be measured. Goal 1 makes "simple" concrete as a two-command install, but "useful parts" is never pinned down. Point to the goals list instead.

7. **Severity:** Nit
   **Affected Scope:** Line 15 ("Install takes seven steps:")
   **Style Rationale:** The list names seven commands and then adds an eighth item ("then keep `crewmate up` running"). Either count it or move it out of the list, so the number matches what follows.

8. **Severity:** Nit
   **Affected Scope:** Line 17 ("Two open bugs also matter … (issue 1) … (issue 2)")
   **Style Rationale:** "Also matter" says nothing. The issue numbers have no repository or link. Write "Two open bugs are in scope" and give the issue references.

9. **Severity:** Nit
   **Affected Scope:** Line 29 (Goal 2, "one line per meaningful event")
   **Style Rationale:** "Meaningful" is subjective. The parenthetical list defines it, so the word can go. The list also leaves out `note` and `usage`, which line 134 defines as events. Make the two lists match.

10. **Severity:** Nit
    **Affected Scope:** Line 31 (Goal 4 heading, "Honest outcomes")
    **Style Rationale:** "Honest" is a value judgement. The body underneath is exact. A plain label such as "Accurate final states" fits the document's tone better.

11. **Severity:** Nit
    **Affected Scope:** Line 45 (heading "Anti-goals (failure even if it "works")")
    **Style Rationale:** The scare quotes are informal. "Counted as failure even when the job completes" says the same thing literally.

12. **Severity:** Nit
    **Affected Scope:** Line 50 ("It drives vendor CLIs the user already has, and nothing else.")
    **Style Rationale:** "And nothing else" repeats the exclusion the sentence before already stated.

13. **Severity:** Nit
    **Affected Scope:** Line 54 ("when a second opinion helps") and line 144 ("when delegating helps", "small tasks Claude can do itself")
    **Style Rationale:** These are vague trigger conditions. They are acceptable as a summary of what the skill will say, but nothing defines "small".

14. **Severity:** Nit
    **Affected Scope:** Line 86 ("One program does everything")
    **Style Rationale:** Mild overstatement, since the vendor CLIs do the model work. "One program implements all crewmate commands" is exact.

15. **Severity:** Nit
    **Affected Scope:** Lines 117 and 120 ("Verified on this machine")
    **Style Rationale:** "This machine" only means something to the author. Give the OS and date (for example, "Verified on macOS, 2026-11-01"), as the document already does at line 190.

16. **Severity:** Nit
    **Affected Scope:** Line 177 ("Following Aashish's testing rule")
    **Style Rationale:** It refers to a rule the document neither states nor links. A fresh reader only gets the parenthetical paraphrase. Link the source or drop the attribution and keep the paraphrase.

17. **Severity:** Nit
    **Affected Scope:** Line 206 ("print a clear 'install Node 20+' message")
    **Style Rationale:** "Clear" adds nothing, because the message text is already given.

18. **Severity:** Nit
    **Affected Scope:** Line 209 (Risk row: "already covers Codex well"; "Position crewmate on what it adds")
    **Style Rationale:** "Well" is a judgement about another project's quality. "Position" is marketing language. Reword to facts: "already provides Codex delegation" and "The README states what crewmate adds: …".

19. **Severity:** Nit
    **Affected Scope:** Line 217 ("about 125,000 lines of bash")
    **Style Rationale:** This number can be checked but has no source or date. Say how it was counted (repo and commit), or drop it.

20. **Severity:** Nit
    **Affected Scope:** Line 220 ("Rejected (YAGNI)")
    **Style Rationale:** "YAGNI" is unexplained jargon. The sentence after it already gives the reason, so the abbreviation can go.

21. **Severity:** Nit
    **Affected Scope:** Whole document (the words "vendor", "agent" and "vendor CLI")
    **Style Rationale:** "Vendor" means a company in some places (line 9, "other vendors' coding agents") and a CLI target name in others (line 110, `codex`/`gemini`, where `gemini` is a model family, not a vendor). Pick one term for the CLI target (for example "vendor name") and use it throughout. "Goldfish" is also capitalised at line 32 and lowercase elsewhere.
