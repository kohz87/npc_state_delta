# Stages 5-7 review and verification

Date: 12 September 2026. Starting main: `96afb58d2ef994c24359bedee01f4a821d7e10f8` (Stage 4). Scope is relationship integration, evidence/injection, storage/recovery verification, and OOC removal. Stages 8-9 are not implemented here. Application version remains `0.1.0`; no persistence, bundle, or lineage schema reset.

## Stage 5: preserve the numerical baseline

The pinned source is `kohz87/npc_state` at `a12b2937b5c1305e3e3017218a626478a5bedcdc`, `legacy/v0.2.x/core-v0218.js`, Git blob `6d55d08889c04bf55d1d72e44ecc758b800ccc35`. The original source was reconstructed outside the runtime tree from the recorded seed and reverse namespace substitutions, then checked against that exact Git blob. No donor engine or reference runtime was added to Delta.

`tests/fixtures/scoring-cases.mjs` describes 41,070 input cases: every axis, both directions, stock depth boundaries, 25/50/75/90 gates, locked/unlocked milestones, signed fractional progress, all impact tiers, reversals, tied overflow proposals, and stock/custom/low caps. `scoring-oracle.json` contains the digest recorded by executing those cases against the hash-verified pinned source. The test executes the same cases against Delta's public scorer and compares canonicalized output values, including progress, crossings, blocks, accepted evidence and applied deltas. Object key insertion order is ignored; array order is retained. The recorded SHA-256 is `cd8b96a1e18c4fe1152b53743ae7b186b2ae4c7b54f95aa24cdd837cd22b6301`.

To independently reproduce the oracle, obtain the pinned core and its `social.js` dependency outside the repository, verify their Git blob hashes against `docs/seed-provenance.json`, import `scoringCases` and `canonicalResult`, and hash `JSON.stringify(canonicalResult(applyRelationshipDelta(...args))) + '\n'` for every case in generator order. The fixture is a recorded result, not another implementation of the formulas.

### Production path reviewed

`generateParsedNpcJson` -> `parseScanJson` -> identity resolution and full-window numeric scrubbing -> conditional focused evaluation -> `mergeScanResult` / `applyFocusedRelationshipDecisions` -> the same `applyRelationshipDelta` owner -> source checkpoint -> `setChatState` / sidecar persistence -> canonical dossier projection. Snapshot restoration restores scores, progress, gates and history together; a message index without its owned lineage is not used as an independent rollback authority.

No numerical formula, cap, axis budget, tied-axis rule, configured-cap minimum or duplicate-event heuristic changed. Two integration defects were corrected:

- Focused evaluation and application now exclude confirmed-dead records, including those not archived because automatic death archiving is disabled. This closes a post-merge writer bypass of the accepted Stage 4 terminal rule.
- A valid all-zero focused decision may initialize an empty relationship description, matching the primary merge. It does not add a numeric event, rewrite an established summary without an accepted advance, or bypass manual locks. Summary consistency receives the same current evidence context used by evaluation.

Behavioral sentinels additionally verify signed gate crossing and carry, parse-to-persistence-to-display agreement, same-source repeat stability, and deletion-source rollback. Existing regression coverage continues to cover manual scores, aftermath rejection, gate blocks with zero visible movement, negative progression and history restoration.

## Stage 6: evidence and next-roleplay continuity

Narration, World State, Inner Chatter, structured dossier sources, identity matching, admission and physical/off-screen presence distinctions are retained. No new model request, generation barrier, source restriction, history window, output allowance, or tentative-fact promotion was introduced.

The Stage 4 injection adapter previously reserved appearance space before the baseline identity allocation and then sliced the assembled prompt. At small budgets this could crowd out characterization and cut the final text. Resolved current appearance is now an optional field in the existing budgeted assembly, after essential identity/agency/current-state/relationship allocation. The accepted budget normalization and field compaction are unchanged. Unknown forms retain an explicit no-inferred-anatomy instruction when that optional field fits. There is no post-assembly truncation in the adapter and no second relevance selection.

