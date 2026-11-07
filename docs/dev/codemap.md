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
