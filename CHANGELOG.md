# NPC State Delta changes


## 1.0.14 - 15 September 2026

- Make Important Bond normalization idempotent when older data already contains repeated structural pipes or spaced slash fragments. Canonical dynamics split legacy `;`, extra `|`, and spaced ` / ` separators, discard tiny truncation debris, deduplicate semantically repeated fragments, and render one structural `|` only.
- Deduplicate repeated relation fragments such as `Host / Caretaker / Host / Caretaker` without collapsing legitimate distinct relation labels.
- Make manual Important Bond deletion authoritative over the shared social edge: remove the hidden pair and the counterpart's mirrored structured bond in the same transaction so reconciliation cannot immediately recreate the deleted entry from the reverse dossier.
- Recover counterpart identity from the structured subject prefix even when the rest of an old bond is malformed/truncated, so corrupted entries can still be deleted cleanly.
- Add the reported Mistress Hilde corruption as a repeated-reconciliation regression plus delete -> reconcile -> still-deleted coverage. Scanner prompts, request budgets, relationship scoring, persistence formats, branch recovery and bundle schema remain unchanged.

## 1.0.13 - 15 September 2026

- Make destructive linear recovery exact-boundary only. Delete/edit may restore the requested surviving parent from the rollback journal or an exact checkpoint, but an older checkpoint can never substitute for a missing parent and generic root fallback is forbidden.
- Extend journal recovery to near-tail replacement divergence, so an edited/regenerated latest assistant can reconstruct its exact parent even after that full checkpoint was pruned; keep the rollback head owned by the restored parent until the replacement is rescanned.
- Fail closed for deep edits with multiple retained assistant descendants instead of rewinding and discarding later accepted continuity. Preserve the current canonical dossiers, rebase unsafe recovery ownership, and rescan without replacing the retained suffix.
- Preserve swipe semantics: an exact known sibling restores without another scan; an unseen sibling may restore only its exact parent/root anchor and must then be scanned. No arbitrary ancestor checkpoint is accepted.
- Expand bounded reconciliation diagnostics with requested recovery boundary, affected assistant count, journal/checkpoint availability, rejected older checkpoint/distance, retained-descendant blocking, and rescan requirement. Add the observed 123-message regression where edit divergence 99 previously restored message 3 and collapsed 26 NPCs to one.
- Keep the 8 MB / 2 MB full-checkpoint limits, 256-message journal horizon, scanner prompts/request budgets, relationship scoring, storage schema and native bundle format unchanged.

## 1.0.12 - 14 September 2026

- Run a one-time legacy branch-history compaction on existing sidecars after lineage is proven safe. Retain the current active lineage plus SillyTavern-retained swipe alternatives, and remove unreachable pre-1.0.11 sibling checkpoints, inline-card branch residue and rollback-journal chains that are no longer owned by the live head or a retained checkpoint.
- Defer compaction while a destructive lineage divergence is unresolved, then retry after reconciliation, so cleanup never races delete/edit/swipe recovery. Persist a versioned compaction marker and bounded before/after accounting so each sidecar is compacted at most once per compaction version.
- Harden v4-to-v5 branch migration by mapping legacy checkpoint keys only when they match the active host branch or a swipe SillyTavern still retains, preventing old delete/regenerate siblings from collapsing onto the current v5 key while preserving provable swipe alternatives.
- Raise the aggregate full-checkpoint budget from 2 MB to 8 MB and the single full-checkpoint ceiling from 750 KB to 2 MB. The separate 256-raw-message rollback-journal contract and 12 MB diagnostic target are unchanged.
- Expand Compact Diagnostics with current narrative snapshot size, largest checkpoint size, aggregate/max checkpoint limits and the most recent compaction summary. Scanner prompts, request counts/retries/output allowances, relationship scoring, sidecar format and bundle format remain unchanged.

## 1.0.11 - 14 September 2026

- Treat ordinary message deletion/regeneration and edits as linear history replacement: restore the surviving parent boundary, discard descendant recovery artifacts, and do not retain deleted generations as sibling branches. Preserve sibling checkpoints only for explicit SillyTavern swipe events.
- Advance destructive branch lineage to v5 using narrative role/content only. Mutable host `send_date`, generation ids and swipe indexes can no longer manufacture a destructive divergence; v4 sidecars and explicit v4 parent branches retain guarded compatibility during upgrade.
- Fail closed when a divergence has no proven recovery target: keep the accepted canonical dossier and rebase ownership instead of walking backward to an older checkpoint or branch root. First-message explicit swipes retain their intentional root-anchor behavior.
- Add bounded branch-reconciliation diagnostics with operation/relation/action, recovery source, fail-closed state, NPC counts, checkpoint bytes and rollback-journal pressure, without retaining story text.
- Self-clean malformed Important Bonds: reject sentence-like orphan prose, normalize inverse owner/counterpart relation collisions, deduplicate near-identical dynamics, align incoming social-edge direction to established bonds, and preserve manually locked relationships.
- Add stress coverage for scattered delete/regenerate cycles across 20 live messages under full-checkpoint byte pressure, explicit swipe siblings, v4-to-v5 migration/ancestry, passive unexplained divergence and edit replacement. Scanner prompts, request counts, output allowances and relationship scoring remain unchanged.