Tests check accepted personality, behavior profile, speech and mannerism preservation under omission; rejection of tentative evidence from injection; canonical current-form agreement; and retention of the baseline essential character line at configured budgets including the existing minimum clamp. The synthetic host suite also inspects the actual `setExtensionPrompt` payload, not only stored dossier fields.

## Stage 7: OOC removal and owned recovery

Removed the text-command parser, control-text stripper, `processOocCommands`, public `processOoc` API, command-specific edit/reconcile dispatch, OOC-only scanner focus branch and help, obsolete command bookkeeping in fresh state/checkpoints/import merge, and parser-only tests. Ordinary narrative and OOC-looking user text do not execute add/remove operations or enqueue command backfills. Text remains text for ordinary evidence handling.

The `MESSAGE_SENT` subscription is retained only for chat hydration and lineage maintenance. `applyNpcStateCommand` remains an active structured manual add/remove helper used by the settings controls and suppression logic; there is no string parser or story-dispatch route to it. Manual Add, edit, archive, Restore, delete and targeted repair remain available. Existing command-driven test setups now invoke the production manual controls instead of a removed command API. Backfill checkpoint labels now describe dossier backfills rather than OOC commands.

The storage/identity/hardening implementations, writer lock, revision conflict handling, dirty retry, owner-qualified filenames, tombstones, recovery readers and branch algorithms are retained. The branch changes remove only obsolete OOC bookkeeping. No old user database is loaded or rewritten by this work, and no historical compatibility reader is deleted. Old sidecars may retain inert unknown metadata; feature removal does not destructively purge historical user files. Cross-generation import/export redesign remains Stage 8.

Refresh/backfill now reapply terminal protection after restoring live fields and before creating checkpoints. This prevents pre-death presence or a later revival summary from leaking into saved history. The retained manual correction path also works for a terminal record that was never archived; the editor labels it as death correction and the confirmation explains its meaning. Correction retains provenance and leaves presence false. Automatic revival is still rejected.

New synthetic tests cover transient upload failure with retry, same-name chats under different owners, read-owner mismatch rejection, correction round-trip and unrelated dead-record preservation. The full runtime/recovery suite retains chat switches, stale scan responses after edits/manual mutations, deletion during upload, newest-write wins, rename, exact sibling snapshots, owner ambiguity, recovery and migration tests. The production runtime additionally exercises focused-zero initialization, unarchived death, Refresh checkpoint safety, rejected focused/Refresh/backfill revival, persistence and manual correction.

## Executed verification

Local environment: Node.js `24.11.1`, Python 3, no added npm dependencies. All fixtures use temporary synthetic data.

| Check | Result |
| --- | --- |
| `npm test` | 495 unit tests passed, plus compatibility, runtime and migration smoke checks |
| Pinned numerical oracle | 41,070/41,070 output cases matched |
| `npm run validate` | Passed; 20 declared active runtime JS modules |
| `npm run measure:prompts` | Passed; estimates below |
| `npm run package` | Passed; archive inventory, bytes and JS syntax verified |
| `git diff --check` | Passed |

| Constructed fixture | Stage 4 baseline | Stages 5-7 |
| --- | --- | --- |
| Minimal scanner, including system | 6,890 chars / ~1,969 tokens | 6,886 chars / ~1,968 tokens |
| Rich first encounter scanner | 7,795 chars / ~2,229 tokens | 7,791 chars / ~2,228 tokens |
| Accepted-characterization injection | 1,637 chars / ~468 tokens | 1,637 chars / ~468 tokens |

The scanner change is removal of OOC wording, not a demonstrated latency or provider-cost improvement. Conditional focused passes, repair and retry requests still count as real work. No live model, image provider, real SillyTavern browser, or user database was exercised. UI responsiveness and real-provider semantic quality remain unmeasured. Exact-commit ordinary CI is the publication gate; the PR and workflow records carry those results and the final package checksum.
