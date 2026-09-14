# NPC State Delta development

## Current release candidate

Delta 1.0.11 is a focused branch-recovery and Important-Bonds hardening candidate on the released 1.0.10 baseline. Delete/regenerate and edit events are linear replacements; only explicit SillyTavern swipes retain sibling branches. Destructive lineage v5 ignores mutable host timestamps/generation ids, v4 sidecars/explicit parents retain guarded compatibility, and unproven divergence keeps accepted canonical state instead of falling back to an older checkpoint/root. Automatically managed Important Bonds reject orphan prose, inverse direction collisions and near-duplicate dynamics while manual locks remain authoritative. The 1.0.10 persistence/receipt/death fixes, 256 raw-message horizon, byte-bounded full checkpoints, supported rollback readers, Speech ledger and scoring remain intact. Scanner prompts, routes, requests/retries/output allowances, storage schema and bundle format are unchanged.

## Canonical owners

`runtime-modules.json` is the only shipping JS inventory. `bootstrap.js` initializes lifecycle hardening, scanner routing and calendar settings before `index.js`, then loads the supported UI/optional full-cast owners. Runtime, manifest and inventory versions are application metadata; bundle version 1, branch lineage and persisted schemas remain independent.

- `index.js`: canonical per-chat state, completed-message capture, scan orchestration, persistence scheduling/checkpoints, explicit scoped manual and portrait mutations, host editor and retained native image workflow.
- `scanner-routing.js`: only NPC provider dispatcher, including selected profiles, counts, abort/timeouts and output override. `scan-context.js` supplies eligibility before dispatch; `full-cast.js` does not patch host generation.
- `core-mechanics.js`, `continuity-core.js`, `core.js`: retained numerical/evidence mechanics and the application facade. `appearance.js` resolves named/current/shared appearance and manual form drafts; `continuity-core.js` owns Stage 4 prompt adaptation, including implicit routine-scan transitions and the 1.0.4 targeted-Refresh form schema/context parity; `core.js` also owns the 1.0.6 bounded speech-development ledger as deterministic metadata inside canonical NPC records, using the existing scan turn/message provenance without another model request; `terminal-lifecycle.js` owns terminal policy and manual life-state shaping.
- `social.js`: one canonical social-graph owner for non-player bonds, counterpart resolution and projection. Manual bond edits replace the edited direction exactly; graph projection may enrich automatic continuity but cannot restore stale owner-side prose over an explicit manual correction.
- `calendar.js`/`birthday.js`: deterministic calendar and birthday policy. `calendar-settings.js` stores only the existing canonical settings slice; no independent campaign-clock database or timer is added.
- `storage.js`, `identity.js`, `hardening*.js`, `branch.js`/`branch-core.js`: owner-qualified files, writer locks/revisions, dirty recovery, tombstones, branch snapshots and the reversible rollback journal. Full checkpoints remain byte-bounded branch/recovery anchors; v1.0.8 recovery distinguishes harmless forward extension from true invalidation and keeps a 256 raw-message journal horizon from the trustworthy baseline. Delta 1.0.11 makes delete/regenerate and edit linear replacements, reserves sibling retention for explicit host swipes, advances destructive lineage to narrative-content v5, retains guarded v4 compatibility, and fails closed by keeping canonical state when no proven restore target exists. Same-message commits coalesce and social-graph undo stores changed records rather than whole graphs, while lineage/sequence ownership still prevents cross-branch replay. Required historical-shape readers are active compatibility behavior, not foreign converters.
- `bundle.js` plus `native-transfer.js`: one native binary codec with validated portable metadata, portrait binaries and source-history audit. The public importer validates the complete envelope and clears unproven source ownership before mutation; target history remains the safe baseline. Export prioritizes canonical dossiers/portraits over audit-only history: oversized audit metadata is reduced to a compact truncation summary and may be omitted only if needed to keep the actual backup within the established envelope limits.
- `dossier-ui.js`: lightweight rendered-state projection, selected dossier/cast and keyed unchanged sections. `dossier-experience.js`, `continuity-ui.js`, `scanner-output-ui.js` and `launcher-ui.js`: retained presentation/interaction adapters using owner notifications and scoped record reads. No second canonical state.
- `dossier-tools.js`/`dossier-tools-core.js` and `portrait-tools.js`: maintained native transfer/diagnostics and prompt/upload/removal workflow. Superseded `dossier-tools-controls.js` and duplicate portrait-manager/polling paths are removed. The native host-image preview/application route remains in its canonical owner, independent from NPC text scanning.

