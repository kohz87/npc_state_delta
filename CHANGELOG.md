# NPC State Delta changes

## Unreleased

## 1.0.50 - 24 September 2026

- Replace the single portrait Custom slot with a persistent named Custom Preset Library, bounded to 24 entries.
- Migrate the exact legacy Custom positive/negative/composition/format/mood/location values into `Custom 1` on settings schema v30.
- Add Add, Duplicate, Rename, Delete, and selector controls; the last custom preset cannot be deleted.
- Store positive style, negative prompt, composition, prompt format, mood inclusion, and location inclusion per custom preset; keep portrait-generation enablement and SillyTavern gallery saving global.
- Preserve per-NPC temporary portrait prompt drafts and built-in theme presets. Dirty preset switching asks before discarding unsaved edits.
- No scanner/provider prompt, relationship, dossier-state, request-topology, or RP-injection changes.


## 1.0.49 - 24 September 2026

- Render scanner-compatible flat current Appearance as a read-only dossier `Current presentation` fallback when no named/unclassified current presentation exists, instead of hiding valid captured detail behind an empty forms panel.
- Keep form identity unchanged while displaying the fallback, preserving species-aware portrait behavior and existing named/unclassified form semantics.
- Add regressions for existing scalar-only records, future flat scanner Appearance updates on form-less NPCs, and portrait species preservation.
- No model-facing prompt bytes or request topology change from 1.0.48.


## 1.0.48 - 24 September 2026

- Require existing NPCs with explicit new/corrected/current visual evidence to emit `appearance` and `evidence.appearance` in the same `profileUpdates` row, even when other durable profile fields are returned.
- Add a dedicated Appearance diagnostic row that distinguishes `not-provided`, `candidate-missing`, `locked`, `unchanged`, `unchanged-or-gated`, and applied outcomes.
- Make Appearance diagnostics search both ordinary `npcs` and `profileUpdates` channels so a profile row cannot hide an Appearance update carried by the ordinary delta.
- Preserve Appearance as immediate current-visible continuity rather than adding it to the Personality/Speech three-observation development ledger.
- Record the reviewed model-facing footprint versus 1.0.47: routine scanner/full-window +2 characters and scanner-shaped retry captures +2; targeted Refresh, backfill, dossier import, focused relationship, and RP injection remain unchanged.


## 1.0.47 - 24 September 2026

- Fix Appearance extraction so grounded current visual presentation includes directly described hair/body traits, current outfit/gear, and relevant visible condition instead of being suppressed by the durable-identity firewall.
- Treat explicit visual reveal/correction wording, such as an obscured hair color being shown to be different, as a source-grounded Appearance refinement that can replace the mistaken prior impression without requiring high lexical overlap.
- Allow grounded `appearanceState:"change"` updates for clothing/current-presentation changes without routing them through Personality/Speech development-scale readiness; existing evidence grounding, form ownership, locks, and unsupported-rewrite rejection remain in force.
- Add regressions for corrective hair-color narration, changed clothing/boots, scanner prompt guidance, and bounded roster overhead. Record the reviewed model-facing footprint versus 1.0.46: routine scanner/full-window +102 characters, targeted Refresh +221, backfill +71, dossier import +34, and scanner-shaped retry captures +102; focused relationship and RP injection remain unchanged.

## 1.0.46 - 23 September 2026

- Add canonical NPC gender as optional stable identity metadata with only `male`, `female`, or blank for unknown/not yet established. Scanner, Refresh, backfill, and structured dossier import may establish it only from explicit wording or an unambiguous gendered identity/reference; names, occupations, clothing, body type, species, and generated portraits cannot infer it.
- Preserve established gender by default and require explicit correction state/reason before an automatic scan can flip it. Carry the field through candidates, rollback/native bundle state, manual editing, search, and roleplay injection without changing persisted format versions.
- Show identity as `Species · Gender · Role · Age/Looks` and add gender to the cast rail. Portrait prompts now place gender immediately after species and before apparent age/appearance/role so image generation no longer receives an under-specified subject when gender is known.
- Add end-to-end regressions and advance synchronized application/package/display metadata to 1.0.46.
- Record the intentional model-facing footprint: routine scanner/full-window +59 characters, targeted Refresh +188, backfill +161, dossier import +149, and scanner-shaped retry captures +59; focused relationship and RP injection remain unchanged, as do request counts, response allowances, route options, and reasoning ownership.

## 1.0.45 - 22 September 2026

- Restyle the Portrait seed control as a compact dark-theme panel so the browser-default white number input no longer breaks the Portrait dialog's visual hierarchy.
- When the seed field is blank, choose a fresh safe-integer generation seed inside Delta before calling SillyTavern Image Generation, display that exact generation seed beside the preview, and offer **Save as NPC seed** for one-click reuse. Existing saved seeds remain fixed and continue to pass through `/imagine seed=<n>`.
- Keep generated seed provenance preview-scoped and outside scanner/roleplay state until explicitly saved; add focused UI/seed regressions and advance synchronized application/package/display metadata to 1.0.45 with persisted format versions unchanged.

## 1.0.44 - 22 September 2026

- Add an optional persisted per-NPC Portrait seed in the maintained Portrait tool. Blank keeps SillyTavern default/random behavior; a saved non-negative safe integer is passed through the native `/imagine seed=<n>` argument, including ComfyUI workflows that consume `%seed%`.
- Keep seed state outside roleplay/scanner prompts and preserve host ownership of checkpoint, workflow, sampler, resolution and other image settings; fixed seeds improve repeatability but do not guarantee identity if those inputs change.
- Stabilize the Data & maintenance action order as `Scan dossier now` → `Full scan current cast` → `Clear chat dossier`, add seed/order regressions, and advance synchronized application/package/display metadata to 1.0.44 with persisted format versions unchanged.

## 1.0.43 - 22 September 2026

- Fix the remaining full-cast settings race by re-homing an already-rendered `Full scan current cast` button into Data & maintenance after cohesive settings normalization, instead of only choosing the correct container at first creation.
- Listen to the existing `npc-state-delta:settings-mounted` lifecycle event and add a regression covering the re-home path.
- Advance synchronized application/package/display metadata to 1.0.43 with persisted format versions unchanged.

## 1.0.42 - 22 September 2026

- Move the settings-level manual `Full scan current cast` action into Data & maintenance beside `Scan dossier now`, instead of mounting it as a standalone row outside the section.
- Keep automatic full-cast configuration under Scanning and the delegated Diagnostics shortcut intact; add focused ownership regression coverage.
- Advance synchronized application/package/display metadata to 1.0.42 with persisted format versions unchanged.

## 1.0.41 - 22 September 2026

- Restore the manual `Full scan current cast` follow-up action to the Diagnostics modal. Diagnostics emits a small internal request event; `full-cast.js` remains the only owner of full-cast scan execution.
- Preserve the existing automatic full-cast toggle under Scanning and `Scan dossier now` under Data & maintenance, and add focused regression coverage for the diagnostics/full-cast bridge.
- Advance synchronized application/package/display metadata to 1.0.41 with persisted format versions unchanged.

## 1.0.40 - 22 September 2026

- Restore the manual `Scan dossier now` action to Data & maintenance for follow-up/recovery use, while keeping the optional `Full scan current cast` action in Scanning and Portrait generation free of unrelated controls.
- Add focused settings-group ownership regression coverage and advance synchronized application/package/display metadata to 1.0.40 with persisted format versions unchanged.

## 1.0.39 - 22 September 2026

- Make Comma tags genuinely tag-oriented: omit appearance prose fragments already represented by extracted visual anchors while retaining unparsed appearance fragments, and add `loose hair` / `hair ribbons` coverage for common hair-state wording.
- Fix optional `Full scan current cast` UI ownership so it mounts into the Scanning action group instead of the first generic settings action container, preventing it from appearing under Portrait generation.
- Add focused regressions for pure tag output, retained unparsed fragments and full-cast Scanning ownership; advance synchronized application/package/display metadata to 1.0.39 with persisted format versions unchanged.

## 1.0.38 - 22 September 2026

- Strengthen Comma tags portrait prompts by promoting explicit visual anchors from accepted appearance prose into standalone subject-first tags before the prose fallback. Hair color/form, eye color, pointed/human ears and bounded direct body/build traits are extracted conservatively without replacing the accepted appearance source.
- Preserve explicit multicolor hair as one combined standalone anchor when the dossier states it that way, and keep contradiction negatives evidence-bound so an explicitly present color component is never negated.
- Add regression coverage for the live auburn half-elf clerk prompt and golden-blue multicolor hair, then advance synchronized application/package/display metadata to 1.0.38 with persisted format versions unchanged.

