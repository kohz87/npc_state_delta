# NPC State Delta — staged workplan

These are sequential work stages for one source-baseline-derived extension. They are not separate architectures. The seed is complete. Stages 1 and 2 have been requested and implemented; stages 3–9 remain pending until requested. The core contract governs behavior.

## Status

| Stage | Scope | Status |
| --- | --- | --- |
| Seed | Pinned source, Delta isolation, governing documents, reproducible verification | Prepared; see seed provenance for executed results |
| 1 | Side launcher and Beta-style dossier UI/UX | Accepted after deterministic checks and user tablet/mobile host QA |
| 2 | Compact code consolidation, active-runtime normalization, and Delta application version | Accepted as Delta `0.1.0`; final normalization requires exact-candidate CI before merge |
| 3 | Baseline scanner with selectable connection profiles | Pending |
| 4 | Baseline evolution, appearance forms, terminal automatic death | Pending |
| 5 | Verify and retain accepted relationship scoring | Pending |
| 6 | Verify accepted evidence and identity-first injection | Pending |
| 7 | Retained storage/recovery; remove OOC commands | Pending |
| 8 | Portrait tooling, clean native import/export, diagnostics | Pending |
| 9 | Prompt/token baseline and final integrated verification | Pending |

## Seed boundary

Import the pinned source snapshot at `a12b2937b5c1305e3e3017218a626478a5bedcdc` into the repository root, including runtime, tests, and source provenance. Preserve the existing GPL license. Keep a complete verified source snapshot outside the shipping tree during seeding. Move historical markdown to `docs/history/`; do not create a duplicate runtime under a new source/legacy folder.

Apply deterministic Delta namespace substitutions across runtime, CSS, and inherited tests. Keep source semantic algorithms and schemas otherwise intact. Source-era runtime version markers during seeding are historical provenance, not completed Delta release claims. Update Delta's README and verification workflow without changing algorithmic behavior. Stage 2 chooses Delta application versioning without silently changing persistence versions.

Deliver `AGENTS.md`, `docs/core-contract.md`, this workplan, `DEVELOPMENT.md`, `docs/seed-provenance.md`, and the machine-readable source inventory. Verify original blob hashes, run the upstream baseline and seeded synthetic suite, syntax/import/isolation validation, prompt checks, and package verification. Do not implement appearance forms, death-policy changes, connection profiles, new UI, or OOC removal during seeding.

## Stage 1 — dossier UI

Use Alpha's side-launcher idea and Beta's dossier/cast-rail UX over canonical Delta state. Inspect donor components and their dependencies; adapt presentation only. Keep temporary alternate viewer routes only where a current caller requires them, and retire them with that caller when replacement is complete.

Deliver a readable dossier, cast selection/search, editor entry points, and settings access. Refresh affected views from projections of canonical state. Preserve focus/scroll/unsaved edits. Verify open/close, no-chat state, selection, save/cancel, active/archived/dead filtering, and updates arriving during interaction. Measure open-panel behavior in a real browser when available; do not equate generated HTML tests with visual QA. No scanner/scoring redesign.

Stage 1 implementation adds `dossier-ui.js` as a Delta-local presentation adapter loaded after the canonical runtime. It projects only rendered dossier fields, uses the existing `NPCStateDelta.openEditor` and settings owners, refreshes from canonical-state notifications without touching the external editor draft, and keeps search/selection/scroll state in the UI controller. Focused model tests cover filtering, search, no-chat state, selection retention, projection boundaries, and ownership. User tablet/mobile host testing supplied the final viewport and cast-rail acceptance feedback.

## Stage 2 — consolidation and active-runtime normalization

Map entrypoint imports, globals, timers, event bindings, settings, persistence readers, tests, and packaging. Consolidate inherited core/wrapper/enhancement layers into clear owners and remove verified superseded paths; there must be only one runtime implementation. Choose coherent Delta application version markers separately from data/bundle schemas.

Preserve behavior, locks, tombstones, dirty-write retries, branch checkpoints, and unresolved recovery. Remove stale documentation claims or mark them historical. Unused code removal needs caller evidence, not version-looking filenames alone. Verify the full synthetic suite, runtime reachability, duplicate listener prevention, and packaged load. Keep ongoing cleanup in subsequent stages; Stage 2 is not permission to implement later behavior.

Stage 2 establishes Delta application version `0.1.0` in the manifest, core facade, package metadata, README, validation, and package naming while leaving bundle, branch-lineage, and persisted-data schema versions independent. The superseded `enhancements.js` layer and its duplicate dossier-library UI are removed; opt-in full-cast scanning and the retained backfill guard live in the dedicated `full-cast.js` owner. Bootstrap, validation, packaging, and tests are updated around that ownership.

Final Stage 2 normalization applies a stricter classification rule: ancestry does not define an active module. Any implementation executed by Delta is active Delta code. The previously version-labelled core and branch implementation files are therefore normalized into `core-mechanics.js` and `branch-core.js`. Historical source names and versions remain only in Git history, `docs/history/`, and `docs/seed-provenance.*` where they document origin rather than runtime ownership.

`runtime-modules.json` is the canonical active JavaScript inventory. Validation requires every top-level runtime JS file to appear in it exactly once under a semantic role and rejects version/legacy-labelled active paths. Packaging consumes the inventory instead of a root wildcard, so an undeclared residue file cannot silently ship. Compatibility readers for supported historical state shapes may remain inside current owners only while callers/tests prove they are necessary; they are active compatibility behavior, not a second or legacy engine.

## Stage 3 — capture and routing

