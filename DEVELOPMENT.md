# NPC State Delta development

## Current baseline

Status: Delta `0.1.0` with Stage 1 dossier UI and Stage 2 consolidation/active-runtime normalization. Stages 1-2 are implemented; stages 3-9 remain pending. The core contract is the sole target behavior authority; work stages are in `docs/WORKPLAN.md`.

The shipped runtime is one Delta codebase. `runtime-modules.json` is its canonical machine-readable inventory and assigns every top-level JavaScript module a current semantic role. Packaging and validation consume that inventory directly. Source-era versions and filenames are retained only in Git history, `docs/history/`, and `docs/seed-provenance.*`; they are not runtime identities.

`bootstrap.js` initializes lifecycle hardening before the canonical `index.js` controller, then loads the optional full-cast owner and the Stage 1 dossier/launcher presentation. `core-mechanics.js` is the active mechanics implementation behind the `core.js` application facade. `branch-core.js` is the active branch primitive owner used by `branch.js`. The old version-labelled runtime paths are absent. `full-cast.js` retains only the opt-in full-cast behavior and its existing backfill guard. `dossier-ui.js` plus `launcher-ui.js` remain presentation modules over canonical state.

Delta settings use `npc_state_delta`; public API is `NPCStateDelta`; sidecar and locking names are prefixed `npc-state-delta`. Bundle/data/branch format identifiers remain Delta-specific and independent from the application version. No source project is a runtime dependency.

Stage 1 does not add another state owner. `dossier-ui.js` reads canonical state through `NPCStateDelta.getState()` and opens the existing native editor through `NPCStateDelta.openEditor()`. Scanner calls, relationship mechanics, and persistence writes remain owned by the canonical runtime. Stage 2 removes the superseded secondary dossier-library projection rather than adding another owner.

Historical-shape migration readers that remain callable are active compatibility logic inside current Delta owners. They are kept only where synthetic migration/recovery tests demonstrate a current safety requirement. They do not constitute a second engine. Test fixtures may preserve historical data labels or source-era expectations when that exact shape is what the test is validating; `tests/active-runtime-test-setup.mjs` maps source-era module filenames used by inherited fixtures to the canonical active modules without placing those names back into the shipped runtime tree.

## Commands

Node.js 24 and Python 3; no npm dependencies or install step are required.

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests, host API contract, synthetic runtime and migration-shape smoke checks, Delta isolation tests, Stage 1 UI checks, and Stage 2 active-owner/layout checks |
| `npm run validate` | JS syntax, local runtime dependencies, namespace isolation, exact active-runtime inventory, semantic owner checks, and application-version consistency |
| `npm run measure:prompts` | Two shared scanner fixtures and accepted-characterization injection check; estimated tokens only |
| `npm run package` | Deterministic runtime-only `npc_state_delta-<version>.zip` built from `runtime-modules.json`, with Delta root folder and checksum; verifies archive entries and JS syntax |
| `git diff --check` | Whitespace/conflict review |

If npm cannot execute, use the actual underlying commands rather than stopping:

```sh
node --import ./tests/active-runtime-test-setup.mjs --test tests/*.test.js
node --import ./tests/active-runtime-test-setup.mjs tests/compatibility-check.js
node --import ./tests/active-runtime-test-setup.mjs tests/runtime-smoke.mjs
node --import ./tests/active-runtime-test-setup.mjs tests/migration-smoke.mjs
node scripts/validate.mjs
node scripts/measure-prompts.mjs
python3 scripts/package.py
```

All four test commands are required to claim the full test workflow passed. The migration smoke tests exercise synthetic historical Delta/source shapes inside this isolated namespace, not a supported import from another extension generation. Later stages may retire additional readers only after their callers and safety behavior are traced.

## Stage 1 verification boundary

Deterministic Stage 1 tests cover lifecycle display buckets, active/archived/dead filtering, search composition, selection retention, bounded/read-only state projection, no-chat behavior, editor/settings ownership, and bootstrap reachability. User host testing additionally exercised the launcher and dossier on tablet/mobile and drove the viewport and cast-rail fixes that completed Stage 1.

The Stage 1 controller keeps search/filter/selection state outside canonical NPC data, restores affected dossier/cast scroll where it rebuilds those surfaces, and never rewrites the native editor DOM. Save/cancel behavior itself remains owned by the existing native editor and its inherited tests.

## Stage 2 verification boundary

Stage 2 is structural. It preserves scanner semantics, relationship scoring, persistence/recovery, branch ownership, and roleplay injection while removing superseded presentation/runtime layering. Delta application version `0.1.0` remains separate from bundle format `1`, branch-lineage schema versions, and persisted schema identifiers.

The final Stage 2 normalization adds an enforceable active-runtime inventory, replaces source-version module names with current semantic owners, prevents wildcard packaging from accidentally shipping residue, and makes CI verify the same inventory. A historical origin does not make a called implementation a historical module: if Delta executes it, it is active Delta code.

## Verification boundaries

The tests create mock host modules, temporary files, and synthetic dossiers. They do not exercise a real provider, live streaming backend, actual SillyTavern database, or image service. Keep those claims separate. Do not call a smaller input estimate a demonstrated latency/semantic improvement.

The seed baseline and seed results are recorded in `docs/seed-provenance.md`. Do not rewrite those historical results. The source inventory records immutable upstream blob hashes and initial seed hashes; it is provenance, not a demand that current implementation files retain source-era names.

## Publication

Use ordinary CI; do not create temporary execution workflows. Before authorized publication inspect current remote main, preserve concurrent commits, run required checks on the exact candidate, and review changed runtime/docs. Never force-push. Verify the resulting remote tree and commit. If a required check cannot execute, complete other authorized work and state the limitation rather than inventing success.

The current user instruction authorizes the Stage 2 active-runtime normalization and cleanup. It does not authorize stages 3-9, real database modifications, release tagging, or unrelated repositories.