## 1.0.37 - 22 September 2026

- Clean up Settings action grouping: move Scan dossier now into Scanning, Add NPC into Roster & cleanup, and Clear chat dossier into Data & maintenance so unrelated controls no longer appear visually attached to Portrait generation.
- Advance synchronized application/package/display metadata to 1.0.37 while leaving persisted format versions unchanged.

## 1.0.36 - 22 September 2026

- Make portrait prompt assembly deterministic and subject-first: accepted identity/current appearance lead role, clothing, mood, location and composition, with global positive style last; strip tag-format metadata labels, deduplicate repeated strong-boundary clauses, and derive only explicit safe contradiction negatives for stated hair colors or explicit absent anatomy.
- Add native portrait generation to the maintained Portrait tool through SillyTavern Image Generation. The edited dossier-derived positive/negative prompts are handed to the existing host `/imagine` bridge, so ComfyUI/A1111/other configured backends remain owned by SillyTavern rather than Delta. Re-expose the existing generation enable and gallery controls in the cohesive settings surface. Force `extend=false edit=false` for Delta portrait requests so SillyTavern cannot LLM-rewrite grounded appearance traits before backend generation; host-global Prompt Prefix / Negative Prompt and backend settings still apply.
- Keep generated images preview-only until explicit **Use as Portrait**. Closing/switching chats or superseding an in-flight action invalidates late results; accepted previews reuse the canonical portrait validation/compression/persistence path and retain the existing 16 MB input boundary.
- Retire the obsolete dossier `importance` field and generic per-NPC `manual` boolean. Historical values are accepted as input only long enough to normalize them away; current story salience, scoped profile locks, and typed manual provenance remain authoritative.
- Add durable Home Base / Usual Location as ongoing-life geography distinct from live Location. An established Home Base is keep-by-default and requires a grounded explicit update/reason to relocate.
- Consolidate appearance ownership: the flat `appearance` scalar remains a compatibility/resolved projection for historical records and scanner interoperability, while new manual editing and dossier presentation use Shared Appearance, named forms, Current Form, and unclassified current presentation without a duplicate flat editor/display.
- Clarify dossier presentation labels to Behavioral Levers, Player Dynamic, Condition / Activity, and Hide present-NPC card; group Birthday and Home Base with identity continuity.
- Keep Important Memories as the bounded five-event episodic continuity channel and preserve relationship event history / last relationship change unchanged.
- Advance synchronized application/package/display metadata to 1.0.36 while keeping persisted storage, bundle, branch, rollback-journal and diagnostic schema versions unchanged. Deterministic Stage 9 measurement retains the reviewed Home Base prompt delta: routine/full-window +193 characters, targeted Refresh +272, backfill +315, dossier import +218; focused relationship and RP injection are unchanged, as are request counts and response allowances.

## 1.0.35 - 19 September 2026

- Recover a narrowly safe Behavioral Profile refinement when the provider returns a changed full candidate but leaves `behaviorProfileState` at `keep`: every established rule must still be present verbatim, only additive target-general rules may be admitted, every new rule must be grounded by that field's evidence, and existing agency/morality conflict guards remain authoritative.
- Preserve rejected/unsupported Behavioral Profile evidence for later scans rather than treating `keep` as replacement authority. Diagnostics label accepted recovery as `applied-recovered-refine`.
- Clarify routine scanner and targeted Refresh prompts that one story observation may independently support multiple durable fields, so a scene can emit both Speech evidence and Behavioral Profile evidence when cadence/wording and a target-general behavioral strategy are both grounded.
- Record the intentional prompt-budget change: routine/full-window requests are +30 Delta-owned characters, targeted Refresh is +120, request counts/output allowances/routes are unchanged, and reviewed Stage 9 hashes are updated accordingly.
- Advance synchronized application/package/display metadata to 1.0.35; persisted storage, bundle, branch, rollback-journal and diagnostic schema versions remain unchanged.

## 1.0.34 - 18 September 2026

- Fix automatic per-NPC backfill storms resurfacing after update/reload because pre-1.0.34 unscoped `pendingBackfills` could remain persisted and were drained after later assistant receipts even when no new scan was due.
- Version and reason-scope automatic backfill work as `missed-participant` or `new-admission`; discard legacy/unversioned pending backfill entries during hydration instead of replaying obsolete cast-wide work.
- Revalidate automatic missed-participant retries against the exact owning exchange before dispatch. Manual Scan dossier/history repair remains explicitly available and is not subject to automatic-queue provenance rules.
- Bound omitted-established-participant automatic continuity repair to at most one target per broad scan. If multiple apparent omissions are detected, suppress that per-NPC fallback rather than allowing an implicit Full Cast fan-out; newly admitted dossiers retain their own targeted enrichment.
- Advance synchronized application/package/display metadata to 1.0.34; scanner prompt bytes and persisted dossier/bundle/branch/rollback-journal/diagnostic schema versions remain unchanged.

## 1.0.33 - 18 September 2026

- Fix portrait prompts being silently truncated at several independent layers: 2,400-character global style settings, 1,800-character builder/override limits, 800/1,200-character composition limits, and final 6,000-positive / 4,000-negative assembly caps.
- Raise global positive/negative style and per-NPC portrait override safety limits to 12,000 characters and composition to 6,000 characters, with the same limits used by settings persistence, dossier normalization, portable native settings, and UI inputs.
- Remove the redundant final assembled-prompt truncation so all bounded prompt components reach the portrait editor, clipboard workflow, and native `/imagine` handoff intact; provider/backend limits remain owned by SillyTavern Image Generation.
- Add regressions proving positive prompts beyond 6,000 characters, negative prompts beyond 4,000 characters, long per-NPC overrides, and portable prompt settings preserve their tail content.
- Advance synchronized application/package/display metadata to 1.0.33; persisted storage, bundle, branch, rollback-journal and diagnostic schema versions remain unchanged.

## 1.0.32 - 18 September 2026

- Fix automatic established-NPC continuity repair treating names inside World State, NPC Inner Chatter, roster/status blocks, and other structured evidence listings as narrative participation.
- Keep structured evidence fully available to the broad scanner and targeted backfill prompts, but require real narrative participation before an omitted established dossier can be auto-backfilled.
- Add regression coverage for raw `<World_State>` blocks, World State `<details>` blocks, and mixed narrative-plus-structured exchanges; retain targeted new-dossier enrichment and explicit current-participant repair.
- Advance synchronized application/package/display metadata to 1.0.32; persisted storage, bundle, branch, rollback-journal and diagnostic schema versions remain unchanged.

## 1.0.31 - 18 September 2026

- Narrow automatic new-NPC enrichment to the newly created/promoted dossiers instead of treating admission as a cast-wide deep-reconciliation checkpoint. Established NPCs are no longer individually backfilled merely because another NPC was admitted.
- Preserve silent targeted continuity repair for established NPCs that the broad current-exchange scan actually omitted, plus manual Refresh/Scan and the separately opt-in current-cast workflow.
- Remove the retired `deepSweep` queue flag and add regression/contract coverage so new admission cannot reintroduce per-NPC fan-out across the established cast.
- Advance synchronized application/package/display metadata to 1.0.31; persisted storage, bundle, branch, rollback-journal and diagnostic schema versions remain unchanged.

## 1.0.30 - 16 September 2026

- Fix destructive message rollback when SillyTavern emits `MESSAGE_DELETED` or `MESSAGE_EDITED` before its in-memory chat lineage has finished changing. Delta now keeps the destructive event pending until the host exposes the committed narrative mutation instead of consuming the event against the stale latest lineage.
- Derive the rollback boundary from the observed post-mutation narrative lineage before invoking the existing branch reconciler. Tail/middle deletion and edit therefore reach the established exact journal/checkpoint recovery path without relying on fixed 70/110 ms delays or callback message-index timing.
- Preserve fail-closed recovery semantics: if the host never exposes a matching destructive lineage mutation within the bounded settlement window, keep canonical dossier state rather than rolling back against stale or ambiguous chat data. Chat switches cancel pending settlement.
- Add runtime regression coverage for the real event order: deletion event first, unchanged host chat for 120 ms, then host truncation. The test proves no premature rollback before mutation and exact state restoration afterward; focused settlement tests cover both host event orders, edits, rapid destructive events, timeouts and chat switches.
- Keep the 1.0.29 dossier-evolution fixes, 1.0.27 prompt arrangement, request counts, response allowances, provider routing, relationship scoring, and persisted storage/bundle/diagnostic/rollback/branch schemas unchanged.

