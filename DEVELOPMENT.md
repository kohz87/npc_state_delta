# NPC State Delta development

## Current baseline

Status: Delta `0.1.0` with Stages 1-7 implemented and deterministically verified. Stage 8 is implemented on its acceptance candidate and becomes accepted only after the repository's required CI passes on that exact candidate. Real-host stages 4-8 visual/provider acceptance remains pending where applicable; Stage 9 remains pending. The core contract is the sole target behavior authority; work stages are in `docs/WORKPLAN.md`.

The shipped runtime is one Delta codebase. `runtime-modules.json` is its canonical machine-readable inventory and assigns every top-level JavaScript module a current semantic role. Packaging and validation consume that inventory directly. Source-era versions and filenames are retained only in Git history, `docs/history/`, and `docs/seed-provenance.*`; they are not runtime identities.

`bootstrap.js` initializes lifecycle hardening and the Stage 3 scanner-routing owner before the canonical `index.js` controller, then loads the optional full-cast owner, the Stage 1 dossier presentation, Stage 8 supporting tools, and the launcher. `core-mechanics.js` is the active mechanics implementation behind the `core.js` application facade. `branch-core.js` is the active branch primitive owner used by `branch.js`. The old version-labelled runtime paths are absent. `full-cast.js` retains only the opt-in full-cast behavior; it does not patch host model routing. Automatic backfill relevance is decided in `scan-context.js`/`index.js` before the shared dispatcher so default and selected scanner profiles behave identically. `dossier-ui.js` plus `launcher-ui.js` remain presentation modules over canonical state. `dossier-tools.js` is a Stage 8 controller over the same public runtime/state owners; it does not create another store.

Delta settings use `npc_state_delta`; public API is `NPCStateDelta`; sidecar and locking names are prefixed `npc-state-delta`. Bundle/data/branch format identifiers remain Delta-specific and independent from the application version. No source project is a runtime dependency.

Stage 3 routes every retained NPC model request through one request-scoped dispatcher; an empty profile keeps the host default route, while an explicit profile failure is surfaced rather than silently falling back. Stage 4 keeps one canonical dossier state. `appearance.js` owns named-form normalization/resolution, including a separate unnamed-current presentation so form-independent details cannot duplicate or leak across forms; `terminal-lifecycle.js` owns terminal-death policy; and `continuity-core.js` adapts the existing mechanics facade so the same resolved current appearance reaches dossier, portrait prompts and roleplay injection without another state owner. The retained native editor remains scalar-facing: when its Appearance field is manually locked, Stage 4 reconciles that edit into the selected current form so it cannot become a second appearance authority. Confirmed explicit death is terminal to automatic scan/Refresh/backfill/structured-source writers; a deliberate manual Restore is treated as explicit erroneous-death correction with provenance, while owned-history rollback remains the provenance-safe correction path for deleted/edited/swiped death evidence.

Stage 1 does not add another state owner. `dossier-ui.js` reads canonical state through `NPCStateDelta.getState()` and opens the existing native editor through `NPCStateDelta.openEditor()`. Scanner calls, relationship mechanics, and persistence writes remain owned by the canonical runtime. Stage 2 removes the superseded secondary dossier-library projection rather than adding another owner.

Stage 8 adds three declared semantic modules. `dossier-tools-core.js` contains bounded workflow/session diagnostics and durable-flush reporting. `native-transfer.js` extends the existing `bundle.js` manifest with declared portable portrait settings and source-history audit metadata without replacing the bundle codec/import merge. `dossier-tools.js` adds the dossier-facing Portrait/Data/Diagnostics actions and reuses the inherited portrait upload/removal handlers, public prompt builder, host Image Generation entry point, native export/import owner, and canonical flush. Cross-chat native import clears source-message ownership before canonical reconciliation and keeps target history/checkpoints as the safe baseline. Source lineage/checkpoints/inline history remain in the file for audit only. See `docs/stage8-supporting-tools.md`.

Historical-shape migration readers that remain callable are active compatibility logic inside current Delta owners. They are kept only where synthetic migration/recovery tests demonstrate a current safety requirement. They do not constitute a second engine. Test fixtures may preserve historical data labels or source-era expectations when that exact shape is what the test is validating; `tests/active-runtime-test-setup.mjs` maps source-era module filenames used by inherited fixtures to the canonical active modules without placing those names back into the shipped runtime tree.

## Commands

Node.js 24 and Python 3; no npm dependencies or install step are required.

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests, host API contract, synthetic runtime and migration-shape smoke checks, Delta isolation tests, UI/active-owner checks, Stage 3 routing checks, Stage 4 appearance/lifecycle regressions, stages 5-7 scoring/evidence/OOC-removal regressions, and Stage 8 native-transfer/workflow safety regressions |
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

## Stage 3 verification boundary

Stage 3 adds `scanner-routing.js` as the shared request-scoped dispatcher and `scan-context.js` as the active backfill-eligibility owner. Automatic/manual scans, targeted Refresh, focused relationships, JSON retries, structured dossier imports and retained backfills share the dispatcher. The empty profile preserves `generateRaw`; a selected profile is isolated from ordinary roleplay and image routing. Automatic off-screen backfill suppression happens before dispatch rather than by monkey-patching `generateRaw`, so the guard has route parity. Validation rejects direct runtime `generateRaw` access outside `scanner-routing.js`. Cancellation, timeout, stale/superseded work, missing-profile errors and duplicate completion handling are covered by the synthetic suite.

