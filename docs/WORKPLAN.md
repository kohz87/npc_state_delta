# NPC State Delta — staged workplan

These are sequential work stages for one source-baseline-derived extension. They are not separate architectures. The seed is complete. Stages 1-7 are implemented and deterministically verified. Stage 8 is implemented on its acceptance candidate and becomes accepted only after required CI passes for that exact candidate; Stage 9 remains pending. Real-host visual/provider acceptance for stages 4-8 remains pending where explicitly noted. The core contract governs behavior.

## Status

| Stage | Scope | Status |
| --- | --- | --- |
| Seed | Pinned source, Delta isolation, governing documents, reproducible verification | Prepared; see seed provenance for executed results |
| 1 | Side launcher and Beta-style dossier UI/UX | Accepted after deterministic checks and user tablet/mobile host QA |
| 2 | Compact code consolidation, active-runtime normalization, and Delta application version | Accepted as Delta `0.1.0`; active-runtime normalization passed exact-candidate PR CI |
| 3 | Baseline scanner with selectable connection profiles | Implemented; shared request-scoped dispatcher and post-merge hotfix verified on main |
| 4 | Baseline evolution, appearance forms, terminal automatic death | Implemented; deterministic verification passed, live host acceptance pending |
| 5 | Verify and retain accepted relationship scoring | Implemented; pinned numerical oracle and integration regressions pass |
| 6 | Verify accepted evidence and identity-first injection | Implemented; omission, characterization and budgeted appearance checks pass |
| 7 | Retained storage/recovery; remove OOC commands | Implemented; OOC removed and manual/owned-recovery checks pass |
| 8 | Portrait tooling, clean native import/export, diagnostics | Implemented candidate; required exact-candidate CI and live-host UI/image checks are the remaining acceptance gates |
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

Stage 2 establishes Delta application version `0.1.0` in the manifest, core facade, package metadata, README, validation, and package naming while leaving bundle, branch-lineage, and persisted-data schema versions independent. The superseded `enhancements.js` layer and its duplicate dossier-library UI are removed; opt-in full-cast scanning initially retained its inherited local backfill guard in the dedicated `full-cast.js` owner. Stage 3 later relocates automatic backfill eligibility ahead of the shared dispatcher so `full-cast.js` no longer patches host model routing. Bootstrap, validation, packaging, and tests are updated around that ownership.

Final Stage 2 normalization applies a stricter classification rule: ancestry does not define an active module. Any implementation executed by Delta is active Delta code. The previously version-labelled core and branch implementation files are therefore normalized into `core-mechanics.js` and `branch-core.js`. Historical source names and versions remain only in Git history, `docs/history/`, and `docs/seed-provenance.*` where they document origin rather than runtime ownership.

`runtime-modules.json` is the canonical active JavaScript inventory. Validation requires every top-level runtime JS file to appear in it exactly once under a semantic role and rejects version/legacy-labelled active paths. Packaging consumes the inventory instead of a root wildcard, so an undeclared residue file cannot silently ship. Compatibility readers for supported historical state shapes may remain inside current owners only while callers/tests prove they are necessary; they are active compatibility behavior, not a second or legacy engine.

## Stage 3 — capture and routing

Keep accepted message capture, routine/latest-exchange scan, configurable cadence/history modes, and existing focused work. Add one selectable NPC connection-profile setting and one shared request dispatcher. Default route preserves current behavior. Explicit profile failure must be actionable and must not fall back silently.

Inventory every provider call and assign its route: automatic scan, manual scan, targeted Refresh, focused relationships, retries, and retained backfills. Keep roleplay routing and portrait generation independent. Verify request counts, duplicate completions, busy/superseded scans, missing profile, timeout/cancel, chat switch, and restoration of any temporary host routing state. No trailer, separate Development stage, or next-generation synchronization barrier.

Stage 3 implementation uses `scanner-routing.js` as the single text-model request owner and `scan-context.js` for pure eligibility/participation checks. Redundant automatic backfills are suppressed before dispatch rather than by replacing `generateRaw`, so selected connection profiles receive the same guard behavior as the default route and manual repair remains available. Validation enforces that no other runtime module calls `generateRaw` directly.

## Stage 4 — appearance and lifecycle

