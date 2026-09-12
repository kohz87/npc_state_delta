# NPC State Delta changes


## 1.0.1 - 12 September 2026

- Require a grounded apparent-age result for new dossier-worthy NPCs whenever the scan has an explicit visual-age cue, while preserving chronological age as a separate field.
- Recover a missing apparent age deterministically from grounded appearance wording such as `young`, `middle-aged`, `elderly`, `24-year-old`, or `early thirties`; never infer it from species or lifespan.
- Keep the routine scanner prompt at the same character count and preserve request counts, output allowances, reasoning ownership, injection size, and all non-age scanner semantics.

## 1.0.0 - 12 September 2026

- Consolidate portrait upload/removal into scoped canonical operations; remove the duplicate supporting-tools portrait manager and superseded controls module, including whole-state completion polling.
- Correct locked appearance-form switching and explicitly empty unknown presentation without overwriting alternate anatomy, colors or unrelated dossier fields.
- Apply appearance edits directly through the canonical owner, retaining editor/chat ownership and distinguishing local changes from durable saves.
- Preserve birthday/aging integration after UI-noise stripping, correct mixed structured-date ordering and leap-year birthday comparison, and retain manual age and terminal-death protections.
- Validate native dossier shapes before import and remove source-message ownership when the target chat is unproven, including birthday and death-correction provenance.
- Replace repeated UI history copies with selected-record/lightweight projection reads and owner notifications; simplify history audit copying.
- Keep diagnostic records bounded and free of exception payloads; report actual current-chat pending writes instead of a placeholder metric.
- Surface permanent persistence rejection without endless retries while retaining dirty data, transient retry behavior, writer locking and later recovery.
- Keep retained host-image generation preview-only until explicit application; reject canceled, superseded and stale decode/generation results, and leave newer dialogs untouched.
- Apply manual life-state changes through the canonical owner without closing the editor, replaying a bundle, or overwriting newer input.
- Preserve unchanged dossier sections, disclosure state, focus and scroll during portrait and live-state refreshes; fix clipped cast cards, capped editor footers, hidden fields and top-dialog Escape handling.
- Validate the complete native envelope in the public importer as well as the UI, bound nesting and unsafe object metadata, and report actual added/updated/skipped counts.
- Prepare coherent Delta 1.0.0 application metadata and the existing deterministic installable ZIP without changing storage, bundle or branch schemas.
- Remove three uncalled internal evidence/display helpers, a shadowed source-era version export and a no-op editor branch after tracing runtime/test callers.
- Preserve the working scanner prompt and all measured request bytes, output allowances, reasoning ownership and automatic request counts.

## Stage 8 supporting tools - 12 September 2026

- Add the primary dossier Portrait workflow with device upload/replacement, removal, editable/copyable positive/negative prompts, explicit dossier rebuild, host Image Generation preview, and explicit preview application through the retained portrait upload/compression path.
- Bind asynchronous portrait work to chat/NPC/session/action ownership; reject stale generation, preserve the prior portrait on cancellation/failed decoding/generation, and report local mutation separately from durable flush success.
- Extend the existing versioned Delta native bundle with declared portable portrait settings and source-history audit metadata while retaining `bundle.js` as the canonical codec/import merge. Cross-chat import clears source message ownership and keeps target lineage/checkpoints as the safe baseline; no Alpha/Beta/legacy converter is added.
- Add compact diagnostics for actual dispatcher aggregates/routes/failures, latest retry/focused-pass state, labelled prompt estimates, relationship signed fractions/gate audit, and bounded Stage 8 persistence/workflow events without credentials or full private prompts/responses.
- Add safe-area/dynamic-viewport responsive dialogs with touch targets and bounded scrolling, and refresh only affected dossier/cast projections through the existing Stage 1 controller.
- Add focused synthetic Stage 8 regressions and `docs/stage8-supporting-tools.md`; exact-candidate CI is the deterministic acceptance gate because the continuation environment cannot resolve GitHub for a conventional local checkout. Real SillyTavern/file-picker/Image Generation/desktop-tablet-mobile visual acceptance remains unrun.

## Stages 5-7 relationship, evidence and recovery review - 12 September 2026

