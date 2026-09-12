# NPC State Delta — core contract

Status: approved behavior authority. Stages 1-4 are implemented and deterministically verified; Stage 4 real-host visual/provider acceptance remains pending. `docs/WORKPLAN.md` tracks remaining work. Inherited behavior is the baseline, not proof that every target feature exists.

## C01. Foundation and product loop

Delta is a standalone SillyTavern extension built from `kohz87/npc_state`, commit `a12b2937b5c1305e3e3017218a626478a5bedcdc`, directory `legacy/v0.2.x`, manifest version `0.2.23`. The seed includes the retained 0.2.18 engine and later hardening/enhancements actually present in that snapshot. Do not substitute another 0.2.x revision based only on its name.

The essential loop is: completed story exchange -> legacy-style dedicated scan -> grounded dossier update -> owned persistence/checkpoint -> relevant accepted continuity in the next roleplay request. Use legacy as the main implementation and behavior base, with selected Beta/Alpha features adapted into it. The nine phases are work stages, not nine runtime components or alternate operation modes.

No mandatory machine trailer in roleplay output, no separate mandatory Immediate/Development architecture, and no independent background dossier database. No dependence on installed legacy/Beta/Alpha extensions or their settings/data. Delta does not add an always-on server worker.

## C02. State, settings and namespace

Maintain one canonical per-chat dossier state, one settings source, one persistence/checkpoint path and one relationship mechanics implementation. UI projections are reads of that state, not additional authorities.

Use the `npc_state_delta` installation/settings identity, `NPCStateDelta` public global and Delta-specific DOM, prompt, sidecar, recovery, writer-lock and bundle identifiers. Do not automatically discover or migrate another generation's data. Internal historical-shape readers retained in the seed are not a product promise of generational import support.

Preserve the original repository GPL license and source provenance. Runtime must be self-contained. No GitHub/network source loading from reference projects.

## C03. Capture, scanner and routing — stage 3

Retain legacy's completed-message capture, latest-exchange routine scan, configurable scan cadence, manual Scan/Refresh, configured history modes, conditional focused relationship passes, malformed-response handling and necessary backfill behavior unless a task explicitly changes a path. Preserve source/branch ownership and late-result rejection. No Beta-style requirement that an owning scan must succeed before another ordinary generation may proceed.

The seed's message handler awaits scanner work; retaining it is not a guarantee of nonblocking host behavior. Measure generation wait and provider contention separately. Do not introduce new waits or advertise foreground priority without verifying the actual selected host route.

Add a scanner connection-profile setting. An empty/default selection uses the existing host route. A selected route applies consistently to retained NPC model requests: automatic/manual scan, targeted Refresh, focused passes, repair/retry and applicable backfill. Ordinary roleplay keeps its configured route. Portrait generation remains its own host image workflow.

A missing/unavailable selected profile produces a clear recoverable error; never silently route to a different provider/model. Prefer request-scoped routing. Any temporary host setting changes must restore reliably and cannot redirect concurrent roleplay. One shared dispatcher should account for actual request counts, timeouts and cancellation. Do not add automatic completeness calls or additional passes solely to compensate for a larger contract.

## C04. Dossier establishment and evolution — stage 4

Retain legacy identity/admission, aliases, role/species, actual/apparent age, live state, personality, behavior profile, characteristic speech, mannerisms, background, memories, non-player ties and bounded profile-evidence evolution. Supported new facts can populate the first scan. Unknown fields stay unknown; do not infer merely because a field is blank. Omitted fields preserve accepted values.

Retain legacy refinement/evolution rules and the separation of durable identity, transient mood/condition, player-specific dynamics, and profile evidence. Do not silently replace its heuristics with Beta/Alpha's evidence contract during cleanup. Explicit later changes require a recorded behavior decision and tests.

