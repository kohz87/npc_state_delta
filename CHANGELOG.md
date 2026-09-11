# NPC State Delta changes

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

- Add a persistent side launcher that opens a centered portrait-led dossier surface without changing the legacy scanner, persistence, or relationship engines.
- Adapt the useful donor presentation ideas into Delta-local code: selected portrait hero, readable dossier document, searchable horizontal cast rail, and active/archived/dead filters.
- Project canonical legacy NPC state into bounded UI records so relationship/event histories and branch snapshots are not rendered or retained by the view layer.
- Route editing through the existing `NPCStateDelta.openEditor` owner and keep settings owned by the existing Delta Extensions settings surface rather than creating duplicate mutation/settings paths.
- Preserve search state, selection, cast/document scroll, focused cast selection, and external editor drafts while canonical state notifications refresh the open view.
- Add focused Stage 1 tests for lifecycle filtering, search, selection retention, projection boundaries, no-chat behavior, editor/settings ownership, and bootstrap reachability.

Real-browser visual/performance QA remains a host acceptance check; deterministic HTML/model tests are not treated as visual evidence.

## Legacy seed - 11 September 2026

- Seed the exact `legacy/v0.2.x` snapshot from `kohz87/npc_state` at `a12b2937b5c1305e3e3017218a626478a5bedcdc`.
- Apply Delta identity isolation to runtime/CSS and inherited tests, retaining legacy algorithms and upstream version markers.
- Preserve the existing GPL license and record all source paths/blob hashes.
- Add the core contract, agent instructions, nine-stage workplan and verification/package tooling.
- Move upstream markdown into historical reference documentation.

No work stages 1-9 were implemented in the original seed. Upstream release history is retained in `docs/history/`.