## 1.0.29 - 16 September 2026

- Close the six remaining dossier-evolution defects found after the 1.0.28 review while preserving the existing scanner/Refresh request architecture and prompt bytes.
- Route accepted flat Appearance updates through the same durable grounding/admission protections as the canonical mechanics owner, so a rejected unsupported candidate cannot be revived by facade reconciliation while valid form selection remains supported.
- Make durable refinement grounding claim-complete and target-NPC-specific: unsupported clauses cannot piggyback on a supported clause, and another NPC's evidence cannot authorize the target through shared wording or stripped labels.
- Make evidence coverage directional and clause-polarity aware, so a shorter accepted summary cannot erase a longer novel observation and unrelated negation cannot poison or falsely satisfy a separate predicate. Copied Personality/Speech candidates keep unresolved evidence until it is genuinely represented.
- Require explicit per-member proof before already-resolved Important Bonds inherit collective semantics such as twins; preserve edge direction repair, partial/ambiguous groups, unrelated bonds and idempotent graph projection.
- Preserve Shared appearance grammar when removing duplicated prefixes, including visibility, copular and negation predicates such as `are not visible`, rather than emitting detached fragments.
- Add regression coverage for the repaired appearance, refinement-scoping, evidence-directionality, polarity, collective-bond and Shared-prefix cases. Persisted storage, bundle, diagnostics, rollback, branch schemas, relationship scoring and provider request budgets remain unchanged.
- Advance synchronized application/package/display metadata and current-version assertions to 1.0.29; retain all 1.0.28 review/provenance material as historical evidence.

## 1.0.28 - 16 September 2026

- Harden durable `refine` so preserving established wording no longer authorizes unsupported new Personality, Speech, Appearance, or Behavioral Profile meaning. Newly introduced claims must be grounded in supplied story/evidence; directly supported clarification still applies immediately without forcing gradual-development thresholds, and morality/agency protections remain authoritative.
- Reconcile accepted flat current Appearance output into the canonical selected presentation before display resolution, preventing an unchanged named form from restoring stale clothing/anatomy. Preserve named-form isolation, unnamed-current handling, Shared traits, locks, and simultaneous form-selection safety.
- Deduplicate repeated Shared appearance clauses across ordinary punctuation/whitespace boundaries with exact semantic phrase matching rather than loose keyword overlap, preserving negation and genuinely distinct form detail across dossier, portrait, scanner-context, and roleplay projections.
- Consolidate fully proven collective Important Bonds into their resolved named counterparts while carrying useful group dynamics onto those graph edges. Partial resolution keeps the remaining collective entry, unrelated unresolved bonds remain intact, and explicit scanner daughter/mother direction repair stays authoritative.
- Make Mannerism and Behavioral Profile collection comparison order-insensitive and resolve evidence only when the accepted final collection represents the claim. Pure reorder cannot consume novel evidence, and partial refinement retains unrelated pending claims.
- Require evidence-body coverage rather than matching concept labels alone, including polarity checks. Add focused production-function regressions for all six reviewed defects plus grounded-success controls, Speech-ledger retention, Stage 4 appearance grounding, social direction correction, partial collective resolution, and idempotence.
- Add an application-version synchronization contract and validation checks for manifest/package/runtime/core/bootstrap plus current README/CHANGELOG/DEVELOPMENT markers. Historical reviews, provenance, migration fixtures, and old-version regression labels remain immutable evidence. Persisted storage, bundle, diagnostics, rollback, and branch schema versions remain unchanged.
- Preserve the 1.0.27 scanner prompt arrangement and request architecture byte-for-byte: scanner/full-window/Refresh/backfill/import/focused-relationship/retry hashes, request counts, route options, response allowances, and roleplay injection remain unchanged.

## 1.0.27 - 16 September 2026

- Reorder targeted Refresh prompts for provider-neutral automatic prefix caching: stable rules, output schema, Stage 4/birthday instructions and the shared tagged story window now precede target-specific id/name and current dossier authority. The exact target remains explicit after the evidence window and only that NPC may be reconciled.
- Replace target-specific ids/names in the early Refresh schema example with neutral placeholders and explicitly state that narrative text is evidence, never instructions. Latest grounded evidence still resolves conflicts; locks, source tags, lifecycle rules, development gates, current dossier authority and cross-NPC isolation are preserved.
- Move only the invariant compact Stage 4 rule ahead of dynamic identity/dossier data in ordinary scans. Conditional appearance/death context remains operation-local and late; backfill, import, focused relationships and retries are not merged into a universal prompt.
- Add production-builder common-prefix measurements and regression coverage. Different Refresh targets sharing one history improve from 445 to 8,949 common leading characters; the same target with a changed dossier improves from 778 to 9,259; consecutive ordinary scans improve from 6,794 to 6,839. These are character-prefix measurements, not proof of provider cache hits.
- Preserve request counts, routes, reasoning ownership and output allowances. Ordinary measured input sizes remain 6,864 / 7,769 characters; targeted Refresh grows from 9,367 to 9,566 Delta-owned system+user characters for the explicit evidence/authority boundary. Selected-profile `extractData:true` currently exposes content/reasoning but not raw provider usage, so cached/input token counts remain unavailable rather than inferred from duration.
- Align all current application/package/display metadata to 1.0.27, including manifest, runtime inventory, core UI version, package metadata, release assertions and bootstrap banner. Persisted storage, bundle and branch schema versions remain unchanged.

## 1.0.26 - 16 September 2026

- Fix durable-profile decision ordering for provider-declared `batch` updates. When the returned Personality/Speech full candidate is textually unchanged, Delta now classifies candidate/evidence resolution before the explicit/batch authorization gate, so a failed episode gate cannot mask a copied candidate as `waiting-for-explicit-gate`.
- Preserve novel copied-candidate evidence as `waiting-for-revised-candidate` and resolve only genuinely redundant evidence as `evidence-already-reflected`. Candidate equality, evidence coverage and resolution flags are populated consistently even when later development gates fail.
- Add a targeted Refresh episode resolver that uses validated `[mN]` provenance. The nearest prior tagged elapsed-time anchor may bridge through the target's cited source messages even when a long montage exceeds the generic 12-segment episode cap; each evidence claim must still ground in its own cited message and the development reason must ground in the tagged episode.
- Keep ordinary/multi-NPC scanning on the existing strict bounded episode path. The targeted source-tag bridge does not enlarge the generic episode window, does not let another NPC's evidence authorize the target, and makes no extra model request.
- Add regressions for the live Sora copied-candidate gate-order shape, redundant-evidence resolution, and a targeted `[m202]` to `[m204]` development episode containing more than twenty intervening sentence segments. No scanner/Refresh prompt text, output allowance, persistence schema, native bundle, branch lineage or relationship formula changes are introduced.

## 1.0.25 - 16 September 2026

- Fix the copied-candidate false resolution exposed by live Sora diagnostics. An unchanged Personality/Speech candidate can no longer consume a ready batch/aggregate evidence epoch merely because the provider labelled it `refine`/`batch`; Delta now proves that every bounded evidence claim is already represented by the accepted current field before reporting `evidence-already-reflected`.
- When an unchanged candidate still omits supported development, preserve its Personality/Speech ledger and profile evidence and report `waiting-for-revised-candidate`. Mannerism/Behavioral Profile refinement likewise retains novel field evidence when the returned full list is unchanged, instead of discarding that evidence during refinement cleanup.
- Tighten the scanner/Refresh provider contract without another request: `refine`/`evolve` must return a changed full candidate when durable development is genuinely new, while evidence that only reinforces the current profile should be omitted/kept. Batch chronology does not force cosmetic wording churn.
- Advance compact diagnostic export to version 3 with `evidenceAlreadyRepresented`, keeping `candidateAlreadyRepresented` separate from evidence coverage so copied stale candidates are directly distinguishable from genuinely redundant evidence.
- Add live-shape regressions for copied Sora Personality/Speech batch candidates, collection evidence retention, genuinely redundant evidence, and the provider consistency rule. The reviewed Stage 9 scanner fixture is one character smaller than 1.0.24 and targeted Refresh is 17 characters smaller; request counts, output allowances and roleplay injection are unchanged. No persistence schema, native bundle, branch lineage or relationship formula changes are introduced.



## 1.0.24 - 16 September 2026

