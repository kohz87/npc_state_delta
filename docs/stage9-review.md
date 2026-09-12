# Stage 9 integrated review and release evidence

Status: four review cycles completed; local release candidate 1.0.0 verified. Required exact-candidate CI remains the gate for release acceptance and merge. No live-provider acceptance is claimed.
Baseline: `fde5b35671337106cfe68341941c746707c7d7b3`, tree `668d4bd0ab0a007353fb26bafede38a614fdf739`.
Stage 8 and its follow-ups are integrated through PRs 26-29. Baseline main CI run 34688423406 passed.
The exact main source was recovered from that run's existing verification Git bundle; no temporary workflow was added.
Working branch: `work/stage9-release`. No existing local changes were overwritten.

## Scope and method

The current Stage 9 instruction supersedes earlier prompt-optimization wording. Preserve model-facing instructions, schemas, evidence/context selection, allowances, thinking settings and automatic request counts. Consolidate active paths, fix reproducible integration defects, and verify the complete loop without another engine or paid provider calls.

Initial baseline/Cycle 1 used Node 22.16.0 and Python 3. An existing Node 24.11.1 executable was then found alongside the installed browser tools; baseline and Cycle 2/final checks are repeated on Node 24 to match the documented CI major version. Local execution is reported separately from CI. Source provenance, historical documents and numerical oracle fixtures remain unchanged.

## Baseline

- `npm test`: 550 unit tests plus compatibility, runtime and migration smoke checks pass.
- `npm run validate`: 31 declared runtime modules, all checks pass.
- `npm run measure:prompts`: scanner fixtures 6,886 and 7,791 characters including system text; characterization injection 1,637 characters.
- `npm run package`: 292,552-byte runtime package, exact entries/bytes/JS syntax verified.
- `git diff --check`: pass.
- Additional production request capture: `scripts/measure-stage9.mjs` executes the actual request/retry builder and dispatcher with fixed synthetic responses. `tests/fixtures/stage9-budgets.json` records the untouched baseline's hashes, complete Delta-owned message sizes, request counts, flags and output allowances for both default and selected-profile routes. It is not a provider token or extraction-quality measurement.

## Cycle 1: production paths and ownership

| Severity | Reproducible finding and consequence | Resolution and verification |
| --- | --- | --- |
| High | Locked appearance-form edits reuse the previous scalar and can overwrite the newly selected anatomy. Clearing an unknown presentation can also restore the previous anatomy. | Manual form mutation is owned by `appearance.js` and the canonical runtime; resolve without replaying the old scalar/lock. Tests verify colors, anatomy, unchanged alternate forms, explicit clear and locks. |
| High | Appearance Apply serializes/imports an entire dossier and awaits persistence without binding the editor to its original chat. | Scoped canonical appearance API; chat/NPC/draft ownership checked before mutation and after flush. No duplicate appearance store or import-based edit. |
| High | Cross-chat import leaves newer birthday/death-correction source-message fields attached; missing source identity was trusted. Malformed dossier shapes can pass initial validation. | Clear source-message ownership recursively for unproven targets; validate every dossier before mutation. Preserve same-chat provenance, portrait payloads, signed fractions, forms and safe target history. |
| Medium | Runtime stripping removes structured calendar boundaries before merge; synthetic direct-merge tests did not cover this path. | Pass the already-owned raw assistant message separately to deterministic date extraction. The scanner receives identical text. Honor manual age locks and terminal-death state. |
| Medium | Mixed World State encodings are grouped out of source order; NPC birth dates can masquerade as the current header; numeric birthday comparison varies with leap year. | Source-order extraction, header boundary and consistent month/day comparison. Focused arithmetic and mixed-block tests. |
| Medium | Array.map passes its numeric index as calendar configuration; older manual fallback can reverse the accepted age in ordinary injection. | Explicit callback and accepted-age projection. No new model instruction or request. |
| Medium | Portrait workflows poll whole chat/history copies every 60 ms and duplicate the upload/remove path. Stale completion can close a replacement modal. | Await canonical upload/remove operations, use scoped single-NPC reads and session-bound modal completion. Remove the superseded second manager and controls module. |
| Medium | Diagnostic history accepts arbitrary exception details and hardcodes a false pending-write metric. | Retain bounded allowlisted metadata only; expose actual current-chat dirty/in-flight flags. |
| Medium | Permanent HTTP save rejection retries indefinitely because the wrapper contains the word "failed". | Nonretryable 4xx returns an error while dirty state remains recoverable; transient/network/408/425/429/5xx behavior and locks are retained. Full synthetic runtime verifies local-only state and later successful flush. |
| Medium | Root/document mutation observers repeatedly copy full state and perform redundant UI normalization. | Dossier/editor/settings owner notifications, lightweight projection and selected-record reads replace superseded observation/polling. Browser review follows in Cycle 2. |