## 1.0.10 - 14 September 2026

- Retain the newest accepted unsaved state across transient-to-permanent persistence failure, cache eviction and rehydration until a successful durable flush; preserve cancellation, retirement, ownership and revision guards.
- Keep referenced journal versions immutable during same-message consolidation, including net-zero revisits, and retain required predecessors for branch checkpoints and sibling chains.
- Checkpoint deterministic assistant receipt changes at their own message boundary before scanning, so failed/skipped/busy scans cannot move turn ownership to a later user message.
- Protect explicitly confirmed-dead dossiers from stale archive/deletion even when automatic death archiving is disabled; preserve ordinary living 30/50-turn cleanup.
- Add production-function and synthetic-host regressions, clarify the governing contract, and preserve scanner prompts/budgets, scoring, the 256 raw-message horizon, Speech behavior and persisted formats.

## 1.0.9 - 14 September 2026

- Preserve undurable persistence ownership through bounded chat-cache eviction and rehydration. A snapshot recovered after a permanent sidecar rejection now remains locally pending until a later successful flush instead of being incorrectly promoted to durable.
- Add a production-runtime regression for permanent HTTP 413 rejection -> cache eviction through eight other chats -> same-session rehydration -> pending durability -> successful later flush.
- Preserve all 1.0.8 recovery behavior, scanner prompts, request/retry/output budgets, relationship formulas, bundle schema, sidecar format version and branch-lineage version.

## 1.0.8 - 14 September 2026

- Separate recovery lineage classification from strict asynchronous equality checks. A persisted lineage that is an exact prefix of the live SillyTavern chat is now a non-destructive forward extension and cannot restore an older checkpoint/root dossier.
- Change the active journal contract to a contiguous 256 raw-message horizon from a trustworthy baseline, including unchanged user/system boundaries. Add normal alternating-chat regressions for exact 100-message deletion, repeated 50+50 deletion, the 256-message boundary, and failed-scan deletion across a preceding user turn.
- Coalesce repeated canonical checkpoints owned by the same message and replace whole-social-graph journal copies with changed edge/slot undo records while preserving a reader for v1.0.7 full-graph entries. Stress coverage with 40 NPCs/240 edges keeps journal growth bounded by changed data rather than graph size.
- Preserve the newest locally dirty state after a permanent durable-write rejection in the persistence owner, so bounded chat-cache eviction and later same-session hydration cannot silently replace it with an older sidecar; successful later persistence or explicit cancellation clears that recovery shadow.
- Complete stale-removal cleanup by purging owned structured relationship references and delaying portrait-asset garbage collection until checkpoints/journal history can no longer restore the removed NPC.
- Compact active sidecar JSON and build base64 input from chunks instead of repeated giant-string concatenation. Persisted data-file format version, bundle schema and branch-lineage version remain unchanged.
- Preserve scanner prompts, request/retry/output budgets, connection-profile routing, numerical relationship formulas, Speech-development semantics and RP injection. No additional model request or background worker is introduced.

## 1.0.7 - 13 September 2026

- Add a bounded reversible rollback journal beside the existing byte-bounded full branch checkpoints. Journal entries store compact canonical-state undo deltas plus exact lineage/sequence ownership, not transcript text or portrait binaries.
- Make large tail deletion independent of whether the exact surviving full checkpoint remains inside the 2 MB snapshot budget. The active journal can walk backward deterministically through recent mutations and marks the restore exact without another scanner/model request.
- Cover structural rollback as well as scalar fields: NPCs first introduced only in deleted history disappear, downstream social edges/key-relationship references, candidates and pending backfills are cleaned up, while surviving NPC memories, relationship state, appearance/lifecycle and Speech-development evidence return to their earlier values.
- Preserve existing user-owned metadata overlay rules during rollback. A manual portrait/profile override on a surviving NPC remains, but user metadata cannot resurrect an NPC whose narrative existence was rolled away.
- If a scanner fails before its normal checkpoint, immediate tail deletion restores from the prior journal head and the next assistant parent-anchor settles the surviving uncheckpointed turn before advancing. Keep full checkpoints for swipe/sibling/recovery safety and record each checkpoint's journal sequence for branch rebasing.
- Bound the journal to 1,024 recent mutation entries with a contiguous active-history priority and a 12 MB soft budget while retaining at least 384 active entries. Add regressions for an exact 100-message tail deletion after the full-checkpoint target is pruned, plus two successive 50-message deletion batches. Scanner prompts, request counts/retries, relationship formulas, bundle schema and branch-lineage version are unchanged.
- Existing pre-1.0.7 histories establish their journal baseline when loaded; the new journal cannot reconstruct full snapshots that an older build had already discarded before upgrade.

