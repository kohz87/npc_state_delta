# NPC State Delta changes

## Stage 1 dossier UI — 11 September 2026

- Add a persistent side launcher that opens a centered portrait-led dossier surface without changing the legacy scanner, persistence, or relationship engines.
- Adapt the useful donor presentation ideas into Delta-local code: selected portrait hero, readable dossier document, searchable horizontal cast rail, and active/archived/dead filters.
- Project canonical legacy NPC state into bounded UI records so relationship/event histories and branch snapshots are not rendered or retained by the view layer.
- Route editing through the existing `NPCStateDelta.openEditor` owner and route settings access back to the existing Delta settings surface rather than creating duplicate mutation/settings paths.
- Preserve search state, selection, cast/document scroll, focused cast selection, and external editor drafts while canonical state notifications refresh the open view.
- Add focused Stage 1 tests for lifecycle filtering, search, selection retention, projection boundaries, no-chat behavior, editor/settings ownership, and bootstrap reachability.

Real-browser visual/performance QA remains a host acceptance check; deterministic HTML/model tests are not treated as visual evidence.

## Legacy seed — 11 September 2026

- Seed the exact `legacy/v0.2.x` snapshot from `kohz87/npc_state` at `a12b2937b5c1305e3e3017218a626478a5bedcdc`.
- Apply Delta identity isolation to runtime/CSS and inherited tests, retaining legacy algorithms and upstream version markers.
- Preserve the existing GPL license and record all source paths/blob hashes.
- Add the core contract, agent instructions, nine-stage workplan and verification/package tooling.
- Move upstream markdown into historical reference documentation.

No work stages 1–9 were implemented in the original seed. Upstream release history is retained in `docs/history/`.