Verification: 564 tests plus all three smoke/contract programs pass; validation (30 runtime modules), prompt measurement, package integrity and whitespace checks pass. Both-route request captures match baseline byte-for-byte, including the malformed-response retry. Package before release metadata is 288,330 bytes. No model-facing wording changed.

## Cycle 2: browser interactions, native route and prior-fix review

| Severity | Evidence and practical consequence | Fix/disposition |
| --- | --- | --- |
| High | Retained native preview application awaits image fetching/decoding without revalidating the current dialog/state; a stale completion can replace a newer portrait. | Canonical upload owner is reused, with dialog/chat/NPC/state revalidation before application and durable flush afterward. Actual registered controls are tested for preview vs apply, cancel, replaced dialog and late image fetch. |
| High | Manual life-state Apply uses whole-dossier import; erroneous-death Restore closes the editor and can discard unrelated input. | A scoped canonical life-state API keeps checkpoint/correction provenance without import or editor closure. Newer selected choices and unrelated drafts survive delayed flush. |
| Medium | Public importBytes bypasses declared native metadata validation, even though the UI validates it. Input count is advertised as imported when capacity/exclusion skips exist. | The canonical public path validates the full envelope and source ownership; UI reports actual added/updated/skipped results. Tests verify malformed metadata causes no mutation. |
| Medium | Unbounded nested/prototype-shaped import data can reach recursive scrubbing and object maps. | Bound nesting to 64 levels and reject unsafe metadata/reserved IDs before mutation; do not remove historical-state recovery readers. |
| Medium | Actual browser layout clips cast-card metadata and a capped tablet editor footer. Explicit label CSS overrides the hidden unclassified field. | Clamp cards to available rail height, align content bounds with actual popup height, and honor hidden controls. Verified at all four synthetic viewports. |
| Medium | Escape closes the underlying dossier and suppresses the tools dialog's native cancel action. | Top dialog owns Escape; dossier ignores it while tools are open. Both native and fixed fallback handling retained. |
| Medium | Portrait/live-state refresh reconstructs unchanged document sections, losing disclosure/focus state. | Keyed unchanged section retention and separate hero/document signatures; browser asserts node identity, open disclosure, focus and scroll. |
| Medium | Scanner settings still observe the entire document after startup. | Owner settings notification plus bounded mount retry; no global observer or continuous polling. |

All prior Cycle 1 fixes were reviewed. The complete Node 24 workflow passes 567 tests plus compatibility/runtime/migration smoke, validation (30 modules), prompt capture/measurement and package integrity; final release-metadata recheck follows in Cycle 3. The untouched Node 24 baseline also passes 550 tests after using the required checkout directory name. No baseline test or numerical oracle was changed to hide a defect.

Synthetic Chromium with all actual UI modules passes desktop, tablet, mobile and reduced-height viewports. The complete browser scenario makes zero getState/history-snapshot calls, starts zero scans, preserves newer drafts across delayed flush, and records zero idle dossier DOM mutations over 500 ms at each viewport. These are bounded synthetic observations, not a live latency guarantee. Physical file picker, actual mobile keyboard, real host and Gemini/image providers remain unrun.

Retired code includes the superseded controls module, duplicate supporting-tools portrait manager, whole-state portrait-completion poll, dead Data-menu observer/mount path, hidden legacy export/import UI handlers, and import-based manual appearance/life-state mutations. Public native export/import, native host-image preview/application, canonical compression, old stored-state recovery readers and accepted numeric mechanics remain.

