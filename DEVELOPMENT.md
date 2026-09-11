# NPC State Delta development

## Current baseline

Status: legacy-based Delta with Stage 1 dossier UI and Stage 2 consolidation. Delta's application version is now `0.1.0`. The pinned source snapshot's `0.2.23` manifest and retained engine's `0.2.18` constant remain provenance/internal source markers only; they are not Delta application versions. Stages 1-2 are implemented; stages 3-9 remain pending. The core contract is the sole target behavior authority; work stages are in `docs/WORKPLAN.md`.

`bootstrap.js` initializes lifecycle hardening before the canonical `index.js` runtime, then loads the optional full-cast owner and the Stage 1 dossier presentation. The old `enhancements.js` wrapper and its second dossier-library UI are removed; `full-cast.js` retains only the opt-in full-cast behavior and its existing backfill guard. `dossier-ui.js` plus `launcher-ui.js` remain presentation modules over canonical state.

Stage 2 deliberately retains `core-v0218.js` and `branch-v0218.js` because they still contain actively called baseline algorithms and migration/lineage helpers. Their names record inherited source provenance; they are not alternate runtime engines. Removing or renaming them without rewriting all live callers would be cosmetic churn, contrary to the caller-evidence rule. `core.js` is the application-facing facade and owns Delta's `0.1.0` application version while exposing the retained source-engine constant separately as `NPC_STATE_SOURCE_ENGINE_VERSION`.

Delta settings use `npc_state_delta`; public API is `NPCStateDelta`; sidecar and locking names are prefixed `npc-state-delta`. Bundle/data/branch format identifiers remain Delta-specific and independent from the application version. No source project is a runtime dependency.

Stage 1 does not add another state owner. `dossier-ui.js` reads canonical state through `NPCStateDelta.getState()` and opens the existing native editor through `NPCStateDelta.openEditor()`. Scanner calls, relationship mechanics and persistence writes remain owned by the canonical runtime. Stage 2 removes the superseded secondary dossier-library projection rather than adding another owner.

## Commands

Node.js 24 and Python 3; no npm dependencies or install step are required.

| Command | Purpose |
| --- | --- |
| `npm test` | Inherited unit tests, host API contract, synthetic runtime and migration-shape smoke checks, Delta isolation tests, Stage 1 UI checks, and Stage 2 owner/layout checks |
| `npm run validate` | JS syntax, local runtime dependencies, namespace isolation, consolidated owner checks, and application-version consistency |
| `npm run measure:prompts` | Two shared scanner fixtures and accepted-characterization injection check; estimated tokens only |
| `npm run package` | Deterministic runtime-only `npc_state_delta-<version>.zip` with Delta root folder and checksum; verifies archive entries and JS syntax |
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

All four test commands are required to claim the full test workflow passed. The inherited migration smoke tests exercise synthetic old-shape lineage handling inside this isolated namespace, not a supported import from legacy/Beta/Alpha. Later stages may retire additional readers only after their callers and safety behavior are traced.

## Stage 1 verification boundary

Deterministic Stage 1 tests cover lifecycle display buckets, active/archived/dead filtering, search composition, selection retention, bounded/read-only state projection, no-chat behavior, editor/settings ownership and bootstrap reachability. User host testing additionally exercised the launcher and dossier on tablet/mobile and drove the viewport and cast-rail fixes that completed Stage 1.

The Stage 1 controller keeps search/filter/selection state outside canonical NPC data, restores affected dossier/cast scroll where it rebuilds those surfaces, and never rewrites the native editor DOM. Save/cancel behavior itself remains owned by the existing native editor and its inherited tests.

## Stage 2 verification boundary

Stage 2 is structural. It must preserve scanner semantics, relationship scoring, persistence/recovery, branch ownership and roleplay injection while reducing superseded presentation/runtime layering. Acceptance requires the full synthetic suite, validation, prompt measurement, package verification and ordinary CI on the exact candidate. The `0.1.0` reset changes application metadata only; bundle format `1`, branch-lineage schema versions and other persisted schema identifiers are not reset.

The retained version-named core/branch source modules are covered by active callers and therefore are not classified as dead compatibility code. This is intentional evidence-based retention, not a promise to preserve their filenames forever.

## Verification boundaries

The tests create mock host modules, temporary files and synthetic dossiers. They do not exercise a real provider, live streaming backend, actual SillyTavern database or image service. Keep those claims separate. Do not call a smaller input estimate a demonstrated latency/semantic improvement.

The seed baseline and seed results are recorded in `docs/seed-provenance.md`. Do not rewrite those historical results. The source inventory records immutable upstream blob hashes and initial seed hashes; it is provenance, not a demand that future implementation files remain byte-identical.

## Publication

Use ordinary CI; do not create temporary execution workflows. Before authorized publication inspect current remote main, preserve concurrent commits, run required checks on the exact candidate and review changed runtime/docs. Never force-push. Verify the resulting remote tree and commit. If a required check cannot execute, complete other authorized work and state the limitation rather than inventing success.

The current user instruction authorizes Stage 2 and the Delta application-version reset to `0.1.0`. It does not authorize stages 3-9, real database modifications, release tagging, or unrelated repositories.