- Fix the remaining time-compressed `refine` gap exposed by live Sora diagnostics. Refresh/routine prompts now require `developmentReason` when a refine/evolve/change relies on elapsed sustained development, while the backend can deterministically recover an effective reason from field-specific evidence when the provider still omits it.
- Keep that recovery candidate-specific. Mannerisms and Behavioral Profile must ground each newly proposed entry from their own evidence before inferred-batch semantics can authorize it; unrelated evidence in the same field or shared episode cannot license a different new habit/rule.
- Resolve fragmented aggregate Personality/Speech evidence that is already represented by the accepted current candidate. Only the aggregate-fallback case is consumed/reset; ordinary concept-ledger readiness keeps the existing `waiting-for-candidate` behavior until a materially changed candidate arrives.
- Expand profile diagnostics with candidate-changed/already-represented state, provider/effective reason source, resolved-evidence state, and candidate/reason grounding. Secondary Mannerism/Behavior diagnostics use the same effective-reason and candidate-specific checks as application.
- Reduce birthday diagnostic noise by omitting unrelated NPCs that merely share a transcript containing birthday language. Relevant rows now include previous/current birth date, birth-year source, calendar age, reference date, age/birth-date state and supplied-date flags for easier chronology debugging.
- Add regressions for the reported Sora missing-reason Mannerism case, unrelated-evidence rejection, aggregate already-reflected cleanup, Refresh contract wording and birthday diagnostic filtering/details. No extra model request, storage-schema bump, native-bundle change, branch-lineage change or relationship-formula change is introduced.

## 1.0.23 - 16 September 2026

- Replace sentence-pair-only time-skip grounding with a bounded development episode. Natural elapsed spans may now carry a contiguous montage across later sentences/paragraphs, while a later explicit elapsed anchor, present-scene transition, segment cap or character cap ends the episode. Bare time passage remains non-destructive.
- Make shared elapsed chronology NPC-aware. Each evaluated NPC must ground its own development from name/alias ownership, bounded source-tagged evidence and at most one conservative pronoun continuation; another NPC's evidence cannot authorize the target. Targeted Refresh remains one-NPC and normal multi-NPC scans may independently evolve several NPCs inside the same episode.
- Complete ordinary gradual Personality/Speech development with an aggregate field-level fallback. Three independent provenance-bearing observations across the existing minimum span may collectively ground the changed candidate even when the provider uses different concept labels; concept buckets remain separate, replayed sources do not count twice and unrelated observations remain blocked.
- Extend deterministic inferred time-compressed development to the existing Mannerism and Behavioral Profile gates as well as Personality/Speech, without moving Appearance, relationships or current-state fields onto that lifecycle.
- Add always-on bounded operation diagnostics outside canonical dossier/story state. Per-NPC dossier Show/Hide is presentation-only; Data & Maintenance Diagnostics can display, clear and export a versioned compact JSON bundle containing bounded profile/birthday gate decisions while excluding full story text, prompts, credentials and provider payloads.
- Add birthday/aging decision receipts for deterministic advance/hold, including same-day idempotence and the first-establishment guard, without changing v1.0.22 calendar mechanics. Add generalized multi-NPC, cross-NPC isolation, episode-boundary, aggregate-gradual, Mannerism/Behavior, diagnostic privacy/export and birthday-diagnostic regressions. No extra model request, prompt change, storage-schema bump, native-bundle change or branch-lineage change is introduced.

## 1.0.22 - 15 September 2026

- Fix deterministic birthday rollover for an existing dossier when the grounded calendar reaches its stored birthday. Full-year calendar arithmetic now advances chronological age and a compact numeric apparent-age estimate by the same confirmed delta, while manual age/apparent-age locks, provider-explicit chronological corrections, terminal death and provider-explicit apparent-age evolution remain authoritative.
- Recover existing yearless month/day birthdays on their exact narrated birthday or nameday once: advance the accepted chronological age, reanchor the derived birth year, and make repeated same-day scans idempotent. Do not assume a rollover when the birthday is first established in that same scan. Recognize `nameday` / `name day` as birthday evidence for the existing conditional scanner rule.
- Advance Personality/Speech development ledgers to internal version 2 with up to four bounded evidence samples per concept. Three independent observations and the existing provenance span remain required, while candidate grounding can aggregate support across retained samples instead of depending only on `latestEvidence`.
- Prevent replayed source messages from manufacturing historical sample support; v1 ledgers seed one sample from their old `latestEvidence`, cross-chat import clears pending samples with chronology, and accepted evolution still resets the ledger epoch.
- Add regressions for Ryu-style age `13` / apparent `~12` to `14` / `~13` nameday rollover, same-day idempotence, manual/explicit apparent-age authority, new-birthday ambiguity, nameday prompt activation, accumulated Speech and Personality gradual grounding, bounded sample retention, replay protection and cross-chat scrubbing. No extra model request, relationship change, persistence schema, bundle format, or branch-lineage change is introduced.

## 1.0.21 - 15 September 2026

- Fix the live time-skip false negative where Gemini correctly returned `developmentScale: "batch"` and `speechState: "evolve"`, but deterministic validation still rejected natural elapsed phrasing such as `in two months`, `over the past month`, `the past seventy days`, `for two months`, or `one season under ...` as `waiting-for-explicit-gate`.
- Generalize elapsed-duration parsing across day/week/month/year/decade/season units, larger spelled-out quantities, past/previous/last windows, qualified spans and contextual residence/training spans. Keep age statements and bare passage non-authoritative.
- Strengthen batch grounding so the elapsed-time clause or an explicit temporal continuation must carry sustained-development evidence and sufficiently ground the supplied development reason. Weak generic transitions such as unrelated weather `changed` cannot lend their duration to a later one-off behavior.
- Add scoped deterministic development aliases for conservative paraphrases such as schooling/study and training/practice without changing global durable-profile similarity or adding any model request. Verify the same grounded time-compressed Refresh can carry safe Personality, Mannerisms and Behavioral Profile refinements alongside Speech under their existing field gates.
- Add production `mergeScanResult` reproduction of the reported Ryu payload shape plus unit guards for months, years, seasons, past-day spans, comma-separated `in two months` phrasing, age statements, unrelated elapsed events and semantic development wording. Scanner prompt bytes, request counts/retries, output allowances, relationship mechanics, persistence schemas, branch lineage and native bundle format remain unchanged.

## 1.0.20 - 15 September 2026

- Make time-compressed durable development deterministic instead of depending on the provider to emit the exact `batch` + `evolve` combination. When a Personality or Speech candidate is returned as `gradual`/`refine` or `gradual`/`keep`, Delta may infer the existing batch path only when the supplied story context itself proves an elapsed span, sustained development during that span, and a grounded development reason.
- Generalize elapsed-span recognition to named seasons and seasonal ranges such as spring through summer, plus ordinary day/week/month/year/season spans expressed with `during`, `throughout`, or `across`. Expand sustained-development cues around learning, practice, training, study, apprenticeship, progression and mastery without treating bare time passage as development.
- Require an inferred/declared batch recovery candidate to be materially changed and grounded against the supplied field evidence and development context before replacement. Manual locks, Personality morality safety, existing provider-authorized explicit/batch evolution, gradual three-observation ledgers, rollback ownership and native transfer remain authoritative. No extra model request is added and scanner prompts remain byte-stable.
- Add regressions from the reported seasonal Speech transition, prove that seasonal passage alone cannot bypass gradual evidence, and verify the same grounded elapsed-development recovery for Personality so the behavior is field-general rather than character- or Speech-specific.

## 1.0.19 - 15 September 2026

- Replace the Speech-only exact-label development gate with bounded deterministic Personality/Speech ledgers. Unlabeled evidence and conservative semantic concept variants can accumulate without depending on Gemini to repeat one exact label spelling; three independent related observations across the existing minimum provenance span remain required for gradual promotion.
- Make targeted Refresh source-aware inside its configured recent-story window. Refresh lines carry raw `[mN]` message IDs, Gemini may return up to four tagged gradual Personality/Speech observations, and Delta counts a tag only when that raw message actually belonged to the supplied window. Multiple qualifying messages inside one Refresh can therefore contribute independently without pretending they all occurred on the Refresh boundary.
- Let deterministic gradual readiness own the final lifecycle decision: once a ledger is ready, a changed full current Personality/Speech candidate may be promoted even when the provider labels it `refine`/`keep`, but only when the new concepts are grounded in the accumulated evidence. Delta never invents replacement prose when the provider copies the stale current summary; diagnostics report `waiting-for-candidate` instead.
- Preserve accepted v1.0.6 model-authorized `evolve` behavior, explicit/batch gates, manual locks, full-summary safety, rollback and native-bundle cloning. Cross-chat native transfer now rebases pending Personality chronology alongside Speech and cannot carry source-chat message/turn evidence into the target.
- Expose `profileUpdates`, `profileApplied`, `profileEvidenceAdded` and bounded per-field development outcomes in Compact Diagnostics. Add regression coverage for the reported Ryu stale-Speech shape, unlabeled evidence, semantic label variants, multi-message Refresh accumulation, forged source tags and cross-chat Personality/Speech rebasing.
- Deliberately clarify only the targeted Refresh prompt so it asks for tagged independent gradual observations and the best full current candidate instead of blindly copying a stale summary. The measured Refresh request grows by 322 characters; scanner/full-window/backfill/import/relationship/retry request counts, output allowances and roleplay injection remain unchanged. Persisted schemas, branch lineage, numerical relationship scoring and native bundle version remain unchanged.

