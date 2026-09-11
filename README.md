# NPC State Delta v0.2.23

**Development seed, not a completed Delta release.** The displayed version is inherited from the pinned legacy snapshot. Stages 1–9 are planned and have not been implemented.

Delta is a standalone SillyTavern NPC continuity extension based primarily on the legacy NPC State implementation. Selected Beta/Alpha presentation and appearance features will be adapted into that foundation; their engines and two-stage architecture are not the base.

## Current contents

- Complete pinned legacy runtime and inherited synthetic tests, with Delta-specific settings, storage, globals, DOM and prompt identities.
- Legacy scan, dossier evolution, relationship mechanics, sidecar recovery, portrait tools and injection retained at seed behavior.
- Core behavior contract, nine-stage implementation plan, development commands and source provenance.
- Existing repository GPL-3.0 license preserved.

The seed still has the legacy UI, OOC commands, automatic alive/reactivation behavior, compatibility layers and versioned module names. Their planned changes are assigned to specific stages. Scanner connection profiles, named appearance forms, terminal automatic death and the new dossier UI are not yet delivered.

## Governing documents

1. [AGENTS.md](AGENTS.md)
2. [Core contract](docs/core-contract.md)
3. [Workplan and stage status](docs/WORKPLAN.md)
4. [Development and verification](DEVELOPMENT.md)
5. [Seed provenance](docs/seed-provenance.md)

Reference history under `docs/history/` describes upstream versions and is not Delta's behavior authority or current validation evidence.

## Development installation

Use an isolated SillyTavern 1.18.0-compatible test instance with synthetic chats. Install the repository or generated runtime ZIP as one `npc_state_delta` extension folder; `manifest.json` is directly inside it. Namespace separation protects identity, but simultaneous automatic writers from several NPC extensions are not an accepted configuration. Do not use the seed to import another generation's database.

No live user chat or NPC database is required by the verification suite. Browser/provider compatibility and live latency are separate from synthetic host tests.

## Verify

```sh
npm test
npm run validate
npm run measure:prompts
npm run package
git diff --check
```

Node.js 24 and Python 3 are used by the dependency-free verification/package scripts. See `DEVELOPMENT.md` for direct commands when npm is unavailable.
