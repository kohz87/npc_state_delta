# Stage 8 supporting tools review

Status: Stage 8 implementation candidate. Deterministic repository CI is the acceptance gate. Real SillyTavern browser/image-provider acceptance remains a separate live-host check.

## Scope

Stage 8 adds supporting tools only. It does not change scanner routing, relationship scoring, evidence rules, terminal-death policy, OOC removal, or Stage 9 prompt optimization.

The implementation is split into three semantic owners:

- `dossier-tools.js`: dossier-facing portrait/data/diagnostic UI. It is a projection/controller over the existing `NPCStateDelta` public API, not another state store.
- `dossier-tools-core.js`: bounded UI/session/diagnostic primitives, stale-operation checks, and durable-flush reporting.
- `native-transfer.js`: a small envelope around the existing `bundle.js` binary codec. It does not replace the canonical importer or create a cross-generation converter.

`bootstrap.js` loads the supporting tools after the Stage 1 dossier UI. `runtime-modules.json` declares all three modules so validation and packaging use the same active-runtime inventory.

## Portrait workflow

The primary dossier surface now exposes **Portrait** beside the selected NPC. The workflow supports:

- device upload and replacement through the inherited `.npc-state-delta-inline-portrait-file` handler, so existing validation/compression/canonical mutation remains the owner;
- portrait removal through the inherited removal handler without deleting or changing the dossier;
- editable positive/negative prompts, independent copy controls, and explicit **Rebuild from dossier**;
- preview generation through the existing `NPCStateDelta.generatePortraitUrl()` host Image Generation route, never the scanner connection profile;
- explicit **Apply preview**, which downloads the chosen preview then hands it to the same canonical upload/compression path used by device images;
- separate local-application versus durable-save reporting by awaiting `NPCStateDelta.flush()` after mutation;
- dossier/cast refresh through the existing Stage 1 controller rather than rebuilding unrelated UI.

Prompt text is initialized by `NPCStateDelta.portraitPrompts()`, which already routes through the Stage 4 shared appearance resolver. That resolver preserves selected-form anatomy and the accepted current appearance used by dossier display and roleplay injection. Stage 8 does not introduce automatic portrait replacement, per-form portrait switching, a portrait gallery, or scanner-routed image generation.

Edited prompt text is retained in the bounded Stage 8 workflow draft cache for the current browser session. It is never silently rebuilt when dossier appearance changes; rebuilding is an explicit user action. The existing persistent per-NPC portrait prompt fields remain editable in the native dossier editor and are inputs to the resolved prompt builder.

### Ownership and stale work

Each portrait workflow is bound to active chat + NPC + session/action sequence. Generation results are ignored if the chat changes, the NPC disappears, the workflow is replaced/closed, or a newer generation supersedes the result. Generation creates a preview only.

Device upload enters the inherited canonical handler only after a file is chosen. Cancelled file selection performs no mutation. Once an upload or explicit preview application has been handed to that handler, Stage 8 disables workflow closing until the inherited mutation completes; this avoids pretending that an already-started canonical mutation can be cancelled. Generated-preview fetch is still cancelable before that handoff.

A failed decode/compression leaves the prior portrait intact because the inherited handler mutates only after successful processing. A failed durable flush is reported as a local-only mutation and is never advertised as saved.

## Native Delta import/export

The native file remains the established versioned `npc_state_delta_bundle` format, version `1`, with the same `NPCSTB01` binary signature, canonical dossier/social/dismissed state, and embedded portrait binaries. Stage 8 adds optional manifest declarations without changing the codec identity:

- `declaredContents`
- `portableSettings`
- `historyArchive`

`portableSettings` is limited to portrait-generation settings. Scanner profile, general extension enablement, scoring settings, storage pointers, credentials, and connection/provider state are not portable.

`historyArchive` contains source lineage/checkpoints/branch-root/inline-card history for audit. Portrait binary payloads are not duplicated inside history snapshots. The source history is deliberately **not replayed into a target chat** because source message ownership is not portable. Import retains the target's existing lineage/checkpoints and current history baseline. When source and target chat identities differ, source message ownership fields in imported dossiers are cleared before calling the canonical importer. Relationship values, signed fractional progress, milestones/reasons, appearance forms, terminal-death state, dossier history fields, social state, and portrait assets remain part of accepted dossier state.

This is the contract's safe-baseline policy: preserve source history contents in the native file for inspection/audit, but never invent target provenance by copying source message IDs onto another chat.

Before mutation, Stage 8 validates the canonical signature/version/manifest, duplicate dossier IDs, portrait binary ranges/overlap, declared metadata shape, total file bounds, and target availability. Foreign Alpha/Beta/legacy formats are rejected; no converter is provided. The canonical `NPCStateDelta.importBytes()` owner performs dossier reconciliation and checkpoint/persistence integration only after that validation succeeds.

Import review makes effects explicit: matching dossiers are reconciled, unmatched imported dossiers may be added subject to the active roster cap, unrelated target dossiers remain, portraits travel with accepted dossiers, optional portable portrait settings are separately opt-in, and target chat history ownership is retained.

## Diagnostics

Diagnostics are separate from ordinary dossier reading and do not trigger scans. The surface shows only runtime data already available or bounded Stage 8 events:

- actual dispatcher request aggregates and current in-flight count;
- default versus selected-profile route counts;
- succeeded/failed/rejected/timed-out/cancelled counts;
- latest request route/outcome;
- latest scan retry/focused-relationship flags;
- latest prompt/response character-derived token estimates, explicitly labelled as estimates rather than provider usage;
- relationship signed fractional progress plus a derived milestone/gate audit for the selected NPC;
- Stage 8 durable-flush failures and local-versus-durable outcomes;
- a bounded recent Stage 8 event list.

The inherited runtime does not expose a global pending-write counter or an exact historical per-label request breakdown. Stage 8 therefore does **not** fabricate those values. It reports the dispatcher aggregate as the authoritative actual request total, the latest scan's retry/focused flags, and its own in-progress/flush state. No credentials, full private prompts, or provider responses are recorded.

## UI and responsive behavior

The Stage 1 dossier keeps selection/search/filter/scroll ownership. Stage 8 injects only:

- **Portrait** for the selected dossier;
- **Data** for native import/export;
- **Diagnostics** for the separate diagnostic surface.

Stage 8 dialogs use `100dvh`, safe-area insets, sticky mobile footers, bounded internal scrolling, and >=44 px touch controls. The workflow does not rebuild unchanged dossier content; affected portrait/cast data is refreshed through the existing Stage 1 scheduler.

## Verification boundary

Focused synthetic tests cover native envelope round trips, embedded portraits, portable settings, audit-history stripping of duplicate portrait payloads, cross-chat ownership clearing, relationship fractions, terminal death, malformed/foreign input rejection, bounded/sensitive-data-free diagnostics, image validation, and stale portrait ownership guards.

Existing Stage 4 tests remain the authority for resolved appearance, selected-form anatomy, and roleplay/portrait agreement. Existing bundle/import tests remain the authority for canonical identity/capacity/portrait/import mutation behavior. Stage 8 tests add the native envelope and workflow-specific safety layer without replacing those suites.

Real browser checks still required after deterministic acceptance:

- desktop/tablet/mobile visual layout and keyboard/browser-chrome reachability;
- actual device file picker and touch scrolling;
- native SillyTavern Image Generation preview/application;
- update arrival while a user is editing/managing a portrait;
- visual cast-thumbnail refresh and open-panel rendering behavior.

These live checks must not be inferred from synthetic CI.