## 1.0.6 - 13 September 2026

- Add a bounded deterministic Speech development ledger inside each canonical NPC record, tracking up to four pending speech concepts with recent turn/source-message provenance rather than retaining transcript history.
- Let three independent observations of the same stable speech concept across a minimum turn span authorize gradual Speech evolution, while replay of the same source message cannot advance the counter and unrelated concepts cannot combine.
- Preserve existing grounded `explicit` and `batch` Speech evolution. When a full Speech replacement is accepted, clear old speech profile evidence and begin a new speech epoch so pre-change observations cannot resurrect obsolete habits.
- Keep a bare time skip non-destructive: without grounded speech development, current Speech and pending evidence remain unchanged. A manual/unlocked Speech baseline change also clears stale pending concepts before later scans.
- Preserve manual Speech locks, native bundle/checkpoint ownership, scanner prompt bytes, request/retry counts, output allowances, numerical relationship formulas and persisted format versions. Add regressions for replay rejection, concept isolation, gradual thresholding, batch reset, bare-time-skip preservation, manual baseline reset and bundle round-trip.

## 1.0.5 - 13 September 2026

- Make manual Key Relationships / Important Bond edits authoritative over the edited NPC's hidden social-graph direction instead of enriching a stale graph edge and projecting old prose back into the dossier.
- Preserve a compatible reverse-side relationship/dynamic for the counterpart while replacing the manually edited owner-side relation and dynamic exactly.
- Normalize `Name — relation; dynamic` into the canonical `Name — relation | dynamic` shape when the relation prefix is a recognized social relation.
- Remove an unstructured orphan line when its full text is already contained in a structured bond entry, preventing duplicated dynamic-only lines from surviving canonicalization.
- Add focused regressions for the demonstrated Ryu/Sora duplicate-line case, same-counterpart manual rewrite, and reverse-side preservation. Scanner prompts, request counts, relationship scoring formulas, persistence formats and bundle schemas are unchanged.

## 1.0.4 - 13 September 2026

- Give direct per-NPC Refresh the same Stage 4 appearance-form output contract already used by the accepted appearance model, including `overallAppearance`, `appearanceForms`, `currentForm` and `currentFormState`.
- Carry the selected NPC's established appearance-form context into Refresh reconciliation and explicitly treat natural anatomical transitions as current-presentation/form evidence even when narration never says `form` or `transform`.
- Preserve alternate anatomy when Refresh observes a visibly different presentation without a stable form name by routing it through the existing unclassified-current presentation instead of overwriting the prior form.
- Keep Refresh strictly one-NPC and one-request: no extra scanner call, completeness pass, relationship scoring change, retry-budget change, persistence owner, or bundle-schema change.
- Add focused regressions for the demonstrated horn/wing/tail disappearance path and preservation of the prior chimeric presentation.

## 1.0.3 - 13 September 2026

- Make Stage 4 appearance-form fields part of the detailed routine scanner return contract instead of relying only on an appended side instruction.
- Recognize grounded implicit anatomical transformations such as horns, wings, tails, plumage, scales, talons or ears visibly dissolving, retracting, appearing, growing or otherwise changing even when narration never says `form` or `transform`.
- Preserve established alternate forms and route visibly different but unnamed presentations through the existing unclassified-current-form path instead of overwriting unrelated anatomy or inventing a stable form name.
- Keep ordinary scans compact: the expanded form schema is added only when existing form/lifecycle state or an explicit/implicit transformation signal requires detailed Stage 4 handling.
- Prevent large audit-only source history from blocking native backup. Full audit history is attempted first; if it exceeds the existing 2 MB manifest or 32 MB total envelope budget, Delta writes a compact truncation summary and, only if necessary, omits audit history while preserving canonical dossiers, portraits and portable settings.
- Add focused regressions for natural-language anatomical transitions and oversized-history native export without changing relationship formulas, scanner request counts, retries, persistence ownership or bundle schema version.

## 1.0.2 - 12 September 2026

- Add a Birthday field to Edit Dossier so generated or story-established dates can be corrected manually without editing extension JSON.
- Validate manual birthday changes against the active calendar and route accepted corrections through the canonical birthday continuity engine without an extra model request; manual corrections clear story-message provenance.
- Keep scanner prompt semantics, automatic scan routing, request counts, retry budgets and relationship behavior unchanged.

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
