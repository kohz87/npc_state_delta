# NPC State Delta: notes for coding agents

**Read `AGENTS.md` first: it is this repo's binding instruction file** (authority, scope, canonical owners,
verification), then `docs/core-contract.md` (the behaviour authority, rules C01–C11), `docs/WORKPLAN.md` and
`DEVELOPMENT.md` (commands, owners). This file is the short map for Story Suite v2 work.

NPC State Delta (NSD) is a **standalone SillyTavern extension** with its own storage, scanner, prompts and
history rules. In Story Suite v2 it is also a module (id `npc-state-delta`): when a Story Block v2 host is on
the page, `src/storysuite-v2.js` registers read-only queries, the Cast / Dossiers tab and screen, its settings
section in the Story Suite overlay, and one small per-reply domain, `npc` (meters, stages, unlocked notes;
`src/npc-meters.js`). Without a v2 host the adapter does nothing and NSD works as before. The other repos:
Story Block (kohz87/Story_block, the host), RPG Battle (kohz87/rpg_battle), Story Director
(kohz87/Story_director). NSD must work alone and with any of them absent. Work is on `main`.

## Directory map

- `bootstrap.js` → `index.js`: entry (manifest `js`), per-chat state, capture, scan orchestration, persistence.
- `runtime-modules.json`: the **only** shipping JS inventory; every root `.js` file must be listed exactly once.
- Root `*.js`: canonical owners (`scanner-routing.js` the only request dispatcher, `core-mechanics.js`,
  `branch-core.js`, `continuity-core.js`, `appearance.js`, `bundle.js`, `dossier-*.js`, `full-cast.js`, ...).
- `src/storysuite-v2.js`: the Story Suite v2 adapter (queries `npc.*`, commands `npc.adjust|set|refresh|milestone|tick`).
- `src/npc-meters.js`, `npc-meters-presets.js`, `npc-meters-screen.js`: the hosted `npc` domain, presets, card.
- `src/fields/registry.js`: the one table of stored dossier fields. `src/scanner-request.js`, `relationship-pass.js`,
  `transcript.js`, `dossier-edit.js`, `util/html.js`.
- `suite.js`, `suite-handshake.js`, `story-block-tabs.js`: the v1 Story Block handshake (offers nothing to a v2 host).
- `tests/*.test.js` (synthetic host, regression and adapter tests `storysuite-v2-*.test.js`), `tests/v2/break/`,
  `tests/compatibility-check.js`, `tests/runtime-smoke.mjs`, `tests/fixtures/` (golden files, Stage 9 budgets).
- `tests/vendor/story-block/`: Story Block's testkit + runtime, vendored for the adapter tests (VERSION names the commit).
- `scripts/`: `validate.mjs`, `measure-prompts.mjs`, `measure-stage9.mjs`, `package.mjs`, `browser-stage9.py`.
- `docs/`: `core-contract.md`, `WORKPLAN.md`, `STORY_SUITE.md`, reviews and history (evidence only); `docs/dev/`: area notes.

## Commands

Node 24 (`engines`), Python 3 for the optional browser check. No npm dependencies. There is **no `check`
script**; `validate` is the syntax/ownership check.

```sh
npm test                    # node:test suites + compatibility check + runtime smoke (what CI runs)
npm run test:dot            # same three programs, the test files with one dot per test
npm run validate            # syntax, imports, namespaces, ownership, runtime inventory, versions
npm run measure:prompts     # prompt sizes from production builders on fixed fixtures
node scripts/measure-stage9.mjs   # exact scanner request bytes; fails if they differ from tests/fixtures/stage9-budgets.json
npm run package             # dist/npc_state_delta-<version>.zip, verified (dist/ is gitignored)
node --import ./tests/active-runtime-test-setup.mjs --test --test-reporter=dot tests/storysuite-v2.test.js  # one file
node ../Story_block/scripts/sync-testkit.mjs --to .             # re-vendor the Story Block testkit
git diff --check origin/main
```

