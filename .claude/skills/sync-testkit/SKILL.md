---
name: sync-testkit
description: Re-vendor Story Block's testkit and v2 runtime into tests/vendor/story-block from a Story Block checkout, then run the tests. Use when Story Block's v2 changed something the adapter tests rely on, and before the final push of a PR that depends on a host change.
---

# Sync the Story Block testkit

This repo has no `sync-testkit` npm script: Story Block's script does the copy. The vendored copy is used by
the adapter tests (`tests/storysuite-v2-*.test.js`, `tests/v2/break/a1-meter-window-after-delete.test.js`, ...).

1. Have a clean Story Block checkout at the commit you want (normally `origin/main`), e.g. beside this repo:
   ```sh
   git -C ../Story_block fetch -q origin main && git -C ../Story_block checkout -q main && git -C ../Story_block pull -q --ff-only
   ```
   With local changes there, VERSION records `<sha>+local-changes`.
2. Sync (replaces `tests/vendor/story-block/` as a whole, so dropped files do not linger):
   ```sh
   node ../Story_block/scripts/sync-testkit.mjs --to .
   ```
   It prints `Copied N files into …/tests/vendor/story-block (commit <sha>)`; `tests/vendor/story-block/VERSION`
   names the commit. The vendored files are tests only; they never ship (`runtime-modules.json`).
3. Run the whole suite once (`npm run test:dot`, see the `run-tests` skill) and `npm run validate`. A test that
   goes red after a sync is a real change in the host: fix the adapter (or ask in Story Block), never edit the
   vendored files.
4. Commit it with the change that needs it (or alone), and name the Story Block commit in the message and
   the PR body: "Testkit synced to Story Block v2 <short sha> (#<SB PR>)". If `DEVELOPMENT.md` names the
   testkit commit or Story Block version, update it by hand.