Adopt overall appearance plus named appearance forms and current-form selection. Existing flat appearance becomes a safe baseline without fabricated alternate anatomy. Define one resolver for dossier display, scanner comparison, portrait prompts and roleplay injection. The selected form's accepted anatomy, current outfit/condition and overall description must agree. A form switch does not erase another form's description. An observed undefined form preserves supported current presentation in a separate unnamed-current slot without inventing a form ID, duplicating form-independent details, or forcing the previous anatomy. Omission does not delete forms. Correcting one named form affects only that form unless the source explicitly supports a broader change.

Do not automatically add unrelated Beta features such as generated birthdays or altered dossier limits just because a donor module supports them.

## C05. Terminal automatic death — stage 4

Retain grounded legacy lifecycle detection but remove automatic narrative reactivation/resurrection. Once confirmed dead, later model/structured/Refresh output cannot make the NPC alive or currently active again. Preserve historical identity, dossiers, memories, relationships and portrait references. Death does not delete the record.

An explicit user correction can repair an erroneous death. Delta may use the retained manual Restore control for that correction as long as it records correction provenance and does not infer current presence; it is not narrative resurrection. Owned-history rollback can remove a death whose source was deleted, edited or abandoned by a swipe. These are corrections of invalid state, not a narrative revival feature. They must not revive unrelated dead NPCs or bypass provenance. All automatic writers obey the same terminal rule.

## C06. Relationship scoring — stage 5

Retain the exact pinned legacy mechanics and interpretation as the initial Delta policy. Four independent NPC-to-player axes: Trust, Affection, Desire, Tension; default baseline zero; integer range -100..100 with separate signed fractional progress.

| Impact | Default maximum raw magnitude per axis | Maximum axes |
| --- | ---: | ---: |
| none | 0 | 0 |
| ordinary | 1 | 1 |
| meaningful | 2 | 2 |
| major | 5 | 3 |
| extreme | 10 | 4 |

For outward movement, multiply raw capped evidence by the legacy magnitude bands: `<30:1`, `<50:0.75`, `<70:0.5`, `<85:0.35`, `<95:0.2`, otherwise `0.1`. Movement toward neutral retains legacy's impact-sensitive resistance; extreme contrary evidence acts at full raw strength. Accumulate fractions before converting to whole displayed movement. Do not round away progress or reweight the model's proposal twice.

Gates are per axis and direction at 25/50/75/90, requiring meaningful/major/extreme/extreme respectively and stock minimum raw magnitudes 1/3/5/8. Retain legacy's configured-cap adjustment to gate minima. Reaching a locked boundary does not bank outward fractional progress; a qualifying event can unlock it even without an immediate visible point. Existing unlocked milestones, progress and reasons survive ordinary persistence and valid recovery.

Retain legacy overflow selection, including rejection of an ambiguous equal-weight tied group; retain its evidence and duplicate handling at baseline. Beta's priority tie handling/source-event duplicate refinements are optional discussion items, not approved changes. Do not substitute Beta's resistance curve or Alpha's default +/-1000 score scale, zero inertia, descriptive milestones, or absence of legacy event caps.

Score genuinely new directional evidence, never repeated narration of the same event. Desire needs its own grounded support; warmth, rescue and trust alone do not establish it. A zero numeric change may still update an appropriately grounded relationship description. Identity, agency, boundaries and other bonds dominate player relationship expression. Manual corrections and owned rollback must preserve the intended per-axis state; historical scans cannot replay old score events as new ones.

## C07. Evidence and roleplay injection — stage 6

Retain legacy narration, supported World State/Inner Chatter and explicit dossier-source handling. Do not import Beta/Alpha's narrower structured-source permissions by accident. Preserve legacy distinctions between physical presence, current off-screen activity, references, and durable facts. An absent/failed scan does not prove all NPCs absent. Do not double-count duplicate representations of the same event.

Retain compact identity-first injection and its relevance/presence selection. Accepted personality, behavioral profile, speech, mannerisms, goals, duties, agency, important bonds and relevant appearance must reach roleplay according to the existing budget priority. Incorporate selected appearance forms through the shared resolver. Tentative observations are not injected as established traits. Relationship numbers do not replace characterization or imply obedience/intimacy.

