# Delta seed provenance

## Source and identity

- Source: `kohz87/npc_state`, commit `a12b2937b5c1305e3e3017218a626478a5bedcdc`, directory `legacy/v0.2.x`.
- Source manifest version: `0.2.23`; retained core engine: `0.2.18`.
- Destination initial main: `744faae8b72651cb3c304a12f211cca3661b01d7` (existing GPL license only).
- All 51 imported upstream files were verified against their Git blob SHA before adaptation. The complete source map and initial seeded SHA-256 values are in `seed-provenance.json`.

Runtime and inherited tests receive mechanical naming substitutions: `npc_state` -> `npc_state_delta`, `npc-state` -> `npc-state-delta`, `npcState` -> `npcStateDelta`, `NPCState` -> `NPCStateDelta`, `NPC State` -> `NPC State Delta`, `NPC STATE` -> `NPC STATE DELTA`, and `npcstate` -> `npcstatedelta`. These isolate settings, globals, DOM/dataset markers, sidecar/lock/recovery paths, prompt IDs and file-format identifiers. The OOC recognizer and its uppercase fixture are namespaced to match `NPC State Delta`/`NPC_STATE_DELTA` until removal in stage 7; old unqualified OOC commands do not target Delta. Module-scoped `NpcState` function names and `NPC_STATE_*` exports retain their upstream spelling; they are not shared globals.

Historical markdown is preserved unmodified under `docs/history/`. The inherited layout test points to the relocated review/test reports. The root README/CHANGELOG, package metadata/scripts, ordinary CI, governance documents and seed tooling are Delta-maintained additions/adaptations. No legacy algorithm or relationship formula is deliberately changed. The seed's binary bundle header is inherited, but the validated manifest format is Delta-specific; foreign-generation formats are rejected rather than converted.

The existing GPL-3.0 license is preserved. No runtime or build dependency on the upstream repositories is introduced. No actual NPC database is imported, reset or modified.

## Verification

Baseline on Node.js 24.19.0:

- 51/51 source Git blob hashes match.
- Inherited unit command passed: 414 passing test records.
- Host API compatibility check passed.
- Synthetic runtime smoke passed.
- Synthetic migration-shape smoke passed.

Delta seed: 416 unit tests passed (414 inherited plus 2 namespace-isolation tests). Host API compatibility, synthetic runtime smoke, and synthetic migration smoke passed. Syntax/identity validation and package generation passed. These are synthetic/local checks, not evidence of live provider compliance, browser responsiveness or an installed production release.

## Intentional remaining work

All nine work stages are pending. In particular: old module boundaries, legacy UI, OOC commands, old-shape readers and automatic alive/reactivation behavior remain in the seed. Scanner-profile routing, named forms, terminal automatic death, replacement UI and final native portability are target changes, not seeded features. Delta application version consolidation remains stage 2 work.