Keep accepted message capture, routine/latest-exchange scan, configurable cadence/history modes, and existing focused work. Add one selectable NPC connection-profile setting and one shared request dispatcher. Default route preserves current behavior. Explicit profile failure must be actionable and must not fall back silently.

Inventory every provider call and assign its route: automatic scan, manual scan, targeted Refresh, focused relationships, retries, and retained backfills. Keep roleplay routing and portrait generation independent. Verify request counts, duplicate completions, busy/superseded scans, missing profile, timeout/cancel, chat switch, and restoration of any temporary host routing state. No trailer, separate Development stage, or next-generation synchronization barrier.

## Stage 4 — appearance and lifecycle

Preserve accepted establishment/evolution and add overall appearance, named forms, and current-form selection using one resolver. Define a Delta-local upgrade for its own earlier flat appearance records; do not add imports from other extension namespaces.

Verify distinct canonical anatomy/colors, clothing-only changes, form switching, unknown/new forms, partial updates, locks, and rollback. Dossier/portrait/injection must agree. Human form must not inherit anatomy from a different form.

Apply terminal automatic death consistently to scanner, Refresh, backfill, and structured-source paths. Remove automatic alive/reactivation behavior for dead NPCs. Verify retained history, no present/worldActive dead NPC, rejected narrative revival, explicit correction, and rollback after deleting/swiping the death source. Do not change numeric relationship formulas.

## Stage 5 — relationship baseline

Retain the exact accepted rules in C06. Expose or isolate a single mechanics owner where consolidation requires it, without changing output. Verify all four independent axes; ordinary/meaningful/major/extreme caps and axis limits; positive/negative depth bands; impact-sensitive reversals; signed fractional carry; 25/50/75/90 gates and configured-cap minima; tied-axis rejection; duplicate/aftermath handling; zero-delta summary updates; manual edits; and branch rollback.

Use the same raw proposals and initial state to compare results with the seed. Do not replace the accepted curve with Beta's or import Alpha's score scale/labels. Priority tie handling and source-event duplicate improvements remain separately proposed options until the user authorizes them. Explain gate blocking and fractions without changing mechanics.

## Stage 6 — evidence and injection

Retain supported narration/World State/Inner Chatter/dossier handling and admission/presence distinctions. Remove accidental donor restrictions or duplicate writers. Preserve identity-first prompt construction and budget ordering, incorporating Stage 4's resolved appearance.

Verify a supported first encounter; proper name established in structured context; physical presence vs off-screen reference; temporary reaction vs durable trait; profile update without ordinary NPC delta; and genuinely unknown fields. Inspect the actual next roleplay prompt for accepted selected personality, speech, behavior, mannerisms, agency, and appearance. Do not inject tentative observations as canon or sacrifice characterization solely to show lower token totals.

## Stage 7 — storage and OOC removal

Retain the accepted sidecar/owner/revision/locking/recovery design under Delta identity. Verify chat rename/delete, identical filenames under different owners, edit/swipe/delete/reload, stale writes, transient upload failure, tombstones, dirty-cache eviction protection, and manual correction retention.

Remove the OOC parser and command-only event wiring, API paths, help text, fixtures, and backfill dependencies. Keep shared functions used by manual controls or scans. Test that OOC-looking story text no longer mutates dossiers, while manual add/edit/remove and relevant repair still work. No real user data operations and no generational migration product surface.

## Stage 8 — supporting tools

Retain useful controls and implement Beta-style portrait prompt editing/copy/generation using resolved appearance. Avoid two competing portrait workflows. Verify attachment, image-route errors, cancellation, target chat ownership, and positive/negative prompt consistency.

Finalize one native Delta import/export format with explicit versioning and documented contents. Validate before changing state; preserve or explicitly reconcile supported history/portrait/ownership data. Reject other generations without building converters. Round-trip valid data, reject malformed/foreign bundles, and verify import target ownership.

Expose bounded diagnostics for scan requests, failures/retries, stale rejection, persistence, relationship fractions/gates, and prompt estimates. Keep technical evidence hidden in ordinary dossier use. Native export/import UI, diagnostics, and portrait controls must use the same canonical state/settings paths.

## Stage 9 — prompts and integrated acceptance

Keep prompt simplicity and starting limits. Compare exact constructed prompts for shared scenes with the seed, including request wrappers and any conditional focused passes. Record justified growth from forms/death/routing separately. Never compare a complete scan to only another system's partial extraction pass, or claim deferred work is free.

Run the integrated loop after all earlier stages: completed reply, scan routing, populated dossier, persistence, next-prompt characterization, selected-form portrait, branch recovery, and native export/import. Run the full deterministic suite, validation, prompt measurement, package check, and applicable browser/provider acceptance. Record model/settings, actual request counts, foreground wait, time-to-dossier, and settled backlog where measurable. Report unrun real-host/provider checks explicitly.

## Working and completion discipline

For each requested stage: inspect current HEAD and dirty work; read governing files; establish the applicable baseline; implement only that stage's cohesive changes; update tests and current docs; run affected checks; review the final diff; record results and remaining limitations. A next stage may depend on prior work but cannot silently declare it accepted. Preserve user/session authorization for commits and publication; do not require repeated approvals for already authorized work.

Historical baseline test names or fixture values may reference older versions when the exact historical shape is the subject under test. Retain useful behavior tests and migrate their filenames/current-runtime expectations when the implementation owner changes; never weaken a test just to pass after a regression. Concrete baseline bugs should be recorded and resolved in the applicable authorized stage.