Measure the actual final extension prompt, not only a UI projection. A saved field without an appropriate route into selected continuity is not sufficient acceptance. Preserve legacy omission, compaction and budget behavior unless a deliberate documented change is requested.

## C08. Persistence, history and removal of OOC commands — stage 7

Retain legacy sidecar storage, owner-qualified chat keys, lineage/swipe-aware snapshots, writer locking, revision conflicts, dirty-write retention/retry, recovery copies, deletion tombstones, rename/delete lifecycle handling and branch recovery. A numeric message position alone is not durable ownership. Preserve active work through transient write failure; never advertise a failed save as durable.

Remove narration-based OOC commands and command-only parser/listeners/exports/help/tests/backfill dependencies. Keep manual UI/API editing, add/remove/archive/restore as appropriate to terminal-death rules, locks, portrait handling and suppression safety. Trace shared dependencies so removing OOC does not remove ordinary scan or manually requested repair.

No automated operations on actual user databases during development. Import/recovery operates on its declared target and cannot cross an unproven history boundary or silently overwrite another chat.

## C09. User interface and supporting tools — stages 1 and 8

Adopt an Alpha-style side launcher and Beta-style portrait-led dossier, searchable cast rail and readable editing experience. Use lightweight adapters to the legacy state, not a donor engine. Render the selected dossier and affected components; avoid loading/cloning all chat/history for view refresh or regenerating unchanged panel content. Preserve scroll, focus, open controls and unsaved edits during notifications.

Retain useful legacy settings and manual controls. Adapt Beta-style portrait prompt composition into one image workflow using the same resolved appearance as the dossier/injection. Include editable/copyable positive/negative prompts and attachment/generation behavior supported by the host; do not route images through the scanner profile.

Provide one clean versioned native Delta import/export format, with no cross-generation adapters. Validate before mutation and retain supported portraits, dossiers and history/ownership semantics. Format versioning is mandatory even though generational compatibility is excluded. Any deliberately omitted history must be disclosed and restored through an explicit safe baseline, not invented provenance.

Diagnostics are compact and optional in normal dossier use. Distinguish extraction failure, no change, fractional scoring progress, gate blocking, stale work and persistence failure. Request counts include retries/focused passes. Avoid recording credentials or full private prompts by default.

## C10. Compact code and prompt accounting — stages 2 and 9

Compactness means one coherent implementation with bounded useful context, not minification or removal of safety. Delete verified superseded runtime paths with callers/tests. Do not maintain multiple master rules/settings or import a new framework solely to wrap legacy code.

Retain legacy prompt/schema simplicity and output limits as the baseline. Add only necessary form/death/routing wording. Changes to token limits must be explicit and motivated; larger allowances are not proof of better extraction. Measure constructed input, requested output allowance and actual requests separately. Local estimates are not provider usage or pricing.

Compare the same story segment, initial dossier state, settings/model and settled workload when evaluating alternatives. Include retries, focused passes and any remaining backlog. Report foreground wait, time-to-useful-dossier, browser responsiveness and total usage separately. Never claim the seed has measured live speed or extraction superiority solely from synthetic tests.

## C11. Stage acceptance and exclusions

After each stage verify the affected production paths, and preserve the baseline scan -> dossier -> persistence -> injection loop. Maintain representative scenes for first contact, existing profile refinement, temporary-vs-durable state, human/alternate form, off-screen mentions, relationship gates/fractions/replays, death/correction/rollback, chat switching and write failure. Use synthetic fixtures; real-provider/browser checks require their actually available environment and must be labelled separately.

A stage changes only its authorized behavior. No automatic adoption of the donor projects' entire schemas, new call patterns, birthday generation, new relationship mechanics, generational imports or additional agents. Bugs found outside scope should be recorded with evidence; do not hide a behavioral redesign inside consolidation.