`NPCStateDelta.getState()` remains the explicit complete snapshot for export/debug use. `getDossierState()` excludes history; `getNpc(id)` reads one record; `persistenceStatus()` exposes actual current-chat pending/in-flight flags. Mutations `updateAppearance`, `updateLifeState`, `setPortrait` and `removePortrait` require the intended chat key and revalidate asynchronous ownership. Dossier/editor/settings mounted/rendered notifications drive adapters without document-wide history-copy loops. Manual draft storage is UI-only.

## Required commands

Node.js 24 and Python 3; no npm dependencies or install step are required for the core workflow.

```sh
npm test
npm run validate
npm run measure:prompts
node scripts/measure-stage9.mjs
npm run package
git diff --check
```

`npm test` runs all four required programs:

```sh
node --import ./tests/active-runtime-test-setup.mjs --test tests/*.test.js
node --import ./tests/active-runtime-test-setup.mjs tests/compatibility-check.js
node --import ./tests/active-runtime-test-setup.mjs tests/runtime-smoke.mjs
node --import ./tests/active-runtime-test-setup.mjs tests/migration-smoke.mjs
```

The package-layout check expects the checkout directory itself to be named `npc_state_delta`, just like the install directory. Do not weaken that check to accommodate an arbitrarily named worktree. The source-era test import aliases are handled by the development-only `active-runtime-test-setup.mjs`; those names never re-enter the shipping inventory.

`validate` checks syntax, imports, namespaces, semantic ownership, exact runtime inventory and application metadata. Prompt measurement uses production builders with fixed fixtures; the additional Stage 9 capture checks complete Delta-owned system/user message bytes and options for both routes and a malformed-response retry against `tests/fixtures/stage9-budgets.json`. This baseline must not be regenerated from a changed candidate to conceal differences. Supply a baseline checkout path as an argument to measure that checkout with the same fixture. The 1.0.3 routine-scan form trigger remains conditional and byte-stable for unrelated scans. The 1.0.4 change is confined to `buildProfileRefreshPrompt`; the 1.0.5 social-graph fix, 1.0.6 speech ledger and 1.0.7-1.0.11 rollback/recovery/persistence/social hardening are non-model-facing, so Stage 9 request bytes, prompt hashes, request counts and output allowances are expected to remain unchanged.

`package` deterministically creates `dist/npc_state_delta-1.0.11.zip` and its SHA-256 sidecar. It verifies exact inventory, archive contents, CRC, byte identity and JS syntax. Only declared runtime JS, CSS, manifest, inventory, license and README ship; tests, scripts, history, source bundles and browser artifacts do not.

## Optional synthetic browser verification

With Playwright and Chromium already available:

```sh
python3 scripts/browser-stage9.py --browser /usr/bin/chromium --output dist/browser-stage9
```

The test executes actual local UI modules through an in-memory import map and a synthetic host. It requires no web server, user chats, model credentials or paid calls. It covers desktop 1440x900, tablet 820x1180, mobile 390x720 and reduced-height 390x430 viewports, screenshots, card/modal geometry, keyboard Escape, selected-state focus/scroll/node preservation, portrait drafts/upload/thumbnail updates, newer form/life-state drafts during delayed persistence, and diagnostics/idle DOM behavior.

The reduced-height case is not an actual mobile keyboard/browser-chrome test; programmatic file selection is not a physical-device picker. Synthetic host success is not live SillyTavern/Gemini or image-provider acceptance. Browser dependencies are optional development tools and never shipped runtime dependencies.

