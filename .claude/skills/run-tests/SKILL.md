---
name: run-tests
description: Run NPC State Delta's tests with compact output (dot reporter), one file while working, the CI-side checks (validate, prompt measurement, package), and read the failures. Use before pushing and whenever a change touches runtime files, src/ or tests/.
---

# Run NPC State Delta's tests

Node 24 (`engines`). No install step. Every test file needs the alias setup
(`--import ./tests/active-runtime-test-setup.mjs`). There is no `npm run check`; `validate` does that job.

1. While working, run only the files that cover the change (`docs/dev/storysuite-adapter.md` lists the
   adapter's):
   ```sh
   node --import ./tests/active-runtime-test-setup.mjs --test --test-reporter=dot tests/storysuite-v2.test.js
   node --import ./tests/active-runtime-test-setup.mjs --test --test-name-pattern="meter" tests/storysuite-v2-meters.test.js
   ```
2. Once, after the fix, what CI runs (about 1,430 tests, about 3 minutes; run NSD alone, not in parallel
   with other repos' suites, whose load has made synthetic-host timing tests flaky):
   ```sh
   npm run test:dot              # test files (dots), then compatibility check, then runtime smoke
   npm run validate
   npm run measure:prompts
   npm run package
   git diff --check origin/main
   ```
   `npm test` is the same with the default reporter. Run it once; do not re-run old code to show a failure.
3. Reading the output:
   - one `.` per passing or skipped test, `X` per failure; no totals. The exit code is the verdict (0 green);
     `&&` stops the chain at the first failing program, so a red test file means the compatibility check and
     smoke did not run.
   - after the dots, `Failed tests:` lists each failure: name, assertion message, and a stack whose first
     `file:///…` line is the test file and line.
   - a line starting `⚠` is a failing `test.todo`; it prints `X` but does not fail the run.
   - for totals and skips run a file with the default reporter (drop `--test-reporter=dot`).
4. Prompt identity (core contract C10): `tests/stage9-regression.test.js` runs `scripts/measure-stage9.mjs`,
   which fails when the scanner request bytes differ from `tests/fixtures/stage9-budgets.json`. A failure
   there means a prompt changed: undo it unless the user approved the change. Never rewrite the baseline to pass.
5. `tests/field-paths-golden.test.js` fails when stored field paths move; regenerate only for an intended
   change (`NSD_UPDATE_GOLDEN=1 npm test`) and commit the golden diff with it.
6. The package-layout check needs this checkout's folder to be named `npc_state_delta`.