## Cycle 3: final diff, dependencies and async completion

- Medium: the retained runtime Escape listener is capture-phase, so an underlying native viewer could consume Escape before a top-layer tools dialog. It now checks the tools overlay before handling Escape; the registered-handler integration test reproduces the layered case.
- Medium: device upload revalidated before flush but still refreshed/notified the active UI after a delayed flush into a replacement workflow. Completion now revalidates its session after flush and only reports errors in its own active workflow. Browser coverage replaces an in-flight upload dialog with diagnostics and verifies no stale close or toast.
- Maintenance: whole-repository runtime/test caller tracing found three private uncalled functions (`relationshipEvidenceValidForDelta`, `relationshipBand`, `signedScore`), a shadowed source-era `NPC_STATE_VERSION` export and a no-op editor-name branch. These were removed. Actual scorer/evidence algorithms, public facade version, generated prompts and required stored-state readers remain intact.
- Release metadata and current docs are consolidated at application version 1.0.0, with storage/bundle/branch schemas unchanged. Stale Stage 8/9 pending claims and scalar-only form editing instructions are corrected without rewriting provenance/history.

The post-fix Cycle 3 candidate passed the complete Node 24.11.1 workflow: 567 tests, compatibility/runtime/migration smoke, validation, both prompt measurements, package integrity and whitespace checks. The same production request fixtures remain byte-identical to the untouched baseline. No earlier success is used to validate a later tree.

## Cycle 4: final integrated review

The complete final diff and prior fixes were reviewed, including all areas below. No further actionable in-scope defect was found. An additional synthetic production-loop assertion confirms that raw World State survives capture/context processing, updates age from 6 to 7 at the next year, and reaches the actual next roleplay injection while apparent age stays separate. That registered-runtime test passes. Final full workflow and browser verification were repeated before the final commit: 567/567 tests, all three smoke programs, validation, standard and extended prompt measurements, package integrity, and whitespace checks pass on Node 24.11.1. Synthetic Chromium passes all four viewports with no page errors.

The remaining native-editor discovery observer is intentionally retained: it filters added editor nodes, has an installation guard, and returns immediately for an already initialized chat/NPC control. It is needed for host-created popup discovery; it does not poll or clone chat history. The canonical roster-change observer, bounded startup retries, writer/recovery timers and historical-state readers likewise retain demonstrated production callers. None was deleted merely for its name or age.

Review stops after four cycles, not five: all required areas were covered, previous fixes were rereviewed, the integrated checks pass, and no blocking finding remains. No speculative prompt adjustment or artificial extra version was added. Required latest-candidate CI remains the publication gate.

## Integrated coverage and evidence

| Area | Production path / verification |
| --- | --- |
| Capture, routing, cancellation | Existing runtime, current-exchange, scanner-routing, scanner-isolation and swipe tests exercise normal replies, edit/swipe/delete/chat switch, duplicates, abort/timeouts, stale completions, selected/default routes, conditional passes and retries. Additional request capture checks both dispatcher routes. |
| Dossier, evidence and injection | Core, Stage 4 and stages 5-7 regressions retain first encounters, omission/unknown, profile refinement, physical/off-screen presence and accepted identity-first injection. Stage 9 registered-runtime checks exercise raw date capture through actual next injection. |
| Forms, canonical colors, terminal death | Stage 4 model/integration/lifecycle tests plus Stage 9 manual-form and runtime checks cover shared/named/unknown forms, locks, preserved alternate anatomy, corrections, terminal writers and owned rollback. |
| Relationships | Unchanged pinned 41,070-case oracle, relationship-evidence, core, branch and stages 5-7 tests retain caps, fractions, gates, reversals, ties, duplicate/historical evidence, manual correction and recovery. No scorer formula or evidence instruction is changed. |
| Persistence and portability | Identity, hydration, migration, lifecycle, lineage, branch, storage and bundle tests retain owner-qualified files, same-name owners, tombstones, locks, dirty writes and safe recovery. New public-import tests reject complete malformed envelopes before mutation, clear unproven source ownership and retain portraits/forms/fractions/target history. |
| Portraits and diagnostics | Registered runtime controls and browser interactions cover upload/replace/remove, invalid/cancelled decoding, delayed/stale completion, preview vs explicit application, failed durable save and later recovery, unchanged uploaded images/prompts, accurate bounded diagnostics and no hidden scans. |
| UI and internal work | Actual local UI modules in synthetic Chromium verify desktop/tablet/mobile/reduced height, reachable modal controls, Escape ownership, selected/focused/scrolled/open nodes and unsaved edits through async updates. No full-history getState calls or scans occur in the scenario; idle dossier DOM mutations are zero in the measured 500 ms interval. |

