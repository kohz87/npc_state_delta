# NPC State Delta v0.1.0

**Development build.** Delta now has its own application-version baseline at `0.1.0`. The pinned source snapshot still carries legacy source/engine identifiers such as `0.2.23` and `0.2.18`; those are provenance or internal compatibility markers, not the Delta application version. Stages 1 and 2 are implemented; stages 3-9 remain pending.

Delta is a standalone SillyTavern NPC continuity extension based primarily on the legacy NPC State implementation. Selected Beta/Alpha presentation and appearance features are adapted into that foundation; their engines and two-stage architecture are not the base.

## Current contents

- Complete pinned legacy behavior base and inherited synthetic tests, with Delta-specific settings, storage, globals, DOM and prompt identities.
- Legacy scan, dossier evolution, relationship mechanics, sidecar recovery, portrait tools and injection retained at current behavior.
- Stage 1 side launcher plus a portrait-led, searchable dossier/cast-rail surface implemented as a read-only presentation adapter over canonical legacy state.
- Stage 2 cleanup with coherent `0.1.0` application metadata, a dedicated full-cast scanning owner, and removal of the superseded secondary dossier-library enhancement surface.
- Existing source-engine and lineage modules that still have real runtime callers remain in place even when their filenames carry legacy version provenance; Stage 2 does not delete active safety or migration code merely to make filenames prettier.
- Core behavior contract, staged implementation plan, development commands and source provenance.
- Existing repository GPL-3.0 license preserved.

The runtime still carries the legacy OOC commands and automatic alive/reactivation behavior until their assigned later stages. Scanner connection profiles, named appearance forms and terminal automatic death are not yet delivered. Stage 2 is a structure/version cleanup and does not redesign scanner semantics, persistence, relationship scoring, or injection behavior.

## Governing documents

1. [AGENTS.md](AGENTS.md)
2. [Core contract](docs/core-contract.md)
3. [Workplan and stage status](docs/WORKPLAN.md)
4. [Development and verification](DEVELOPMENT.md)
5. [Seed provenance](docs/seed-provenance.md)

Reference history under `docs/history/` describes upstream versions and is not Delta's behavior authority or current validation evidence.

## Development installation

Use an isolated SillyTavern 1.18.0-compatible test instance with synthetic chats. Install the repository or generated runtime ZIP as one `npc_state_delta` extension folder; `manifest.json` is directly inside it. Namespace separation protects identity, but simultaneous automatic writers from several NPC extensions are not an accepted configuration. Do not use this development build to import another generation's database.

No live user chat or NPC database is required by the verification suite. Browser/provider compatibility, visual layout and live latency are separate host checks.

## Verify

```sh
npm test
npm run validate
npm run measure:prompts
npm run package
git diff --check
```

Node.js 24 and Python 3 are used by the dependency-free verification/package scripts. See `DEVELOPMENT.md` for direct commands when npm is unavailable.
