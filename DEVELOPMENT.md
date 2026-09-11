# NPC State Delta development

## Current baseline

Status: legacy seed plus Stage 1 dossier UI. Runtime manifest/core facade retain upstream `0.2.23`; the retained engine carries `0.2.18`. These are inherited markers and do not mean Delta stages are complete. Stage 1 is implemented; stages 2–9 remain pending. The core contract is the sole target behavior authority; work stages are in `docs/WORKPLAN.md`.

Runtime remains at the repository root with the upstream module boundaries until stage 2. `bootstrap.js` initializes lifecycle hardening before the retained `index.js` engine and its enhancement layer, then loads the Stage 1 `dossier-ui.js` presentation adapter. Do not remove a wrapper solely because its filename looks old.

Delta settings use `npc_state_delta`; public API is `NPCStateDelta`; sidecar and locking names are prefixed `npc-state-delta`. Seed bundle/data format identifiers are Delta-specific. Schema/format versions are separate from application versioning. No source project is a runtime dependency.

Stage 1 intentionally does not add another state owner. `dossier-ui.js` reads canonical state through `NPCStateDelta.getState()`, opens the existing native editor through `NPCStateDelta.openEditor()`, and returns settings access to the existing `npc_state_delta_settings` surface. Scanner calls, relationship mechanics, persistence writes and later-stage appearance-form logic remain outside the Stage 1 module.

## Commands

Node.js 24 and Python 3; no npm dependencies or install step are required.

| Command | Purpose |
| --- | --- |
| `npm test` | Inherited unit tests, host API contract, synthetic runtime and migration-shape smoke checks, Delta isolation tests, and Stage 1 dossier projection/ownership checks |
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

## Stage 1 verification boundary

Deterministic Stage 1 tests cover lifecycle display buckets, active/archived/dead filtering, search composition, selection retention, bounded/read-only state projection, no-chat behavior, legacy editor/settings ownership and bootstrap reachability. They do not replace visual inspection in a real SillyTavern browser.

The Stage 1 controller keeps search/filter/selection state outside canonical NPC data, restores affected dossier/cast scroll where it rebuilds those surfaces, and never rewrites the native editor DOM. This is the deterministic basis for preserving interaction state when canonical updates arrive. Save/cancel behavior itself remains owned by the existing native editor and its inherited tests.

A real-browser acceptance pass should still check launcher placement, panel readability at desktop/tablet/mobile widths, opening/closing settings and the native editor, focus behavior, and open-panel responsiveness with actual portraits. If that host check is not run, report it as unrun rather than treating generated HTML/source tests as visual evidence.

## Verification boundaries

The tests create mock host modules, temporary files and synthetic dossiers. They do not exercise a real provider, user's browser theme, live streaming backend, actual SillyTavern database or image service. Keep those claims separate. Do not call a smaller input estimate a demonstrated latency/semantic improvement.

The seed baseline and seed results are recorded in `docs/seed-provenance.md`. Update current stage evidence when implementing later stages, without rewriting historical baseline results. The source inventory records immutable upstream blob hashes and initial seed hashes; it is provenance, not a demand that future implementation files remain byte-identical.

## Publication

Use ordinary CI; do not create temporary execution workflows. Before authorized publication inspect current remote main, preserve concurrent commits, run required checks on the exact candidate and review changed runtime/docs. Never force-push. Verify the resulting remote tree and commit. If a required check cannot execute, complete other authorized work and state the limitation rather than inventing success.

The user-authorized Stage 1 task permits publishing the cohesive Stage 1 changes. It does not authorize stages 2–9, real database modifications, release tagging, or unrelated repositories. Future user/session authorization governs later stages.