## Stage 4 verification boundary

Stage 4 preserves the flat `appearance` field as a safe compatibility/current-display baseline while adding optional form-independent `overallAppearance`, bounded named `appearanceForms`, `currentForm`, and an explicit unknown-current-form state backed by `unclassifiedAppearance`. Pre-Stage-4 flat appearance is copied into a `Base` form without fabricating alternates. `resolveNpcAppearance()` is the shared current visual resolver: merge normalization writes its result back to canonical `appearance`, while dossier display, portrait prompts and roleplay injection consume that same resolved presentation. Repeated normalization cannot duplicate overall details, and an unidentified transformation never falls back to another form's anatomy. The retained dossier editor continues to edit the resolved current Appearance field; when manually locked, that scalar edit is reconciled into the selected named/unnamed form instead of overwriting unrelated forms.

Confirmed explicit death is terminal to automatic writers. Scanner, targeted Refresh, backfill and structured dossier import can enrich a dead record but cannot restore `present`, `worldActive`, living state, or post-death relationship progression. Living NPCs archived manually/stale may still reactivate under the accepted policy. A deliberate manual **Restore** of a confirmed-dead dossier is treated as explicit correction of an erroneous death record; it records correction provenance and leaves the NPC off-screen rather than implying narrative resurrection. Branch rollback can restore the pre-death snapshot when the owned death source is deleted/edited/swiped away. The final Stage 4 deterministic run has 488 unit tests plus compatibility/runtime/migration smoke checks; deterministic tests are not a substitute for real-host visual/provider acceptance.

## Stages 5-7 verification boundary

`docs/stages5-7-review.md` records the full production-path trace, scoped fixes and exact upstream oracle provenance. The numerical mechanics match 41,070 fixed cases from the pinned source. The local workflow passes 495 unit tests plus compatibility/runtime/migration smoke checks. Existing evidence selectors and recovery readers remain in place; only OOC-specific parser/dispatch/help/bookkeeping and superseded injection assembly were removed.

Story text no longer executes OOC add/remove commands. Manual controls still own explicit mutations, and the user-turn listener only maintains hydrated lineage. Focused relationship application and post-Refresh/backfill checkpointing enforce terminal death even without archiving. Explicit manual correction works for those unarchived records and retains correction provenance. The actual synthetic host injection is checked; live UI/model behavior remains unrun.

To validate the pinned numerical result, `npm test` consumes `tests/fixtures/scoring-oracle.json` through generated inputs in `scoring-cases.mjs`. This is an offline expected-result fixture, not a shipped reference engine. Do not regenerate it from the implementation under test. Instructions and original blob identity are in the review record.

## Stage 8 verification boundary

Focused Stage 8 synthetic tests cover image-file validation, chat/NPC/session/action stale guards, bounded sensitive-data-free event records, relationship signed fractions/gate audit, portable portrait-settings filtering, native envelope round-trip with embedded portraits, source-history audit stripping of duplicate portrait binary payloads, cross-chat source-message ownership clearing, terminal-death preservation, and malformed/foreign input rejection. Existing Stage 4 tests remain the authority for resolved appearance/current-form anatomy and canonical color preservation; existing bundle tests remain the authority for canonical import identity/capacity/portrait merge behavior.

The Stage 8 UI deliberately calls inherited production functions rather than a test-only state mutation path. Device upload/replacement uses the retained delegated upload handler and compression path; remove uses the retained delegated remove handler; generation uses `NPCStateDelta.generatePortraitUrl()`; native transfer calls `NPCStateDelta.exportBytes()`/`importBytes()` and then `NPCStateDelta.flush()` for durable confirmation. Generated preview is never applied until explicit user action. Once an upload/application has entered the inherited mutation handler, close/cancel is disabled rather than falsely promising cancellation; generation/fetch remains cancelable before that handoff.

Deterministic CI cannot prove browser layout, real file-picker behavior, touch scrolling, actual SillyTavern Image Generation, provider latency, or visual cast-thumbnail refresh. Those checks remain explicitly live-host-only. The container used for this Stage 8 continuation could not resolve `github.com`, so a conventional local checkout/full command run was unavailable; exact-candidate GitHub CI is therefore the deterministic acceptance gate. Do not relabel CI as a local run.

## Verification boundaries

The tests create mock host modules, temporary files, and synthetic dossiers. They do not exercise a real provider, live streaming backend, actual SillyTavern database, or image service. Keep those claims separate. Do not call a smaller input estimate a demonstrated latency/semantic improvement.

The seed baseline and seed results are recorded in `docs/seed-provenance.md`. Do not rewrite those historical results. The source inventory records immutable upstream blob hashes and initial seed hashes; it is provenance, not a demand that current implementation files retain source-era names.

## Publication

Use ordinary CI; do not create temporary execution workflows. Before authorized publication inspect current remote main, preserve concurrent commits, run required checks on the exact candidate, and review changed runtime/docs. Never force-push. Verify the resulting remote tree and commit. If a required check cannot execute, complete other authorized work and state the limitation rather than inventing success.

The current user instruction authorizes Stage 8 implementation, documentation, commit, push, PR, and merge only after required checks pass on the latest PR candidate. It does not authorize Stage 9, real user-database modification, release tagging, force-pushing main, or unrelated repositories.
