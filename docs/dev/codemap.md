# NPC State Delta Source Codemap

This map covers `src/` files not already named by path or `.js` file name in the repository guides.
Files already mapped elsewhere are listed in `CLAUDE.md`, `AI-README.md`, `README.md`, and `docs/**/*.md`; this map does not repeat them.
Generated 2026-11-07.

## src/
- `src/card-settings.js`: Character-card offers for portrait prompt format and scan cadence, applied through Delta's existing savers.
- `src/npc-meters-config.js`: NPC-meter limits and parsers for keys, bands, needs, rungs, settings, meter definitions and stages.
- `src/npc-meters-schema.js`: NPC-meter setting defaults and the Story Suite schema for Delta's hosted settings fold.
- `src/npc-meters-secrets.js`: Hidden-note normalization and IDs, generated notes, and secret/limit line conversion for the editor.
- `src/npc-meters-slice.js`: Per-reply NPC slice, key-person absence and cast memory, validation, meter moves and stage settling.

## src/adapter/
- `src/adapter/cast-ui.js`: Dossiers drawer, settings, list, cast cards/meters, page API, preset block, key pin and reply-time cast sync.
- `src/adapter/connect.js`: Finds a Story Block v2 host, registers Delta, watches it, and restores unhosted behavior when it leaves.
- `src/adapter/editor.js`: Hosted dossier-editor controls for meters, milestones and hidden notes, plus setup reads and watched story events.
- `src/adapter/queries.js`: Read-only NPC/dossier query helpers, portrait URLs, host and Story Director lookups, and commands Delta sends.
- `src/adapter/timeline.js`: Story Block module definition, restore participant, story-clock link, own prompt keys, diagnostics and host events.