- Preserve the pinned numerical scorer, including signed diminishing returns, fractions, gates, configured-cap minima and tied-axis rejection. Add a hash-verified upstream result oracle covering 41,070 cases and end-to-end repeat/persistence/rollback tests.
- Block focused relationship evaluation/application for confirmed-dead NPCs even when death archiving is disabled. Let a valid zero focused decision initialize an empty relationship description without inventing an event or rewriting an established description.
- Move resolved appearance into the existing optional injection budget after essential identity and agency; remove duplicate relevance selection and post-assembly slicing from the Stage 4 adapter.
- Remove the OOC text-command parser, stripper, dispatcher/API, edit hooks, command-only prompt mode/help/bookkeeping and obsolete parser tests. Retain production manual controls, structured add/remove helpers, ordinary backfills and lineage maintenance.
- Protect terminal state after Refresh/backfill live-field restoration and before checkpoint creation. Enable explicit manual erroneous-death correction for unarchived dead records and clarify the editor/confirmation label.
- Retain storage, locks, revisions, dirty retries, owner isolation, tombstones, recovery readers and branch algorithms. No cross-generation import/export change or real database operation.
- Verification: 495 unit tests plus compatibility/runtime/migration smoke checks, validation, prompt measurements, packaging and diff check passed locally. Exact-commit CI remains the publication gate; live browser/provider checks are unrun. See `docs/stages5-7-review.md`.

## Stage 4 appearance and terminal lifecycle - 12 September 2026

- Add bounded named appearance forms and current-form selection while preserving earlier flat appearance as a safe `Base` compatibility form.
- Add one resolved-current-appearance path for dossier presentation, portrait prompts and roleplay injection, including protection against cross-form anatomy leakage and unidentified transformations.
- Extend scanner/Refresh/backfill/import prompts and profile locks to understand form-independent overall appearance, named forms and current form without erasing omitted forms; normalize the resolved current view back into canonical `appearance` so the existing dossier stays consistent without a second editor/state authority.
- Make explicit confirmed death terminal to automatic scanner, Refresh, retained backfill and structured-source updates; dead NPCs cannot regain presence/world activity from narrative resurrection.
- Preserve manual/stale reactivation for living dossiers, retained dead history/relationships/portraits, explicit player correction for erroneous death, and owned-history rollback.
- Add Stage 4 regression coverage for flat upgrade, form switching/refinement, clothing-only changes, locks, unknown forms, portrait/injection agreement, terminal death, explicit correction and automatic-writer presence guards.
- Review/fix pass hardens alias consolidation, bundle-import terminal death, unidentified-form anatomy isolation, current-form portrait anatomy, and budgeted roleplay appearance injection without changing relationship formulas.
- Final Stage 4 review fixes unnamed-form normalization so form-independent appearance is never duplicated across repeated loads; the retained editor's manually locked Appearance field edits the selected current form rather than creating a second authority.
- Treat deliberate manual Restore of a confirmed-dead dossier as explicit erroneous-death correction, retain correction provenance, and keep the corrected NPC off-screen until story evidence establishes presence again; automatic narrative/structured writers still cannot revive it.
- Full deterministic verification after the final review: 488 unit tests plus compatibility/runtime/migration smoke checks, validation, prompt measurement, package verification, and diff check; real SillyTavern/provider acceptance remains separate.

## Stage 3 scanner routing - 12 September 2026

- Add one selectable scanner connection-profile setting and shared request-scoped dispatcher for retained NPC model requests.
- Keep the empty/default route on the existing host generation path; explicit profile failures are surfaced without silent fallback and do not redirect roleplay or portrait generation.
- Cover automatic/manual scans, Refresh, focused relationships, retries, structured import and retained backfills, including timeout/cancellation and stale-result rejection.
- Restore the omitted `scan-context.js` runtime dependency after the initial Stage 3 merge and add it to the canonical runtime inventory; the post-hotfix main CI passed.
- Follow-up review moves redundant automatic backfill suppression ahead of the shared dispatcher and removes the inherited `full-cast.js` `generateRaw` monkey-patch, preserving identical default/selected-profile routing and manual repair access. Validation now rejects runtime bypasses of `scanner-routing.js`.

## Stage 2 active-runtime normalization - 11 September 2026

- Classify every implementation module executed by Delta as active Delta code regardless of source ancestry.
- Add `runtime-modules.json` as the canonical machine-readable inventory for every shipped top-level JavaScript module and its semantic role.
- Normalize the active mechanics and branch primitive paths to `core-mechanics.js` and `branch-core.js`; remove the old source-version-labelled runtime paths.
- Make validation require an exact one-to-one match between the active inventory and root runtime JavaScript, and reject legacy/version-labelled active paths or dependencies.
- Build packages from the same active inventory instead of a root wildcard so undeclared residue cannot silently enter a release archive.
- Drive CI syntax and release-consistency checks from the same inventory, and rename source-version-labelled safety test filenames to their current responsibilities.
- Keep historical source names/versions only in Git history, `docs/history/`, provenance records, and historical-shape fixture data where the old identifier itself is evidence. Required historical-shape readers remain active Delta compatibility logic inside current owners, not a separate runtime layer.
- Preserve scanner behavior, relationship formulas, persistence/recovery semantics, lifecycle policy, and roleplay injection while performing this structural normalization.

## Stage 2 consolidation / Delta v0.1.0 - 11 September 2026

