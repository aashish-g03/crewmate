Testing rule ("crucial tests only"): tests must catch real bugs, not restate the code.
- No unit tests written after the code just to cover it; a test that mirrors the implementation catches nothing.
- Prefer end-to-end tests that drive the real thing (real CLI, real browser, real files, a recorded real fixture) and leave a checkable artifact (an output file, a log, a report, a screenshot).
- Before testing a part in isolation, list the ways it can fail (edge inputs, real-world data, past bugs); write one test per failure mode and skip the rest.
- Keep a test only if it catches a bug the end-to-end tests miss; delete tests that break on a refactor while behaviour stayed right.
- Before claiming something works, run the real flow and show its output; passing tests on mocks do not count.