## Before / after budget comparison

All characters below are measured with identical fixtures, initial state, settings and code paths. The values are unchanged from baseline to candidate. Character counts and hashes are not provider token usage. System text is included; serialized message counts additionally include the Delta-owned role/content wrappers. Host/provider-added context cannot be measured by this harness.

| Production request | System + user characters, before = after | Serialized messages, before = after | Calls per route, before = after | Output allowance, before = after |
| --- | ---: | ---: | ---: | ---: |
| Routine scanner | 8,487 | 8,807 | 1 | 1,800 |
| Full-window scanner | 8,615 | 8,937 | 1 | 3,200 |
| Refresh | 8,496 | 8,996 | 1 | 3,200 |
| Backfill | 7,272 | 7,634 | 1 | 3,200 |
| Dossier-source import | 5,461 | 5,737 | 1 | 3,200 |
| Focused relationship | 4,108 | 4,280 | 1 | 900 |
| Routine scanner with malformed-response retry | 8,487 then 9,311 | 8,807 then 9,633 | 2 | 1,800 then 5,200 |

The seven scenarios dispatch eight actual mocked requests per route, sixteen across default and selected-profile routes. All captured input hashes and request flags match the baseline. No retry/focused-work budget changes or new automatic model calls are introduced. Existing configured output overrides are retained and tested separately.

The standard scanner fixtures remain 6,886 / 7,791 characters and the standard characterization injection remains 1,637 characters. The additional representative selected-state injection remains 1,839 characters, with identical hash. No model-facing prompt text, schema, evidence condition or context coverage was rewritten. No Delta reasoning/thinking parameter is added or increased; host/profile reasoning settings remain host-owned and unmeasured. Static equivalence does not guarantee identical live latency or extraction.

## Shipping and release preparation

Application metadata is consistently 1.0.0. The shipping JavaScript inventory decreases from 31 to 30 modules and from 1,123,178 to 1,107,035 bytes. The removed runtime file is `dossier-tools-controls.js`; required responsibilities were consolidated into existing owners, not dropped. The package includes only declared runtime modules, CSS, manifest, inventory, LICENSE and README. Development tests, browser artifacts, review records and source bundles are excluded.

The deterministic installable `npc_state_delta-1.0.0.zip` is 289,276 bytes (baseline 292,552). Its SHA-256 is `abe46c82eb80e1acbb47ee27989586cb3704e19e6ed4f298f70812b26079eefa`. The package command verifies exact entry set, CRC, byte identity and module syntax. Storage/bundle/branch schemas, immutable history/provenance and the numerical oracle are unchanged. Existing CI retains the package and reproducible Git source bundle; no new tagging/release pipeline is introduced.

## Remaining verification limits

All data is synthetic. No real SillyTavern chat/database, paid Gemini call, image-provider generation, physical file picker or mobile keyboard was exercised. The browser uses actual UI modules with a synthetic host and representative viewport geometry, not the user's exact host theme/extensions. Real extraction quality, provider usage, latency and live host integration remain unmeasured. The accepted prompt is deliberately unchanged for that reason.

Publication must use this candidate's passing CI, not the baseline's or an earlier fix. Final remote HEAD, required checks, reviews and merge requirements must be checked before an expected-head-guarded merge. Until those steps complete, the local candidate and installable package are prepared but not a merged release.