- Establish `0.1.0` as NPC State Delta's own application-version baseline in the manifest, core facade and package metadata. Persisted bundle, branch, and data schema versions remain independent.
- Replace the broad `enhancements.js` layer with a dedicated `full-cast.js` owner that preserves the opt-in full-cast scan and redundant-backfill guard.
- Remove the superseded secondary Dossier Library overlay now that Stage 1 owns the dossier/cast presentation surface.
- Update bootstrap, validation, package naming and focused tests around the consolidated owner boundaries.
- Keep scanner semantics, persistence/recovery, relationship mechanics, evidence/injection behavior and later-stage contracts unchanged.

## Stage 1 tablet cast rail fix - 11 September 2026

- Keep the cast search field and lifecycle filters on one row for tablet widths so they do not consume most of the fixed cast rail height.
- Reserve enough vertical space for complete dossier cards on tablet and phone layouts instead of clipping the portrait/status row at the bottom edge.
- Add a small minimum bottom inset in touch layouts even when the browser reports no safe-area inset, while retaining horizontal cast scrolling.
- Keep the change presentation-only; scanner, state, persistence, relationship mechanics, and later stages are unchanged.

## Stage 1 compact launcher and mobile viewport fix - 11 September 2026

- Restyle the floating launcher as a 48px rounded-square stacked `npc` / `state` wordmark inspired by the supplied icon, keeping the full button as the touch/drag target and avoiding a large raster asset.
- Keep the compact launcher on desktop, tablet, and mobile; retain drag-and-persist positioning and the safe-area-aware side-midpoint default on narrower screens.
- On tablet/mobile widths, remove the centered `top: 50%` dossier transform and pin the dossier to the top-left of the dynamic viewport so the header cannot be shifted off-screen.
- Make the dossier top bar sticky and the Close control at least 44x44px on touch layouts, with safe-area padding for notches and browser chrome.
- Keep the change presentation-only: scanner, state, persistence, relationship mechanics, and later stages are untouched.

## Stage 1 mobile and overlay fixes - 11 September 2026

- Promote the movable dossier launcher to a top-level floating control so SillyTavern mobile/tablet stacking and nested extension layout cannot bury it.
- Use a compact 48px launcher icon at the right-side midpoint on phone/tablet widths, away from the bottom composer, while retaining drag-and-persist positioning.
- Replace the visual-only overlay shadow with a real clickable backdrop so clicking outside the dossier closes it.
- Remove the duplicate Edit button from the dossier document header while retaining the primary Edit dossier action beside the portrait.
- Keep NPC State Delta settings exclusively under SillyTavern Extensions.

## Stage 1 launcher refinement - 11 September 2026

- Make the side dossier launcher draggable with mouse, pen, or touch while preserving normal click-to-open behavior.
- Persist only the launcher's UI coordinates locally and clamp restored positions inside the current viewport after resize/orientation changes.
- Remove launcher-panel Settings access; NPC State Delta settings remain under SillyTavern's Extensions settings surface.
- Remove the Stage 1 root stacking context that could trap the fixed launcher below SillyTavern mobile chrome.
- Force mobile launcher visibility and add safe-area-aware default right/bottom offsets for notched/home-indicator devices.

## Stage 1 dossier UI - 11 September 2026

- Add a persistent side launcher that opens a centered portrait-led dossier surface without changing the canonical Delta scanner, persistence, or relationship behavior.
- Adapt the useful donor presentation ideas into Delta-local code: selected portrait hero, readable dossier document, searchable horizontal cast rail, and active/archived/dead filters.
- Project canonical Delta NPC state into bounded UI records so relationship/event histories and branch snapshots are not rendered or retained by the view layer.
- Route editing through the existing `NPCStateDelta.openEditor` owner and keep settings owned by the existing Delta Extensions settings surface rather than creating duplicate mutation/settings paths.
- Preserve search state, selection, cast/document scroll, focused cast selection, and external editor drafts while canonical state notifications refresh the open view.
- Add focused Stage 1 tests for lifecycle filtering, search, selection retention, projection boundaries, no-chat behavior, editor/settings ownership, and bootstrap reachability.

Real-browser visual/performance QA remains a host acceptance check; deterministic HTML/model tests are not treated as visual evidence.

## Source seed - 11 September 2026

- Seed the exact source snapshot from `kohz87/npc_state` at `a12b2937b5c1305e3e3017218a626478a5bedcdc`.
- Apply Delta identity isolation to runtime/CSS and inherited tests while initially preserving source algorithms and version markers for reproducible comparison.
- Preserve the existing GPL license and record all source paths/blob hashes.
- Add the core contract, agent instructions, nine-stage workplan and verification/package tooling.
- Move upstream markdown into historical reference documentation.

No work stages 1-9 were implemented in the original seed. Upstream release history is retained in `docs/history/`.
