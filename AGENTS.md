# NPC State Delta — agent instructions

## Authority and scope

Read in order: `AGENTS.md`, `docs/core-contract.md`, `docs/WORKPLAN.md`, and `DEVELOPMENT.md`. Read `docs/seed-provenance.md` when comparing or changing inherited behavior. Applicable nested instructions also apply.

The user's current instruction controls scope and authorization. The core contract is the single behavior authority; the workplan defines work stages, not separate runtime systems. Historical documents under `docs/history/` are evidence only and do not govern Delta. Alpha/Beta contracts do not govern this repository.

Inspect current branch, remote HEAD, working-tree changes, and available execution tools before changing files. Preserve unrelated work and concurrent commits. Complete only the requested stage or task; authorization for one stage does not authorize later stages. Do not start a rewrite simply because a later stage describes one.

## Main implementation rule

Delta was seeded from the pinned NPC State source baseline recorded in `docs/seed-provenance.*`. From the active-runtime boundary forward, every called implementation module is Delta code regardless of ancestry. Source ancestry belongs in Git/provenance records, not in runtime module classification or version-labelled filenames.

Adapt selected useful Beta/Alpha features into that foundation. Do not import their engines, mandatory trailer capture, Immediate/Development split, exhaustive field-accounting contracts, next-generation scan barrier, or cross-generation migration systems.

Keep one settings owner, scanner request dispatcher, state owner, persistence boundary, relationship mechanics owner, and evidence/injection path. These responsibilities do not require a new framework. No runtime import, remote fetch, build dependency, or installed-extension dependency on the three reference repositories.

Preserve verified baseline behavior unless the requested stage explicitly changes it. Direct supported facts may establish on first scan. Omission preserves accepted values. Personality, voice, mannerisms, agency, and relevant appearance must reach subsequent roleplay injection. Do not mistake a populated UI for a complete continuity loop.

Retain the accepted relationship formulas, caps, signed fractions, gates, and tie handling unless the user separately authorizes a scoring change. Beta priority tie handling/source-event duplicate changes are discussion options, not accepted requirements.

Keep Delta settings, globals, DOM identifiers, storage files/locks, injection key, and bundle identity isolated. Never read, import, modify, or rebuild real source/Beta/Alpha/Delta databases without explicit user authorization. Tests use temporary synthetic data. Namespace separation does not prove simultaneous automatic writers are safe.

## Active runtime and compactness

`runtime-modules.json` is the canonical machine-readable inventory of shipped JavaScript modules. Every top-level runtime `.js` file must appear there exactly once with a current semantic role. No active runtime path may be retained under a source-version or legacy-labelled filename. Packaging and validation must consume this inventory rather than maintain independent runtime lists.

Trace callers, exports, event hooks, stored-data readers, tests, and packaging before deleting code. Remove superseded paths together; do not retain no-op facades, duplicate engines, or new legacy directories for hypothetical compatibility. Preserve active tombstones, source identity, writer locking, pending-write recovery, and rollback safety.

If historical-shape readers or migration logic remain necessary for supported Delta state, classify them as active Delta compatibility behavior within the current owner. Do not create a second compatibility runtime. Persisted field names or algorithms that cannot safely change without a state migration may remain only when caller/data evidence proves they are required; document that constraint and test it. Once such a reader is no longer required, remove it rather than preserving it cosmetically.

Stage 2 establishes Delta application version `0.1.0`, retires the superseded enhancement dossier-library layer, and normalizes active source-era implementation paths into semantic Delta owners such as `core-mechanics.js` and `branch-core.js`. Historical names and upstream versions remain only in Git/provenance/history records where preserving them is evidence, not runtime architecture.

Stage 3 establishes `scanner-routing.js` as the single NPC request dispatcher. Other runtime owners, including `full-cast.js`, must not patch or call the host `generateRaw` route directly; eligibility guards run before dispatch. Stage 4 establishes the current appearance model: flat appearance remains a compatibility display baseline, named forms/current-form plus an unnamed-current presentation are active Delta state, `appearance.js` provides the shared resolver, `continuity-core.js` routes dossier/portrait/injection/scanner use through it, and explicit confirmed death is terminal to automatic writers. The retained native editor continues to edit the current appearance scalar; Stage 4 normalization maps a manual-locked edit into the selected form so it does not become a second appearance authority. A deliberate manual Restore of a confirmed-dead dossier is treated as an explicit provenance-recorded correction of an erroneous death record, never as narrative auto-resurrection. Do not reintroduce narrative auto-resurrection or separate appearance authorities in later cleanup.

Stages 5-7 retain the pinned numerical scorer and owned recovery readers. Story-text OOC commands and their public dispatcher are removed; keep manual controls and their shared structured helpers, but never reconnect narration to add/remove dispatch. Resolved appearance uses the existing optional injection budget after essential identity/agency. All post-merge automatic writers, including focused relationships and targeted repair, must preserve terminal-death state before checkpointing. Numerical baseline verification is recorded in `docs/stages5-7-review.md`.

Do not silently loosen or tighten accepted evidence interpretation under cleanup. Keep model-facing instructions compact. Do not add unsolicited scans, retries, per-field calls, classifiers, or summarizers. Account for retained focused passes as real requests.

## Verification and publication

Follow `DEVELOPMENT.md` for executable commands. Test changed behavior through production functions and the existing synthetic host harness. When storage, identity, scan scheduling, or scoring changes, exercise relevant stale-result, duplicate, swipe/edit/delete, failure, and recovery cases.

Distinguish deterministic tests, synthetic host checks, actual browser/provider checks, estimated tokens, and provider-reported usage. Mocked success is not proof of live extraction quality, latency, or UI responsiveness. Do not use a test count alone as acceptance evidence.

When execution is unavailable, continue authorized edits/reviewable work and report unrun checks; inspect ordinary CI for the exact candidate where possible. Do not create temporary workflows or empty commits solely to obtain execution. Never claim an earlier commit validates current changes.

This file does not independently authorize publishing, releases, force pushes, merges, or database operations. Respect existing session authorization. Re-read remote state before authorized publication, never force over concurrent work, and verify the final remote commit. Retain the existing GPL license and relevant source notices.

Report what changed, current stage status, actual verification, material limitations, and commit/PR link when created. Do not describe planned stages or a development seed as a completed release.