## 1.0.18 - 15 September 2026

- Make Important Bonds / Key Relationships boundary-safe end to end. Canonical stored bonds now use one 360-character budget and social dynamics use 260 characters, with subject/relation/dynamic parsed before limiting instead of raw slicing a preformatted line.
- Compact dynamics by whole deduplicated fragments. If another fragment will not fit, drop that whole fragment; if a single unavoidable fragment itself exceeds the available space, shorten it at a sentence, clause, or word boundary and mark word-boundary truncation with an ellipsis. Never persist a severed word or dangling `|`, `/`, or `;`.
- Route scanner-edge normalization, hidden social-graph storage, graph projection, ordinary dossier merging, legacy normalization, and manually locked bonds through the same canonical representation so repeated reconciliation cannot progressively shorten a bond. Preserve the existing smaller scanner/injection projections, request counts, prompt bytes and output allowances.
- Add regressions for the reported `telepathic bon` / `authority she resp` failure shape, canonical storage beyond the former 220-character ceiling, over-budget fragment dropping, graph projection and manual-lock idempotence. Persisted schemas, bundle format, branch recovery, relationship scoring and model routing remain unchanged.

## 1.0.17 - 15 September 2026

- Rebase foreign-import activity chronology at the canonical bundle merge boundary. New foreign dossiers begin their inactivity clock at the target chat's current turn, while matching target dossiers preserve their existing target-owned `lastSeenTurn` / `lastWorldActiveTurn`; low or high source-chat counters can therefore neither trigger immediate stale deletion nor grant excessive retention. Prepared/UI imports retain their original source-chat identity until the canonical importer applies this rebasing, without inventing source-message provenance.
- Make missing/`keep` Personality, Speech and Appearance recovery satisfy the same field-specific safety gates as explicit refinement in addition to preserving all established durable concepts. Morality reversals and Speech evolution language such as `no longer` cannot pass merely because old words remain lexically present; legitimate additive keep recovery and explicit accepted full-current `refine` remain supported.
- Preserve mixed protected Behavioral Profile directions instead of collapsing them to neutral. Full-profile refinement now rejects agency or morality reversals atomically across renamed categories, including the bounded `not independent` negation case, while ordinary cooperation with authority is not treated as obedience by itself.
- Clear stale inferred status when a social edge gains explicit/manual authority, keep duplicate/reversed-edge normalization consistent with that promotion, and rank capacity by canonical confidence. At the 240-edge limit, weaker/equal arrivals cannot evict equal- or higher-authority established bonds.
- Promote the deep-scan reproductions into tracked regression coverage, including direct and prepared foreign imports, low/high source clocks, matching/new dossiers, both ordinary and `profileUpdates` profile paths, mixed/negated Behavioral Profile cases, explicit/manual social promotion, mirrored projections, repeated normalization and later capacity pressure. Scanner prompts, request/retry/output budgets, routing, numerical relationship scoring, persisted schemas, branch recovery and native bundle format remain unchanged.

## 1.0.16 - 15 September 2026

- Keep the 1.0.15 full-current `refine` contract explicit: missing/`keep` lifecycle markers use non-destructive compatibility recovery that may add grounded detail but preserves omitted established Personality, Speech or Appearance clauses instead of treating omission as deletion authority.
- Apply the same keep-vs-refine distinction to form-independent overall appearance and named appearance forms. Explicit accepted `refine` still replaces that exact current slot and retires omitted superseded visual clauses.
- Make Behavioral Profile refinement atomic across protected identity directions, not only matching category labels. Agency/autonomy versus obedience/compliance and kindness versus cruelty reversals cannot bypass refinement safety by renaming the category.
- Rebase pending Speech-development chronology on cross-chat native import: preserve accepted Speech/epoch/baseline text, clear source-chat message/turn provenance and pending concepts, and keep same-chat ownership unchanged.
- Make social-graph capacity authority-aware. New edges may evict only strictly weaker continuity and can never displace equal- or higher-confidence explicit/manual relationships merely because the 240-edge cap is full.
- Add focused regressions for ordinary/profile-update unmarked summaries, keep-state appearance forms, renamed Behavioral Profile reversals, cross-chat Speech provenance and full-cap social graphs. Scanner prompts/request budgets, numerical relationship scoring, persistence/storage formats, branch recovery and native bundle schema remain unchanged.

## 1.0.15 - 15 September 2026

- Make accepted durable-profile `refine` results authoritative full CURRENT summaries instead of additive history. Personality, Speech and flat/current Appearance now retire omitted superseded clauses after the existing safety gates accept the incoming full field.
- Treat Mannerisms and Behavioral Profile `refine` payloads as full current bounded lists: omitted old habits/rules retire instead of accumulating forever. Unsafe Behavioral Profile refinements reject atomically and preserve the established profile.
- Apply the same current-summary rule inside named appearance forms and form-independent overall appearance while preserving unrelated named forms. Updating Human Form no longer carries an older Human Form outfit forward into the new presentation.
- Keep evidence/history in `profileEvidence`, memories and their existing histories rather than copying history back into current dossier summaries. Existing evolution/development gates, manual locks and identity/morality firewalls remain authoritative.
- Add regressions for the reported blue-gold-hair school-outfit -> flax-smock/vest/skirt stacking case plus Personality, Speech, Mannerisms, Behavioral Profile and named-form replacement. Scanner prompts/request budgets, relationship scoring, persistence formats, branch recovery and bundle schema remain unchanged.

## 1.0.14 - 15 September 2026

- Make Important Bond normalization idempotent when older data already contains repeated structural pipes or spaced slash fragments. Canonical dynamics split legacy `;`, extra `|`, and spaced ` / ` separators, discard tiny truncation debris, deduplicate semantically repeated fragments, and render one structural `|` only.
- Deduplicate repeated relation fragments such as `Host / Caretaker / Host / Caretaker` without collapsing legitimate distinct relation labels.
- Make manual Important Bond deletion authoritative over the shared social edge: remove the hidden pair and the counterpart's mirrored structured bond in the same transaction so reconciliation cannot immediately recreate the deleted entry from the reverse dossier.
- Recover counterpart identity from the structured subject prefix even when the rest of an old bond is malformed/truncated, so corrupted entries can still be deleted cleanly.
- Add the reported Mistress Hilde corruption as a repeated-reconciliation regression plus delete -> reconcile -> still-deleted coverage. Scanner prompts, request budgets, relationship scoring, persistence formats, branch recovery and bundle schema remain unchanged.

## 1.0.13 - 15 September 2026

- Make destructive linear recovery exact-boundary only. Delete/edit may restore the requested surviving parent from the rollback journal or an exact checkpoint, but an older checkpoint can never substitute for a missing parent and generic root fallback is forbidden.
- Extend journal recovery to near-tail replacement divergence, so an edited/regenerated latest assistant can reconstruct its exact parent even after that full checkpoint was pruned; keep the rollback head owned by the restored parent until the replacement is rescanned.
- Fail closed for deep edits with multiple retained assistant descendants instead of rewinding and discarding later accepted continuity. Preserve the current canonical dossiers, rebase unsafe recovery ownership, and rescan without replacing the retained suffix.
- Preserve swipe semantics: an exact known sibling restores without another scan; an unseen sibling may restore only its exact parent/root anchor and must then be scanned. No arbitrary ancestor checkpoint is accepted.
- Expand bounded reconciliation diagnostics with requested recovery boundary, affected assistant count, journal/checkpoint availability, rejected older checkpoint/distance, retained-descendant blocking, and rescan requirement. Add the observed 123-message regression where edit divergence 99 previously restored message 3 and collapsed 26 NPCs to one.
- Keep the 8 MB / 2 MB full-checkpoint limits, 256-message journal horizon, scanner prompts/request budgets, relationship scoring, storage schema and native bundle format unchanged.

## 1.0.12 - 14 September 2026