Preserve accepted establishment/evolution and add overall appearance, named forms, and current-form selection using one resolver. Define a Delta-local upgrade for its own earlier flat appearance records; do not add imports from other extension namespaces.

Verify distinct canonical anatomy/colors, clothing-only changes, form switching, unknown/new forms, partial updates, locks, and rollback. Canonical dossier appearance, portrait, and injection must agree. Human form must not inherit anatomy from a different form. The retained editor may remain scalar-facing only if a manual edit is reconciled into the selected form rather than becoming a second authority.

Apply terminal automatic death consistently to scanner, Refresh, backfill, and structured-source paths. Remove automatic alive/reactivation behavior for dead NPCs. Verify retained history, no present/worldActive dead NPC, rejected narrative revival, explicit correction, and rollback after deleting/swiping the death source. Do not change numeric relationship formulas.

Stage 4 implementation preserves pre-form flat appearance as one safe `Base` presentation and keeps canonical `appearance` as the resolved current-display compatibility field, with optional form-independent `overallAppearance`, bounded named forms, current-form selection, and separate unnamed-current presentation. An unidentified transformation cannot fall back to prior-form anatomy, and repeated normalization cannot duplicate form-independent details. One resolver feeds canonical dossier presentation, portrait prompt construction and roleplay injection. The retained native editor remains scalar-facing; a manually locked Appearance edit is reconciled into the selected named/unnamed form rather than becoming a second authority. Appearance locks block scanner changes to overall/current presentation, forms and selection together.

Terminal lifecycle handling treats explicit confirmed death as irreversible by automatic model/structured writers. Scanner, Refresh, retained backfill and structured dossier import may still enrich retained history/profile, but dead records cannot become present/world-active or alive through narration. Manual/stale archive return remains available to living NPCs. A deliberate manual Restore of a terminal-death dossier is treated as explicit erroneous-death correction; the correction is provenance-recorded and does not make the NPC present. Owned branch rollback remains the provenance-safe way to remove a death whose source was deleted, edited or abandoned by swipe. Relationship mechanics are unchanged.

## Stage 5 — relationship baseline

Retain the exact accepted rules in C06. Expose or isolate a single mechanics owner where consolidation requires it, without changing output. Verify all four independent axes; ordinary/meaningful/major/extreme caps and axis limits; positive/negative depth bands; impact-sensitive reversals; signed fractional carry; 25/50/75/90 gates and configured-cap minima; tied-axis rejection; duplicate/aftermath handling; zero-delta summary updates; manual edits; and branch rollback.

Use the same raw proposals and initial state to compare results with the seed. Do not replace the accepted curve with Beta's or import Alpha's score scale/labels. Priority tie handling and source-event duplicate improvements remain separately proposed options until the user authorizes them. Explain gate blocking and fractions without changing mechanics.

## Stage 6 — evidence and injection

Retain supported narration/World State/Inner Chatter/dossier handling and admission/presence distinctions. Remove accidental donor restrictions or duplicate writers. Preserve identity-first prompt construction and budget ordering, incorporating Stage 4's resolved appearance.

Verify a supported first encounter; proper name established in structured context; physical presence vs off-screen reference; temporary reaction vs durable trait; profile update without ordinary NPC delta; and genuinely unknown fields. Inspect the actual next roleplay prompt for accepted selected personality, speech, behavior, mannerisms, agency, and appearance. Do not inject tentative observations as canon or sacrifice characterization solely to show lower token totals.

## Stage 7 — storage and OOC removal

Retain the accepted sidecar/owner/revision/locking/recovery design under Delta identity. Verify chat rename/delete, identical filenames under different owners, edit/swipe/delete/reload, stale writes, transient upload failure, tombstones, dirty-cache eviction protection, and manual correction retention.

Remove the OOC parser and command-only event wiring, API paths, help text, fixtures, and backfill dependencies. Keep shared functions used by manual controls or scans. Test that OOC-looking story text no longer mutates dossiers, while manual add/edit/remove and relevant repair still work. No real user data operations and no generational migration product surface.

Stages 5-7 completion is recorded in `docs/stages5-7-review.md`: numerical formulas and recovery readers are preserved, scoped integration regressions are corrected, and OOC command entry points are removed. The local workflow passes 495 unit tests plus all three smoke/contract programs, validation, prompt measurement and packaging. Live browser/provider acceptance is not claimed. Stage 8 native format/supporting tools and Stage 9 integrated performance acceptance remain separate work.