## Split files
- `core-record-shared.js`: Admission/portrait constants, cast-appearance preservation, appearance canon, stored-memory normalization, label matching and citation stripping split from `core-record.js`.
- `core-record-scan.js`: Scan-row normalization, candidate records, admission/promotion and candidate matching split from `core-record.js`.
- `core-record-custom-fields.js`: Custom-field parsing, value projection and grounded merge split from `core-record.js`.
- `core-record-merge.js`: Label/place matching, list and Important Memory merging, and durable-text acceptance split from `core-record.js`.
- `core-prompts-criteria.js`: Default scanner criteria, relationship stripping, payload preparation, prompt-name flattening and rubric compaction split from `core-prompts.js`.
- `core-prompts-relationship.js`: The focused relationship-pass prompt split from `core-prompts.js`.
- `core-prompts-select.js`: Scene-present focus, bounded context assembly and mention scoring split from `core-prompts.js`.
- `core-prompts-targeted.js`: Output caps/return shapes plus backfill, dossier-import and profile-refresh prompts split from `core-prompts.js`.
- `core-prompts-capture.js`: One-pass capture rules and hidden-note prompt fragments split from `core-prompts.js`.
- `core-prompts-scanner.js`: Scanner context assembly and `buildScannerPrompt` split from `core-prompts.js`.
- `src/npc-meters-commands.js`: Story-line capture, milestone intake and the hosted npc command handlers split from `src/npc-meters.js`.
- `src/npc-meters-queries.js`: Read-only npc meter/cast/next/social queries and their screen views split from `src/npc-meters.js`.
- `src/npc-meters-prompt.js`: The NPC meter prompt line, reminder tail and locked-note redaction split from `src/npc-meters.js`.
- `src/adapter/queries-dossier.js`: Dossier field copies and portrait URL safety helpers split from `src/adapter/queries.js`.
- `src/adapter/queries-director.js`: Story Director and pack lookups split from `src/adapter/queries.js`.
- `src/adapter/cast-ui/cast-render.js`: Action binding, key-person pin, present-cast and dossier-list rendering.
- `src/adapter/cast-ui/cast-views.js`: Game-view Cast screen registry, tab ownership check, widget and screen definitions.
- `src/adapter/cast-ui/dom.js`: Text-only DOM helpers, shared pane/drawer constants and the meter bar node.
- `src/adapter/cast-ui/dossier-list.js`: Dossier rows, search filtering, key marks, row meters and cast meter entries.
- `src/adapter/cast-ui/drawer.js`: Hosted drawer panel hide/show and display restoration.
- `src/adapter/cast-ui/page-api.js`: Story Director World page API rendering, slots and change subscriptions.
- `src/adapter/cast-ui/presets.js`: Meter-presets settings block and preset setting writes.
- `src/adapter/cast-ui/section.js`: Hosted settings section mount/unmount, placeholder and preset lead handling.
- `src/adapter/cast-ui/turn.js`: Per-reply npc.tick decision, cast sync and portrait backfill.
- `src/adapter/cast-ui/watchers.js`: Page API subscriber set and change notification.
- `src/storysuite-participant/participant/handlers.js`: Participant checkpoint, prepare, activate, abort, status and death callbacks.
- `src/storysuite-participant/participant/publication.js`: Native-change pairing, publication, retry and flush.
- `src/storysuite-participant/participant/session-ops.js`: Session hydration, checkpoints, identity lines and commit-probe comparisons.
- `src/storysuite-participant/participant/support.js`: Shared participant envelopes, prepared ids and index normalization.
- `branch-constants.js`: Branch lineage, snapshot and rollback-journal limits split from `branch.js`.
- `branch-lineage.js`: Message fingerprints, lineage keys and hidden-message key repair split from `branch.js`.
- `branch-util.js`: Byte-size, JSON-equality and NPC-list cloning helpers split from `branch.js`.
- `branch-rollback-undo.js`: Incremental dossier, social-graph and scalar undo records split from `branch.js`.
- `branch-rollback-journal.js`: Rollback-journal normalization, retention, baseline and mutation settlement split from `branch.js`.
- `branch-checkpoints.js`: Full branch checkpoint normalization, retention budgets, parent anchors and recording split from `branch.js`.
- `branch-recovery.js`: Dismissal, message-position, checkpoint-matching and linear restore helpers split from `branch.js`.
- `branch-delete-recovery.js`: Deleted-block NPC reversion, social-graph undo and cleanup split from `branch.js`.
- `branch-reconcile.js`: `reconcileBranchState` and its exact journal/checkpoint recovery split from `branch.js`.
- `branch-ancestry.js`: Cross-chat `bestAncestorState` and explicit-parent matching split from `branch.js`.
- `dossier-ui-catalog.js`: Index filtering, selection, key/cast projections and dossier-state shaping split from `dossier-ui.js`.
- `dossier-ui-constants.js`: Dossier root, settings, style and observer constants shared by the split UI modules.
- `dossier-ui-controller.js`: Dossier controller actions, refresh orchestration, editor and settings bridges split from `dossier-ui.js`.
- `dossier-ui-html.js`: Escaped dossier markup, cards, appearance forms, portrait references and section helpers split from `dossier-ui.js`.
- `dossier-ui-meters.js`: Hosted meter bars, rank, milestones and Secrets-section projections and markup split from `dossier-ui.js`.
- `dossier-ui-model.js`: Dossier record lookups, change stamps and index/detail projections split from `dossier-ui.js`.
- `dossier-ui-mount.js`: Singleton dossier UI mounting and open-dossier request forwarding split from `dossier-ui.js`.
- `dossier-ui-panel.js`: Dossier panel lifecycle, shell, events, observers and portrait lightbox split from `dossier-ui.js`.
- `dossier-ui-relationship.js`: Relationship meter steps, latest change and history markup split from `dossier-ui.js`.
- `dossier-ui-render.js`: Cast rail, filters and selected-dossier rendering split from `dossier-ui.js`.
- `dossier-ui-styles.js`: The dossier panel's scoped stylesheet split from `dossier-ui.js`.
- `social-primitives.js`: Shared social-graph limits plus text normalization and similarity helpers split from `social.js`.
- `social-relations.js`: Relation families, inverse/sanitization rules and shared relation parsing split from `social.js`.
- `social-bonds.js`: Important-bond parsing, compaction and display formatting split from `social.js`.
- `social-graph.js`: Social graph shapes, normalization, edge merging and reference resolution split from `social.js`.
- `social-scan.js`: Scanner social edges and canonical relationship alignment split from `social.js`.
- `social-facts.js`: Explicit unnamed social facts and unresolved graph slots split from `social.js`.
- `social-inference.js`: Shared-parent sibling inference and its suppression rules split from `social.js`.
- `social-projection.js`: Projection of the social graph into Important Bonds and id remapping split from `social.js`.
- `social-manual.js`: Manual Important Bond edits, mirrored updates and repair split from `social.js`.
- `runtime-entry-events.js`: SillyTavern generation, reply, branch, chat lifecycle and deletion listeners split from `index.js`.
- `runtime-entry-ui-events.js`: Present-card activation, closest-target lookup and launcher-dossier event bridge split from `index.js`.
- `runtime-entry-card-settings.js`: Character-card settings definition and panel-equivalent saves split from `index.js`.
- `runtime-entry-startup.js`: Idempotent runtime initialization functions split from `index.js`.
- `runtime-entry-public-read.js`: Public scan, portrait, status and diagnostics API split from `index.js`.
- `runtime-entry-public-write.js`: Public state, host-integration and manual-mutation API split from `index.js`.