- Run a one-time legacy branch-history compaction on existing sidecars after lineage is proven safe. Retain the current active lineage plus SillyTavern-retained swipe alternatives, and remove unreachable pre-1.0.11 sibling checkpoints, inline-card branch residue and rollback-journal chains that are no longer owned by the live head or a retained checkpoint.
- Defer compaction while a destructive lineage divergence is unresolved, then retry after reconciliation, so cleanup never races delete/edit/swipe recovery. Persist a versioned compaction marker and bounded before/after accounting so each sidecar is compacted at most once per compaction version.
- Harden v4-to-v5 branch migration by mapping legacy checkpoint keys only when they match the active host branch or a swipe SillyTavern still retains, preventing old delete/regenerate siblings from collapsing onto the current v5 key while preserving provable swipe alternatives.
- Raise the aggregate full-checkpoint budget from 2 MB to 8 MB and the single full-checkpoint ceiling from 750 KB to 2 MB. The separate 256-raw-message rollback-journal contract and 12 MB diagnostic target are unchanged.
- Expand Compact Diagnostics with current narrative snapshot size, largest checkpoint size, aggregate/max checkpoint limits and the most recent compaction summary. Scanner prompts, request counts/retries/output allowances, relationship scoring, sidecar format and bundle format remain unchanged.

## 1.0.11 - 14 September 2026

- Treat ordinary message deletion/regeneration and edits as linear history replacement: restore the surviving parent boundary, discard descendant recovery artifacts, and do not retain deleted generations as sibling branches. Preserve sibling checkpoints only for explicit SillyTavern swipe events.
- Advance destructive branch lineage to v5 using narrative role/content only. Mutable host `send_date`, generation ids and swipe indexes can no longer manufacture a destructive divergence; v4 sidecars and explicit v4 parent branches retain guarded compatibility during upgrade.
- Fail closed when a divergence has no proven recovery target: keep the accepted canonical dossier and rebase ownership instead of walking backward to an older checkpoint or branch root. First-message explicit swipes retain their intentional root-anchor behavior.
- Add bounded branch-reconciliation diagnostics with operation/relation/action, recovery source, fail-closed state, NPC counts, checkpoint bytes and rollback-journal pressure, without retaining story text.
- Self-clean malformed Important Bonds: reject sentence-like orphan prose, normalize inverse owner/counterpart relation collisions, deduplicate near-identical dynamics, align incoming social-edge direction to established bonds, and preserve manually locked relationships.
- Add stress coverage for scattered delete/regenerate cycles across 20 live messages under full-checkpoint byte pressure, explicit swipe siblings, v4-to-v5 migration/ancestry, passive unexplained divergence and edit replacement. Scanner prompts, request counts, output allowances and relationship scoring remain unchanged.

## 1.0.10 - 14 September 2026

- Retain the newest accepted unsaved state across transient-to-permanent persistence failure, cache eviction and rehydration until a successful durable flush; preserve cancellation, retirement, ownership and revision guards.
- Keep referenced journal versions immutable during same-message consolidation, including net-zero revisits, and retain required predecessors for branch checkpoints and sibling chains.
- Checkpoint deterministic assistant receipt changes at their own message boundary before scanning, so failed/skipped/busy scans cannot move turn ownership to a later user message.
- Protect explicitly confirmed-dead dossiers from stale archive/deletion even when automatic death archiving is disabled; preserve ordinary living 30/50-turn cleanup.
- Add production-function and synthetic-host regressions, clarify the governing contract, and preserve scanner prompts/budgets, scoring, the 256 raw-message horizon, Speech behavior and persisted formats.

## 1.0.9 - 14 September 2026

- Preserve undurable persistence ownership through bounded chat-cache eviction and rehydration. A snapshot recovered after a permanent sidecar rejection now remains locally pending until a later successful flush instead of being incorrectly promoted to durable.
- Add a production-runtime regression for permanent HTTP 413 rejection -> cache eviction through eight other chats -> same-session rehydration -> pending durability -> successful later flush.
- Preserve all 1.0.8 recovery behavior, scanner prompts, request/retry/output budgets, relationship formulas, bundle schema, sidecar format version and branch-lineage version.

## 1.0.8 - 14 September 2026

- Separate recovery lineage classification from strict asynchronous equality checks. A persisted lineage that is an exact prefix of the live SillyTavern chat is now a non-destructive forward extension and cannot restore an older checkpoint/root dossier.
- Change the active journal contract to a contiguous 256 raw-message horizon from a trustworthy baseline, including unchanged user/system boundaries. Add normal alternating-chat regressions for exact 100-message deletion, repeated 50+50 deletion, the 256-message boundary, and failed-scan deletion across a preceding user turn.
- Coalesce repeated canonical checkpoints owned by the same message and replace whole-social-graph journal copies with changed edge/slot undo records while preserving a reader for v1.0.7 full-graph entries. Stress coverage with 40 NPCs/240 edges keeps journal growth bounded by changed data rather than graph size.
- Preserve the newest locally dirty state after a permanent durable-write rejection in the persistence owner, so bounded chat-cache eviction and later same-session hydration cannot silently replace it with an older sidecar; successful later persistence or explicit cancellation clears that recovery shadow.
- Complete stale-removal cleanup by purging owned structured relationship references and delaying portrait-asset garbage collection until checkpoints/journal history can no longer restore the removed NPC.
- Compact active sidecar JSON and build base64 input from chunks instead of repeated giant-string concatenation. Persisted data-file format version, bundle schema and branch-lineage version remain unchanged.
- Preserve scanner prompts, request/retry/output budgets, connection-profile routing, numerical relationship formulas, Speech-development semantics and RP injection. No additional model request or background worker is introduced.

## 1.0.7 - 13 September 2026

- Add a bounded reversible rollback journal beside the existing byte-bounded full branch checkpoints. Journal entries store compact canonical-state undo deltas plus exact lineage/sequence ownership, not transcript text or portrait binaries.
- Make large tail deletion independent of whether the exact surviving full checkpoint remains inside the 2 MB snapshot budget. The active journal can walk backward deterministically through recent mutations and marks the restore exact without another scanner/model request.
- Cover structural rollback as well as scalar fields: NPCs first introduced only in deleted history disappear, downstream social edges/key-relationship references, candidates and pending backfills are cleaned up, while surviving NPC memories, relationship state, appearance/lifecycle and Speech-development evidence return to their earlier values.
- Preserve existing user-owned metadata overlay rules during rollback. A manual portrait/profile override on a surviving NPC remains, but user metadata cannot resurrect an NPC whose narrative existence was rolled away.
- If a scanner fails before its normal checkpoint, immediate tail deletion restores from the prior journal head and the next assistant parent-anchor settles the surviving uncheckpointed turn before advancing. Keep full checkpoints for swipe/sibling/recovery safety and record each checkpoint's journal sequence for branch rebasing.
- Bound the journal to 1,024 recent mutation entries with a contiguous active-history priority and a 12 MB soft budget while retaining at least 384 active entries. Add regressions for an exact 100-message tail deletion after the full-checkpoint target is pruned, plus two successive 50-message deletion batches. Scanner prompts, request counts/retries, relationship formulas, bundle schema and branch-lineage version are unchanged.
- Existing pre-1.0.7 histories establish their journal baseline when loaded; the new journal cannot reconstruct full snapshots that an older build had already discarded before upgrade.

## 1.0.6 - 13 September 2026

- Add a bounded deterministic Speech development ledger inside each canonical NPC record, tracking up to four pending speech concepts with recent turn/source-message provenance rather than retaining transcript history.
- Let three independent observations of the same stable speech concept across a minimum turn span authorize gradual Speech evolution, while replay of the same source message cannot advance the counter and unrelated concepts cannot combine.
- Preserve existing grounded `explicit` and `batch` Speech evolution. When a full Speech replacement is accepted, clear old speech profile evidence and begin a new speech epoch so pre-change observations cannot resurrect obsolete habits.
- Keep a bare time skip non-destructive: without grounded speech development, current Speech and pending evidence remain unchanged. A manual/unlocked Speech baseline change also clears stale pending concepts before later scans.
- Preserve manual Speech locks, native bundle/checkpoint ownership, scanner prompt bytes, request/retry counts, output allowances, numerical relationship formulas and persisted format versions. Add regressions for replay rejection, concept isolation, gradual thresholding, batch reset, bare-time-skip preservation, manual baseline reset and bundle round-trip.

## 1.0.5 - 13 September 2026