Full suite: about 1,430 tests, about 3 minutes. Skills: `.claude/skills/run-tests`, `sync-testkit`.
Every test file needs `--import ./tests/active-runtime-test-setup.mjs` (source-era import aliases).

## Non-negotiables (every PR keeps them)

1. **Prompts byte-identical (core contract C10).** Model-facing wording, schemas, request counts, retries and
   output allowances do not change without the user's approval. `measure-stage9.mjs` (run by
   `tests/stage9-regression.test.js`) and `measure:prompts` prove it; never regenerate the baseline to pass.
2. **Code sets numbers; the story proposes.** Meters clamped to their range, each meter's change per reply
   held to the change cap, stages and rungs moved by code only; the story cannot set a stage.
3. **Per-reply bookkeeping** keyed by reply `sid` (e.g. the meter cap window `turn.reply`); replay == live after
   swipes, middle deletes, rewinds, reloads (Story Block SPEC §2.2).
4. **Static prompt part byte-identical** reply to reply (names flattened with `flatPromptName`, ≤ 80 code points);
   only the dynamic part changes. New static lines only via a Feature or a setting.
5. **Features (F100):** `npc-state-delta.stages`, `.drift`, `.presets` (meters), `.social` (social checks); check `ctx.feature(id)`.
6. **No markup from text:** escape (`src/util/html.js`), safe image URLs only (`safeImageUrl`).
7. **Tests for every rule,** run once after the fix, through production functions and the synthetic host.
8. Keep one owner per responsibility (settings, dispatcher, state, persistence, injection); no second engine.

## Conventions

- No model names anywhere in the repo (existing history documents excepted). Commit trailers and PR
  attribution: the lines the session gives.
- Branch off `main`, PR into `main`; agents never merge their own PR. Rebase on `origin/main` before pushing.
- A version bump changes `manifest.json`, `package.json`, `runtime-modules.json`, `core.js`
  (`NPC_STATE_VERSION`), the `bootstrap.js` banner, README title and CHANGELOG head together, and only for an
  authorized release.
- Re-sync the Story Block testkit before the final push of a PR that needs host changes; name the commit.
- Kill processes by PID, never with a broad `pkill -f`.

## Specs

- This repo: `AGENTS.md`, `docs/core-contract.md` (C10 prompt accounting, C11 acceptance), `DEVELOPMENT.md`
  ("Canonical owners", "Required commands"), `docs/STORY_SUITE.md`.
- Story Block `docs/v2/SPEC.md` §2.2 (replay rules), §5 (NSD keeps its own prompt keys, `ownPrompt`), §6 modules;
  `MODULES.md` **§D** (NSD) and **§F** decisions (F81, F90 meters and stages).
- History and decisions: `suite-notes/` in kohz87/inventory-block, branch `claude/hopeful-babbage-tipaw8`
  (README.md, WAVE_BRIEF.md, V2_LOG.md newest at the end). Area note: `docs/dev/storysuite-adapter.md`.

## Known traps

- The package-layout check expects the checkout folder to be named `npc_state_delta`; do not weaken it.
- CI fails when a root `.js` file is not in `runtime-modules.json` (or the reverse), or versions disagree.
- `runtime-modules.json` does not list `src/storysuite-v2.js`, so `tests/runtime-smoke.mjs` runs without the
  adapter (it is caught and logged); real installs load it. Known, after beta.
- The adapter tests use the vendored Story Block; suite-wide tests in the other repos import
  `src/storysuite-v2.js` from a sibling `npc_state_delta` checkout, so a change here can turn them red.
- Synthetic-host timing tests have been flaky when several repos' suites run in parallel: run NSD alone.
- `tests/field-paths-golden.test.js` freezes the field paths; an intended change regenerates it with
  `NSD_UPDATE_GOLDEN=1 npm test` in the same PR, so the diff shows what moved.