## Stage 8 — supporting tools

Stage 8 is implemented as a thin UI/envelope layer over accepted owners. `dossier-tools.js` adds the selected-dossier **Portrait** workflow plus top-level **Data** and **Diagnostics** actions; `dossier-tools-core.js` owns bounded workflow/session diagnostics; `native-transfer.js` extends the existing native manifest without replacing `bundle.js` or adding a second state store.

Portrait upload/replacement/removal reuse the retained portrait controls and compression/mutation handlers. Positive/negative prompt text comes from the existing `portraitPrompts` resolver, remains editable/copyable, and is only rebuilt through an explicit control. Host Image Generation creates a preview only; explicit application hands the result to the same canonical upload path. Async results are bound to chat/NPC/session/action ownership, and closing is allowed only while a result is still truly cancelable. A successful local portrait mutation is followed by a canonical durable flush; local-only outcomes are reported distinctly from persisted outcomes.

The native format remains the explicit Delta `NPCSTB01` / `npc_state_delta_bundle` version-1 codec. Stage 8 adds declared portable portrait settings and source-history audit data. Complete canonical decoding plus declared metadata/size checks run before mutation. Portrait binaries round-trip through the established codec. Cross-chat imports clear source message ownership and retain the target's existing history baseline; source checkpoints/lineage/inline history remain inside the file for audit and are not replayed into another chat. This is the explicit safe-baseline policy rather than invented provenance. No Alpha/Beta/legacy converter exists.

Diagnostics are separate from ordinary dossier reading and never initiate scans. They surface the dispatcher's actual aggregate request/route/failure counts, current/latest routing result, latest retry/focused-pass flags, character-derived token estimates labelled as estimates, selected-NPC relationship fractional progress/gate audit, and bounded Stage 8 persistence/workflow events. The inherited runtime does not expose an exact historical per-label request breakdown or global pending-write counter, so Stage 8 discloses that limitation instead of fabricating values. Credentials, full prompts, and provider responses are excluded from the bounded event log.

Responsive dialogs use safe-area-aware `100dvh` sizing, bounded internal scrolling, sticky mobile actions, and touch-sized controls. They refresh the affected dossier/cast projection through the existing Stage 1 scheduler instead of replacing selected-NPC/search/scroll/editor state.

Focused synthetic coverage is in `tests/stage8-supporting-tools.test.js`; the detailed implementation and live-host verification boundary is recorded in `docs/stage8-supporting-tools.md`. Required repository test/validation/prompt/package CI must pass on the exact candidate before Stage 8 is marked accepted. Real SillyTavern verification remains required for desktop/tablet/mobile layout, device file picker/touch behavior, host Image Generation preview/application, and update-arrival behavior while the workflow is open.

## Stage 9 — prompts and integrated acceptance

Keep prompt simplicity and starting limits. Compare exact constructed prompts for shared scenes with the seed, including request wrappers and any conditional focused passes. Record justified growth from forms/death/routing separately. Never compare a complete scan to only another system's partial extraction pass, or claim deferred work is free.

Run the integrated loop after all earlier stages: completed reply, scan routing, populated dossier, persistence, next-prompt characterization, selected-form portrait, branch recovery, and native export/import. Run the full deterministic suite, validation, prompt measurement, package check, and applicable browser/provider acceptance. Record model/settings, actual request counts, foreground wait, time-to-dossier, and settled backlog where measurable. Report unrun real-host/provider checks explicitly.

## Working and completion discipline

For each requested stage: inspect current HEAD and dirty work; read governing files; establish the applicable baseline; implement only that stage's cohesive changes; update tests and current docs; run affected checks; review the final diff; record results and remaining limitations. A next stage may depend on prior work but cannot silently declare it accepted. Preserve user/session authorization for commits and publication; do not require repeated approvals for already authorized work.

Historical baseline test names or fixture values may reference older versions when the exact historical shape is the subject under test. Retain useful behavior tests and migrate their filenames/current-runtime expectations when the implementation owner changes; never weaken a test just to pass after a regression. Concrete baseline bugs should be recorded and resolved in the applicable authorized stage.