- Make manual Key Relationships / Important Bond edits authoritative over the edited NPC's hidden social-graph direction instead of enriching a stale graph edge and projecting old prose back into the dossier.
- Preserve a compatible reverse-side relationship/dynamic for the counterpart while replacing the manually edited owner-side relation and dynamic exactly.
- Normalize `Name — relation; dynamic` into the canonical `Name — relation | dynamic` shape when the relation prefix is a recognized social relation.
- Remove an unstructured orphan line when its full text is already contained in a structured bond entry, preventing duplicated dynamic-only lines from surviving canonicalization.
- Add focused regressions for the demonstrated Ryu/Sora duplicate-line case, same-counterpart manual rewrite, and reverse-side preservation. Scanner prompts, request counts, relationship scoring formulas, persistence formats and bundle schemas are unchanged.

## 1.0.4 - 13 September 2026

- Give direct per-NPC Refresh the same Stage 4 appearance-form output contract already used by the accepted appearance model, including `overallAppearance`, `appearanceForms`, `currentForm` and `currentFormState`.
- Carry the selected NPC's established appearance-form context into Refresh reconciliation and explicitly treat natural anatomical transitions as current-presentation/form evidence even when narration never says `form` or `transform`.
- Preserve alternate anatomy when Refresh observes a visibly different presentation without a stable form name by routing it through the existing unclassified-current presentation instead of overwriting the prior form.
- Keep Refresh strictly one-NPC and one-request: no extra scanner call, completeness pass, relationship scoring change, retry-budget change, persistence owner, or bundle-schema change.
- Add focused regressions for the demonstrated horn/wing/tail disappearance path and preservation of the prior chimeric presentation.

## 1.0.3 - 13 September 2026

- Make Stage 4 appearance-form fields part of the detailed routine scanner return contract instead of relying only on an appended side instruction.
- Recognize grounded implicit anatomical transformations such as horns, wings, tails, plumage, scales, talons or ears visibly dissolving, retracting, appearing, growing or otherwise changing even when narration never says `form` or `transform`.
- Preserve established alternate forms and route visibly different but unnamed presentations through the existing unclassified-current-form path instead of overwriting unrelated anatomy or inventing a stable form name.
- Keep ordinary scans compact: the expanded form schema is added only when existing form/lifecycle state or an explicit/implicit transformation signal requires detailed Stage 4 handling.
- Prevent large audit-only source history from blocking native backup. Full audit history is attempted first; if it exceeds the existing 2 MB manifest or 32 MB total envelope budget, Delta writes a compact truncation summary and, only if necessary, omits audit history while preserving canonical dossiers, portraits and portable settings.
- Add focused regressions for natural-language anatomical transitions and oversized-history native export without changing relationship formulas, scanner request counts, retries, persistence ownership or bundle schema version.

## 1.0.2 - 12 September 2026

- Add a Birthday field to Edit Dossier so generated or story-established dates can be corrected manually without editing extension JSON.
- Validate manual birthday changes against the active calendar and route accepted corrections through the canonical birthday continuity engine without an extra model request; manual corrections clear story-message provenance.
- Keep scanner prompt semantics, automatic scan routing, request counts, retry budgets and relationship behavior unchanged.

## 1.0.1 - 12 September 2026

- Require a grounded apparent-age result for new dossier-worthy NPCs whenever the scan has an explicit visual-age cue, while preserving chronological age as a separate field.
- Recover a missing apparent age deterministically from grounded appearance wording such as `young`, `middle-aged`, `elderly`, `24-year-old`, or `early thirties`; never infer it from species or lifespan.
- Keep the routine scanner prompt at the same character count and preserve request counts, output allowances, reasoning ownership, injection size, and all non-age scanner semantics.

## 1.0.0 - 12 September 2026

- Consolidate portrait upload/removal into scoped canonical operations; remove the duplicate supporting-tools portrait manager and superseded controls module, including whole-state completion polling.
- Correct locked appearance-form switching and explicitly empty unknown presentation without overwriting alternate anatomy, colors or unrelated dossier fields.
- Apply appearance edits directly through the canonical owner, retaining editor/chat ownership and distinguishing local changes from durable saves.
- Preserve birthday/aging integration after UI-noise stripping, correct mixed structured-date ordering and leap-year birthday comparison, and retain manual age and terminal-death protections.
- Validate native dossier shapes before import and remove source-message ownership when the target chat is unproven, including birthday and death-correction provenance.
- Replace repeated UI history copies with selected-record/lightweight projection reads and owner notifications; simplify history audit copying.
- Keep diagnostic records bounded and free of exception payloads; report actual current-chat pending writes instead of a placeholder metric.
- Surface permanent persistence rejection without endless retries while retaining dirty data, transient retry behavior, writer locking and later recovery.
- Keep retained host-image generation preview-only until explicit application; reject canceled, superseded and stale decode/generation results, and leave newer dialogs untouched.
- Apply manual life-state changes through the canonical owner without closing the editor, replaying a bundle, or overwriting newer input.
- Preserve unchanged dossier sections, disclosure state, focus and scroll during portrait and live-state refreshes; fix clipped cast cards, capped editor footers, hidden fields and top-dialog Escape handling.
- Validate the complete native envelope in the public importer as well as the UI, bound nesting and unsafe object metadata, and report actual added/updated/skipped counts.
- Prepare coherent Delta 1.0.0 application metadata and the existing deterministic installable ZIP without changing storage, bundle or branch schemas.
- Remove three uncalled internal evidence/display helpers, a shadowed source-era version export and a no-op editor branch after tracing runtime/test callers.
- Preserve the working scanner prompt and all measured request bytes, output allowances, reasoning ownership and automatic request counts.

## Stage 8 supporting tools - 12 September 2026

- Add the primary dossier Portrait workflow with device upload/replacement, removal, editable/copyable positive/negative prompts, explicit dossier rebuild, host Image Generation preview, and explicit preview application through the retained portrait upload/compression path.
- Bind asynchronous portrait work to chat/NPC/session/action ownership; reject stale generation, preserve the prior portrait on cancellation/failed decoding/generation, and report local mutation separately from durable flush success.
- Extend the existing versioned Delta native bundle with declared portable portrait settings and source-history audit metadata while retaining `bundle.js` as the canonical codec/import merge. Cross-chat import clears source message ownership and keeps target lineage/checkpoints as the safe baseline; no Alpha/Beta/legacy converter is added.
- Add compact diagnostics for actual dispatcher aggregates/routes/failures, latest retry/focused-pass state, labelled prompt estimates, relationship signed fractions/gate audit, and bounded Stage 8 persistence/workflow events without credentials or full private prompts/responses.
- Add safe-area/dynamic-viewport responsive dialogs with touch targets and bounded scrolling, and refresh only affected dossier/cast projections through the existing Stage 1 controller.
- Add focused synthetic Stage 8 regressions and `docs/stage8-supporting-tools.md`; exact-candidate CI is the deterministic acceptance gate because the continuation environment cannot resolve GitHub for a conventional local checkout. Real SillyTavern/file-picker/Image Generation/desktop-tablet-mobile visual acceptance remains unrun.

## Stages 5-7 relationship, evidence and recovery review - 12 September 2026

- Preserve the pinned numerical scorer, including signed diminishing returns, fractions, gates, configured-cap minima and tied-axis rejection. Add a hash-verified upstream result oracle covering 41,070 cases and end-to-end repeat/persistence/rollback tests.
- Block focused relationship evaluation/application for confirmed-dead NPCs even when death archiving is disabled. Let a valid zero focused decision initialize an empty relationship description without inventing an event or rewriting an established description.
- Move resolved appearance into the existing optional injection budget after essential identity and agency; remove duplicate relevance selection and post-assembly slicing from the Stage 4 adapter.
- Remove the OOC text-command parser, stripper, dispatcher/API, edit hooks, command-only prompt mode/help/bookkeeping and obsolete parser tests. Retain production manual controls, structured add/remove helpers, ordinary backfills and lineage maintenance.
- Protect terminal state after Refresh/backfill live-field restoration and before checkpoint creation. Enable explicit manual erroneous-death correction for unarchived dead records and clarify the editor/confirmation label.
- Retain storage, locks, revisions, dirty retries, owner isolation, tombstones, recovery readers and branch algorithms. No cross-generation import/export change or real database operation.
- Verification: 495 unit tests plus compatibility/runtime/migration smoke checks, validation, prompt measurements, packaging and diff check passed locally. Exact-commit CI remains the publication gate; live browser/provider checks are unrun. See `docs/stages5-7-review.md`.

## Stage 4 appearance and terminal lifecycle - 12 September 2026

