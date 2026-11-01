**Style Goldfish review: crewmate v1 plan, lines 74–474**

The section is mostly dry and specific. I found no hyperbole or marketing language. The findings are about inconsistent terms and criteria that cannot be measured.

**Major**

1. **Severity:** Major
   **Affected Scope:** Tasks 5, 6, 7, 9 (e.g. lines 225–235, 247, 291–297, 393–397)
   **Style Rationale:** The plan switches between "gemini", "agy" and "Gemini (agy)" for the same thing. Line 19 makes the vendor name exactly `gemini`, and `agy` is the binary. Yet the tests say "agy with `agy2.ndjson`", "An agy `write` job" and "a fake agy". The `setup` output says `gemini: ready`. A new reader cannot tell when the vendor id is meant and when the executable is. Use `gemini` for the vendor and `agy` only for the binary, its arguments and its fixtures.

2. **Severity:** Major
   **Affected Scope:** Line 242 (synthetic fixture)
   **Style Rationale:** "Its first line is a JSON `note` object" clashes with the defined `note` event type (line 180) and with the actual marker, `event: fixture_note`. It also contradicts the parser rule on line 236, which turns unknown types into `note`, unless the reader links the two lines. Say "a first line `{"event":"fixture_note", …}`" and state the exception to line 236 in the parser rules.

3. **Severity:** Major
   **Affected Scope:** Line 422 (`ask.md`)
   **Style Rationale:** "when the job is expected to take more than 2 minutes" gives a number but no way to judge it. Nothing says how Claude should estimate the duration. Replace it with an observable condition, such as a flag, the prompt type or the `--timeout` value.

4. **Severity:** Major
   **Affected Scope:** Line 403 (Task 9 tests)
   **Style Rationale:** Reusing `CREWMATE_FIRST_EVENT_MS` as the agy probe limit gives one name two meanings. It is mentioned only inside a test bullet, in parentheses. Line 23 lists the overrides without this second meaning. Either name a separate variable or state the dual use in the Interfaces block and in line 23.

5. **Severity:** Major
   **Affected Scope:** Line 246
   **Style Rationale:** "two notes (the documented limit)" points to an unnamed source. A reader cannot tell which limit is meant or where it is documented. Give the spec section, or state the limit itself (for example, that codex does not report denied commands).

**Nit**

6. **Severity:** Nit
   **Affected Scope:** Line 300 (Task 6 commit message)
   **Style Rationale:** "honest final states" judges the code's quality. Use the factual "explicit final states", or name the states.

7. **Severity:** Nit
   **Affected Scope:** Line 95 (marketplace description)
   **Style Rationale:** "goldfish critique" is jargon this section never defines. It will appear in user-facing text. Prefer "independent critique", or define the term.

8. **Severity:** Nit
   **Affected Scope:** Line 309
   **Style Rationale:** This one sentence carries the Task 7→8 dependency, the temporary behaviour and the later switch. Split it into three short statements.

9. **Severity:** Nit
   **Affected Scope:** Line 366 (`cancel`)
   **Style Rationale:** "wait up to grace plus 1 s" uses "grace" as an undefined noun. Write "`CREWMATE_CANCEL_GRACE_MS` + 1000 ms".

10. **Severity:** Nit
    **Affected Scope:** Line 375
    **Style Rationale:** "spy" is test jargon used loosely here. The check is that a child process survives, not a spy or mock. Say "assert the child is still alive".

11. **Severity:** Nit
    **Affected Scope:** Line 425 (`critique.md`)
    **Style Rationale:** "mark agreement" gives no format. State what is marked and how, for example "findings both vendors raise are tagged `[both]`".

12. **Severity:** Nit
    **Affected Scope:** Lines 449–450 (release check)
    **Style Rationale:** "on average" has no window. Over the whole job, or per minute? "if possible" and "If logging out is not practical" are hedges with no rule for deciding. Name the window and the condition for skipping.

13. **Severity:** Nit
    **Affected Scope:** Lines 289–298 (Task 6 tests)
    **Style Rationale:** The test labels run (1)–(6), (12), (8), with (5b) in between. Both the out-of-order numbers and the ad-hoc suffix slow cross-checking against spec §4.11. Order them by number, or add a sentence saying the numbers are spec ids, not sequence.

14. **Severity:** Nit
    **Affected Scope:** Lines 164, 189, 299, 343, 378, 405, 445
    **Style Rationale:** The plan is tracked by checkbox, but it mixes one box per step (Tasks 1–2) with several steps in one box ("Step 2–4", or Steps 2, 3 and 4 inline in Task 3). This works against the tracking rule stated on line 3. Use one box per step everywhere.

15. **Severity:** Nit
    **Affected Scope:** Line 222
    **Style Rationale:** "`agent_message` → `note`" does not match the bullet above it, which spells out `item.completed` with `item.type`. Write "`item.completed` with `item.type === 'agent_message'`" so the two read the same way.

16. **Severity:** Nit
    **Affected Scope:** Line 448
    **Style Rationale:** The `"…"` placeholder prompt makes the release check hard to reproduce. Give the exact prompt.