## Verification and safety boundaries

All tests use temporary synthetic data. The full runtime harness exercises production capture, routing, stale-result checks, branch/owner recovery, save rejection and retry. The pinned 41,070-case relationship oracle remains unchanged and is not regenerated from current code. Historical storage readers remain required by recovery/migration smoke; they do not authorize importing another generation's database.

The v1.0.8 journal contract is message-oriented: it preserves a contiguous 256 raw-message horizon from the trustworthy baseline rather than defining rollback depth by serialized bytes or mutation count. Full checkpoints remain independent byte-bounded branch/swipe anchors. Recovery classifies forward extension separately from destructive divergence, so a sidecar that is simply behind the live chat never rolls canonical state backward. Delta 1.0.11 additionally treats delete/regenerate and edit as linear replacement, prunes replaced descendants, preserves siblings only for explicit swipe events, and refuses an older checkpoint/root fallback when a divergence lacks proven recovery ownership. Narrative-content lineage v5 prevents mutable host timestamp/generation metadata from creating destructive branch identity; guarded v4 readers support upgrade and explicit-parent ancestry. Unchanged user/system boundaries are traversable even when they have no undo mutation, and repeated deterministic writers at one message coalesce into an earliest-before/latest-after undo record, using copy-on-write for referenced versions and preserving their required predecessors. Receipt turns are checkpointed at their assistant boundary before scanning, even when that scan fails. NPC undo remains field-level; social-graph undo is edge/slot-specific with a reader for v1.0.7 full-graph entries. Tail deletion restores structural state, owned references, lifecycle and Speech-development evidence without a model request. Portrait assets remain available while checkpoints or journal undo can still restore their NPC. The 12 MB journal metric is diagnostic rather than permission to silently shorten the advertised raw-message horizon; coverage/byte/budget metadata stays on canonical rollback state for deterministic inspection and tests. An upgrade cannot manufacture history older than the baseline already proven by its existing state.

The speech-development ledger is bounded to four pending concepts and four recent source-message/turn references per concept. It is stored inside the canonical NPC record, follows ordinary checkpoint/rollback and native-bundle cloning, and does not retain transcript text. A stable labeled concept repeated in three independent observations may authorize gradual Speech replacement only when the observations span at least two turns; repeated retained source-message observations are ignored. If turn provenance is entirely unavailable, three distinct retained source-message IDs provide the supported fallback. Accepted full Speech evolution clears old speech profile evidence and starts a new epoch. Manual Speech locks remain authoritative, and an external/manual Speech baseline change rebases by clearing stale pending concepts before subsequent scan evidence is counted.

Actual provider latency, model extraction quality and provider-reported token use are not available from deterministic fixtures or another model's review. Delta-owned request bytes exclude host/provider additions not exposed by the harness. No thinking budget is introduced or increased. Do not add paid Gemini tests without explicit authorization.

Permanent nonretryable HTTP save rejection is surfaced while dirty data remains available for later recovery; transient/network/408/425/429/5xx behavior retains existing retries and writer guards. Portrait/form/lifecycle/native operations distinguish local mutation from successful durable flush. Calendar settings use the host's normal debounced persistence and say queued, not falsely durable. Native export retains the 2 MB manifest and 32 MB total-envelope ceilings; only audit-only source-history detail is compacted or omitted to keep canonical backup data exportable within those limits.

## Publication

Use the existing CI, package command and artifact retention. No temporary execution workflow, new release pipeline, automatic tag or empty verification commit is needed. For post-release hotfixes, publish only an explicitly authorized candidate after required checks pass on its latest head; do not operate on real user databases, other repositories, force pushes or paid model calls.

Review the final diff and file set before committing. Re-read main/PR state before publication and merge; preserve concurrent work and reverify a materially changed candidate. Resolve blocking reviews and verify the merge reached main. CI retains the installable ZIP and reproducible source bundle through its existing artifact step. Do not relabel local/synthetic evidence as live-host acceptance or older-commit CI as current evidence.
