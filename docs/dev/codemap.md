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
