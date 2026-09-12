# NPC State Delta v0.1.0

**Development build.** Delta has its own application-version baseline at `0.1.0`. Upstream source versions are recorded only in Git history and `docs/seed-provenance.*`; they are not runtime identities, module names, or application versions. Stages 1-7 are implemented and deterministically verified; stages 8-9 remain pending. Real-host visual/provider acceptance for stages 4-7 remains unrun.

Delta is a standalone SillyTavern NPC continuity extension built from a pinned NPC State source baseline and developed forward as one Delta codebase. Selected Beta/Alpha presentation ideas are adapted into that foundation; their engines and two-stage architecture are not runtime dependencies.

## Current contents

- One canonical Delta runtime whose complete top-level JS inventory is declared in `runtime-modules.json`.
- Active core mechanics in `core-mechanics.js`, active branch/recovery primitives in `branch-core.js`, and semantic owners for persistence, identity, social state, lifecycle hardening, scanning, dossier UI, and launcher UI.
- Stage 1 side launcher plus a portrait-led, searchable dossier/cast-rail surface over canonical Delta state.
- Stage 2 consolidation with coherent `0.1.0` application metadata, a dedicated full-cast scanning owner, removal of the superseded secondary dossier-library enhancement surface, and removal of version-labelled source-era runtime paths.
- Stage 3 shared scanner request routing with an optional connection profile while leaving ordinary roleplay and portrait routing independent; automatic backfill guards execute before that dispatcher rather than patching the host generation route.
- Stage 4 appearance continuity with form-independent overall presentation, bounded named forms, explicit current/unnamed-form state, manual current-appearance reconciliation, and one shared resolver across canonical dossier appearance/portrait/injection. Confirmed automatic death is terminal; correction of an erroneous death and owned rollback are the only reversal paths.
- Stage 5 verified numerical baseline and source-aware relationship integration; Stage 6 identity-first budgeted injection with resolved appearance; Stage 7 owned recovery verification and complete removal of story-text OOC commands.
- Historical source snapshots, old version labels, and provenance notes segregated under `docs/history/` and `docs/seed-provenance.*`; they are not shipped runtime modules.
- Existing migration/compatibility behavior that is still required for accepted stored-state shapes remains active Delta compatibility logic inside the current owners. It is not a second engine or a legacy runtime layer.
- Core behavior contract, staged implementation plan, development commands, and source provenance.
- Existing repository GPL-3.0 license preserved.

Use the settings **Add NPC** control and the dossier editor for manual changes. OOC-looking text does not execute dossier commands. Automatic death remains terminal; deliberate manual correction is available even when a dead record was not archived, and leaves presence unconfirmed. Manual/stale archive return for living NPCs remains unchanged. The retained appearance editor is scalar-facing, with manually locked edits reconciled into the selected form. Numerical scoring formulas and required historical-state recovery readers remain intact.

The [stages 5-7 review](docs/stages5-7-review.md) records the 41,070-case pinned-source scoring comparison, integration fixes, removals, and verification boundaries. Local verification passed 495 unit tests plus compatibility/runtime/migration smoke checks; live provider/browser performance is not claimed.

## Active runtime ownership

`runtime-modules.json` is the machine-readable shipping inventory. Every top-level runtime `.js` file must appear there exactly once with an explicit role, and the validator rejects undeclared or version/legacy-labelled active paths. Packaging consumes this inventory rather than globbing arbitrary JavaScript files.

Source ancestry belongs in provenance, not in active classification. If inherited code is still called by Delta, it is active Delta code and must live under a current semantic module name. Historical documentation may retain original names and versions because changing those records would falsify provenance.

## Governing documents

1. [AGENTS.md](AGENTS.md)
2. [Core contract](docs/core-contract.md)
3. [Workplan and stage status](docs/WORKPLAN.md)
4. [Development and verification](DEVELOPMENT.md)
5. [Seed provenance](docs/seed-provenance.md)

Reference history under `docs/history/` describes upstream versions and is not Delta's behavior authority or current validation evidence.

## Development installation

Use an isolated SillyTavern 1.18.0-compatible test instance with synthetic chats. Install the repository or generated runtime ZIP as one `npc_state_delta` extension folder; `manifest.json` is directly inside it. Namespace separation protects identity, but simultaneous automatic writers from several NPC extensions are not an accepted configuration. Do not use this development build to import another generation's database.

No live user chat or NPC database is required by the verification suite. Browser/provider compatibility, visual layout, and live latency are separate host checks.

## Verify

```sh
npm test
npm run validate
npm run measure:prompts
npm run package
git diff --check
```

Node.js 24 and Python 3 are used by the dependency-free verification/package scripts. See `DEVELOPMENT.md` for direct commands when npm is unavailable.