- Add bounded named appearance forms and current-form selection while preserving earlier flat appearance as a safe `Base` compatibility form.
- Add one resolved-current-appearance path for dossier presentation, portrait prompts and roleplay injection, including protection against cross-form anatomy leakage and unidentified transformations.
- Extend scanner/Refresh/backfill/import prompts and profile locks to understand form-independent overall appearance, named forms and current form without erasing omitted forms; normalize the resolved current view back into canonical `appearance` so the existing dossier stays consistent without a second editor/state authority.
- Make explicit confirmed death terminal to automatic scanner, Refresh, retained backfill and structured-source updates; dead NPCs cannot regain presence/world activity from narrative resurrection.
- Preserve manual/stale reactivation for living dossiers, retained dead history/relationships/portraits, explicit player correction for erroneous death, and owned-history rollback.
- Add Stage 4 regression coverage for flat upgrade, form switching/refinement, clothing-only changes, locks, unknown forms, portrait/injection agreement, terminal death, explicit correction and automatic-writer presence guards.
- Review/fix pass hardens alias consolidation, bundle-import terminal death, unidentified-form anatomy isolation, current-form portrait anatomy, and budgeted roleplay appearance injection without changing relationship formulas.
- Final Stage 4 review fixes unnamed-form normalization so form-independent appearance is never duplicated across repeated loads; the retained editor's manually locked Appearance field edits the selected current form rather than creating a second authority.
- Treat deliberate manual Restore of a confirmed-dead dossier as explicit erroneous-death correction, retain correction provenance, and keep the corrected NPC off-screen until story evidence establishes presence again; automatic narrative/structured writers still cannot revive it.
- Full deterministic verification after the final review: 488 unit tests plus compatibility/runtime/migration smoke checks, validation, prompt measurement, package verification, and diff check; real SillyTavern/provider acceptance remains separate.

## Stage 3 scanner routing - 12 September 2026

- Add one selectable scanner connection-profile setting and shared request-scoped dispatcher for retained NPC model requests.
- Keep the empty/default route on the existing host generation path; explicit profile failures are surfaced without silent fallback and do not redirect roleplay or portrait generation.
- Cover automatic/manual scans, Refresh, focused relationships, retries, structured import and retained backfills, including timeout/cancellation and stale-result rejection.
- Restore the omitted `scan-context.js` runtime dependency after the initial Stage 3 merge and add it to the canonical runtime inventory; the post-hotfix main CI passed.
- Follow-up review moves redundant automatic backfill suppression ahead of the shared dispatcher and removes the inherited `full-cast.js` `generateRaw` monkey-patch, preserving identical default/selected-profile routing and manual repair access. Validation now rejects runtime bypasses of `scanner-routing.js`.

## Stage 2 active-runtime normalization - 11 September 2026

- Classify every implementation module executed by Delta as active Delta code regardless of source ancestry.
- Add `runtime-modules.json` as the canonical machine-readable inventory for every shipped top-level JavaScript module and its semantic role.
- Normalize the active mechanics and branch primitive paths to `core-mechanics.js` and `branch-core.js`; remove the old source-version-labelled runtime paths.
- Make validation require an exact one-to-one match between the active inventory and root runtime JavaScript, and reject legacy/version-labelled active paths or dependencies.
- Build packages from the same active inventory instead of a root wildcard so undeclared residue cannot silently enter a release archive.
- Drive CI syntax and release-consistency checks from the same inventory, and rename source-version-labelled safety test filenames to their current responsibilities.
- Keep historical source names/versions only in Git history, `docs/history/`, provenance records, and historical-shape fixture data where the old identifier itself is evidence. Required historical-shape readers remain active Delta compatibility logic inside current owners, not a separate runtime layer.
- Preserve scanner behavior, relationship formulas, persistence/recovery semantics, lifecycle policy, and roleplay injection while performing this structural normalization.

## Stage 2 consolidation / Delta v0.1.0 - 11 September 2026

- Establish `0.1.0` as NPC State Delta's own application-version baseline in the manifest, core facade and package metadata. Persisted bundle, branch, and data schema versions remain independent.
- Replace the broad `enhancements.js` layer with a dedicated `full-cast.js` owner that preserves the opt-in full-cast scan and redundant-backfill guard.
- Remove the superseded secondary Dossier Library overlay now that Stage 1 owns the dossier/cast presentation surface.
- Update bootstrap, validation, package naming and focused tests around the consolidated owner boundaries.
- Keep scanner semantics, persistence/recovery, relationship mechanics, evidence/injection behavior and later-stage contracts unchanged.

## Stage 1 tablet cast rail fix - 11 September 2026

- Keep the cast search field and lifecycle filters on one row for tablet widths so they do not consume most of the fixed cast rail height.
- Reserve enough vertical space for complete dossier cards on tablet and phone layouts instead of clipping the portrait/status row at the bottom edge.
- Add a small minimum bottom inset in touch layouts even when the browser reports no safe-area inset, while retaining horizontal cast scrolling.
- Keep the change presentation-only; scanner, state, persistence, relationship mechanics, and later stages are unchanged.

## Stage 1 compact launcher and mobile viewport fix - 11 September 2026

- Restyle the floating launcher as a 48px rounded-square stacked `npc` / `state` wordmark inspired by the supplied icon, keeping the full button as the touch/drag target and avoiding a large raster asset.
- Keep the compact launcher on desktop, tablet, and mobile; retain drag-and-persist positioning and the safe-area-aware side-midpoint default on narrower screens.
- On tablet/mobile widths, remove the centered `top: 50%` dossier transform and pin the dossier to the top-left of the dynamic viewport so the header cannot be shifted off-screen.
- Make the dossier top bar sticky and the Close control at least 44x44px on touch layouts, with safe-area padding for notches and browser chrome.
- Keep the change presentation-only: scanner, state, persistence, relationship mechanics, and later stages are untouched.

## Stage 1 mobile and overlay fixes - 11 September 2026

- Promote the movable dossier launcher to a top-level floating control so SillyTavern mobile/tablet stacking and nested extension layout cannot bury it.
- Use a compact 48px launcher icon at the right-side midpoint on phone/tablet widths, away from the bottom composer, while retaining drag-and-persist positioning.
- Replace the visual-only overlay shadow with a real clickable backdrop so clicking outside the dossier closes it.
- Remove the duplicate Edit button from the dossier document header while retaining the primary Edit dossier action beside the portrait.
- Keep NPC State Delta settings exclusively under SillyTavern Extensions.

## Stage 1 launcher refinement - 11 September 2026

- Make the side dossier launcher draggable with mouse, pen, or touch while preserving normal click-to-open behavior.
- Persist only the launcher's UI coordinates locally and clamp restored positions inside the current viewport after resize/orientation changes.
- Remove launcher-panel Settings access; NPC State Delta settings remain under SillyTavern's Extensions settings surface.
- Remove the Stage 1 root stacking context that could trap the fixed launcher below SillyTavern mobile chrome.
- Force mobile launcher visibility and add safe-area-aware default right/bottom offsets for notched/home-indicator devices.

## Stage 1 dossier UI - 11 September 2026

- Add a persistent side launcher that opens a centered portrait-led dossier surface without changing the canonical Delta scanner, persistence, or relationship behavior.
- Adapt the useful donor presentation ideas into Delta-local code: selected portrait hero, readable dossier document, searchable horizontal cast rail, and active/archived/dead filters.
- Project canonical Delta NPC state into bounded UI records so relationship/event histories and branch snapshots are not rendered or retained by the view layer.
- Route editing through the existing `NPCStateDelta.openEditor` owner and keep settings owned by the existing Delta Extensions settings surface rather than creating duplicate mutation/settings paths.
- Preserve search state, selection, cast/document scroll, focused cast selection, and external editor drafts while canonical state notifications refresh the open view.
- Add focused Stage 1 tests for lifecycle filtering, search, selection retention, projection boundaries, no-chat behavior, editor/settings ownership, and bootstrap reachability.

Real-browser visual/performance QA remains a host acceptance check; deterministic HTML/model tests are not treated as visual evidence.

## Source seed - 11 September 2026

- Seed the exact source snapshot from `kohz87/npc_state` at `a12b2937b5c1305e3e3017218a626478a5bedcdc`.
- Apply Delta identity isolation to runtime/CSS and inherited tests while initially preserving source algorithms and version markers for reproducible comparison.
- Preserve the existing GPL license and record all source paths/blob hashes.
- Add the core contract, agent instructions, nine-stage workplan and verification/package tooling.
- Move upstream markdown into historical reference documentation.

No work stages 1-9 were implemented in the original seed. Upstream release history is retained in `docs/history/`.
