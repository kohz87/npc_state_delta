# NPC State Delta development

## Current baseline

Status: legacy seed. Runtime manifest/core facade retain upstream `0.2.23`; the retained engine carries `0.2.18`. These are inherited markers and do not mean Delta stages are complete. The core contract is the sole target behavior authority; work stages are in `docs/WORKPLAN.md`.

Runtime remains at the repository root with the upstream module boundaries until stage 2. `bootstrap.js` initializes lifecycle hardening before the retained `index.js` engine and its enhancement layer. Do not remove a wrapper solely because its filename looks old.

Delta settings use `npc_state_delta`; public API is `NPCStateDelta`; sidecar and locking names are prefixed `npc-state-delta`. Seed bundle/data format identifiers are Delta-specific. Schema/format versions are separate from application versioning. No source project is a runtime dependency.

## Commands

Node.js 24 and Python 3; no npm dependencies or install step are required.

| Command | Purpose |
| --- | --- |
| `npm test` | Inherited unit tests, host API contract, synthetic runtime and migration-shape smoke checks, plus Delta isolation tests |
| `npm run validate` | JS syntax, local runtime dependencies, namespace isolation, manifest/version/README and required-document checks |
| `npm run measure:prompts` | Two shared scanner fixtures and accepted-characterization injection check; estimated tokens only |
| `npm run package` | Deterministic runtime-only ZIP with Delta root folder and checksum; verify archive entries and syntax |
| `git diff --check` | Whitespace/conflict review |

If npm cannot execute, use the actual underlying commands rather than stopping:

```sh
node --test tests/*.test.js
node tests/compatibility-check.js
node tests/runtime-smoke.mjs
node tests/migration-smoke.mjs
node scripts/validate.mjs
node scripts/measure-prompts.mjs
python3 scripts/package.py
```

All four test commands are required to claim the full test workflow passed. The inherited migration smoke tests exercise synthetic old-shape lineage handling inside this isolated namespace, not a supported import from legacy/Beta/Alpha. Stage 2/7 may retire unused readers and associated tests after tracing dependencies.

## Verification boundaries

The tests create mock host modules, temporary files and synthetic dossiers. They do not exercise a real provider, user's browser theme, live streaming backend, actual SillyTavern database or image service. Keep those claims separate. Do not call a smaller input estimate a demonstrated latency/semantic improvement.

The seed baseline and seed results are recorded in `docs/seed-provenance.md`. Update current stage evidence when implementing later stages, without rewriting historical baseline results. The source inventory records immutable upstream blob hashes and initial seed hashes; it is provenance, not a demand that future implementation files remain byte-identical.

## Publication

Use ordinary CI; do not create temporary execution workflows. Before authorized publication inspect current remote main, preserve concurrent commits, run required checks on the exact candidate and review changed runtime/docs. Never force-push. Verify the resulting remote tree and commit. If a required check cannot execute, complete other authorized work and state the limitation rather than inventing success.

Seeding the user-designated new repository authorizes publishing this seed. It does not authorize unrelated repositories, stages 1–9, real database modifications, or release tagging. Future user/session authorization governs later publication.
