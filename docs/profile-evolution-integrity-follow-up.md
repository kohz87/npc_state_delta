# NPC State Delta profile-evolution integrity follow-up

Status: implementation and deterministic verification complete on the local unreleased 1.0.27 tree. This document does not declare a release, publication, live-provider acceptance, or application-version bump.

## Reviewed baseline

The work started from local candidate `6752d666d61b711dc34674408cfed7e82636b376` and reviewed remote main `e773e35da0eed488849f3f562cbd1075e6ca0acd`, which shared tree `eda079d2eb2ea7b2ab297d436bbb81cc727968af`. The existing review artifacts under `dist/` were read before implementation. Their probe asserted the known broken behavior, so its successful exit code was treated only as reproduction evidence, not acceptance.

## Findings and dispositions

### 1. Unsupported durable meaning riding through refine

Disposition: fixed in `core-mechanics.js`.

Refinement now proves newly introduced durable meaning against the supplied development context and bounded field evidence instead of treating preservation of enough old tokens as authority for arbitrary additions. Personality and Speech retain their existing safety gates and full-current-summary replacement semantics after admission. Behavioral Profile applies the same source-grounding principle atomically per proposed changed/new rule. Directly supported clarification may still land on first observation; the three-observation gradual-development threshold is not imposed on every grounded refinement. Morality detection also recognizes bounded intervening wording such as `enjoys inflicting pain`.

Nearby controls preserved: grounded dry-humor and honorific refinements still apply, manual locks and explicit/gradual/batch development stay on their established paths, and no extra provider request/classifier/summarizer was added.

### 2. Accepted current Appearance overwritten by stale named form

Disposition: fixed in `appearance.js`.

A grounded flat current `appearance` update is reconciled into the active canonical current-presentation slot before the resolver rebuilds the compatibility/display scalar. For an established selected form it updates that form only; for an unnamed current presentation it updates `unclassifiedAppearance`. Simultaneous form selection targets the newly selected established form and cannot leak the prior form's outfit/anatomy. A flat update does not fabricate a named form whose own form details failed grounding, and unrelated named forms/shared traits remain isolated.

Regression coverage verifies resolver, roleplay injection, portrait prompt, form storage, and profile application accounting agree on the final accepted presentation.

### 3. Shared appearance duplication

Disposition: fixed in `appearance.js`.

Shared form-independent appearance is now removed from a form-local description when the same normalized clause or exact leading word sequence is repeated across normal punctuation/whitespace boundaries. The comparison deliberately avoids loose keyword overlap, preserving negation and genuinely distinct form details. Normalization remains idempotent. Resolver, roleplay injection, and portrait prompt projections are covered.

### 4. Resolved collective Important Bonds remain beside named members

Disposition: fixed in `social.js`.

A plural collective relationship is retired only when graph provenance proves one unique matching group, the expected member count is satisfied, and no unresolved slot remains for that group. The group dynamic is retained by enriching the owner-side named member edges before projection. Partial resolution keeps the collective entry and unidentified slot. Unrelated unresolved relationships such as `Late Husband` remain. Membership is never inferred from surname, age, proximity, or name similarity.

Nearby controls preserved: the two children remain distinct NPCs; repeated reconciliation is idempotent; manual locks/deletion and graph-confidence behavior remain; and explicit scanner daughter/mother edges still repair a previously reversed dossier direction without introducing global relation inversion.

### 5. Reordered collections consume novel evidence

Disposition: fixed in `core-mechanics.js` and `core.js` diagnostics.

Mannerisms and Behavioral Profile now compare canonical collection meaning independently of presentation order. Reordering alone is not semantic development and keeps the accepted current ordering. Evidence consumption is calculated against the accepted final collection claim by claim, so a partial valid refinement consumes only represented evidence and leaves unrelated novel evidence pending. Secondary diagnostics use the same semantic collection comparison and final accepted collection for `candidateChanged`, `candidateAlreadyRepresented`, `evidenceAlreadyRepresented`, and `evidenceResolved`.

Both Mannerisms and Behavioral Profile have reorder and partial-refinement regressions.

### 6. Evidence label treated as proof of evidence body

Disposition: fixed in `core-mechanics.js`.

`durableProfileEvidenceAlreadyRepresented()` now requires the substantive evidence body to be represented. A matching concept label is organization metadata only. Coverage also checks bounded polarity/negation conflicts and existing personality morality conflicts. Genuinely equivalent evidence still resolves without cosmetic field rewriting.

Regression coverage includes matching labels with novel bodies, contradictory bodies, equivalent bodies, and the existing Speech copied-candidate control. The Speech ledger continues to retain a novel body and report `waiting-for-revised-candidate` when the provider copies the old full candidate.

## Version synchronization contract

Application-version synchronization is now explicit in `docs/core-contract.md`, operationalized in `AGENTS.md` and `DEVELOPMENT.md`, and strengthened in `scripts/validate.mjs`.

Current application-version authorities are:

- `manifest.json` -> `version`
- `package.json` -> `version`
- `runtime-modules.json` -> `applicationVersion`
- `core.js` -> `NPC_STATE_VERSION`
- `bootstrap.js` version banner

Release-facing current markers include the README title/package instructions, top changelog release entry, DEVELOPMENT current-release section, package name, and current-version tests. Validation now additionally checks the bootstrap banner, top changelog version, and DEVELOPMENT current-release version against the manifest. Persisted bundle/storage/branch/diagnostic/journal versions remain independent. Historical reviews, provenance records, migration fixtures, and old-version regressions retain the versions they actually describe and must not be globally rewritten.

This implementation remains application version 1.0.27 because publication/release/version-bump authority was not granted.

## Verification

Final changed-tree checks:

- `npm test`: 738/738 PASS
- compatibility contract: PASS
- lifecycle hardening contract: PASS
- isolation check: PASS
- active runtime inventory/layout: PASS
- runtime smoke: PASS
- migration smoke: PASS
- `npm run validate`: PASS, 31 declared runtime JavaScript modules, including strengthened current-version consistency checks
- `npm run measure:prompts`: PASS with the released 1.0.27 measurements unchanged
  - minimal-one-npc: 6,864 chars / estimated 1,962 tokens
  - rich-first-encounter: 7,769 / 2,222
  - Refresh two-target common prefix: 8,949 chars
  - same-target changed-dossier common prefix: 9,259 chars
  - consecutive ordinary-scan common prefix: 6,839 chars
  - accepted characterization injection: 1,637 chars / estimated 468 tokens
- `node scripts/measure-stage9.mjs`: PASS through the same production capture harness; scanner/full-window/Refresh/backfill/import/focused-relationship/retry hashes, request counts, route options, and response allowances remain unchanged from 1.0.27
- `npm run package`: PASS using a temporary untracked Windows `python3.cmd` forwarding to installed `py -3`; shim deleted immediately
  - archive: `npc_state_delta-1.0.27.zip`
  - runtime modules: 31
  - bytes: 337,181
  - SHA-256: `a41865af1b0db9d7c09786e6b75f6fee9702fc3dc7c204b2a0658e2a7e055ca7`
  - contents, CRC, JavaScript syntax, byte identity, and runtime inventory verified

No scanner/Refresh prompt wording, stable-prefix ordering, request count, retry count, output allowance, reasoning ownership, persistence schema, branch lineage, native bundle format, or relationship scoring formula was changed.

## Remaining live boundaries

These fixes are verified deterministically with production functions and synthetic repository/runtime harnesses. No paid provider call was made. Real Gemini extraction quality, provider latency/cache-hit telemetry, live SillyTavern interaction, physical-device UI behavior, and image-provider integration remain separate live acceptance boundaries.
