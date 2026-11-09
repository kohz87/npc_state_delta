/* NPC State Delta buildScannerPrompt: the scanner's context assembly, rules, rubric and story-context prompt.
   Split from core-prompts.js without change; core-prompts.js re-exports every name it exported before. */
import { DEFAULT_RELATIONSHIP, DEFAULT_RELATIONSHIP_CAPS, DURABLE_PROFILE_LIMITS, normalizeRelationshipBaseline, normalizeRelationshipCaps } from './core-relationship.js';
import { cleanText, cleanWords, cleanWordsList } from './core-text.js';
import { normalizeBehaviorProfile } from './core-behavior.js';

import { KEY_RELATIONSHIP_LIMIT } from './core-keyrel.js';
import { PROFILE_EVIDENCE_FIELDS } from './src/fields/registry.js';
import { isInterimNpcLabel, normalizeGender, normalizeLifeState } from './core-identity.js';
import { IMPORTANT_MEMORY_LIMIT, normalizeLifeStateCertainty, normalizeNpcAdmissionMode, normalizeNpcCandidate } from './core-record.js';
import { profileEvidenceCount, promptProfileEvidence } from './core-evidence.js';
import { compactImpactRubric, compactMemoryRubric, compactRelationshipRubric, DEFAULT_IMPACT_CRITERIA, DEFAULT_MEMORY_CRITERIA, DEFAULT_RELATIONSHIP_CRITERIA } from './core-prompts-criteria.js';
import { scenePresentFocus, selectScannerContextNpcs, selectScannerProfileContextNpcs, withScenePresent } from './core-prompts-select.js';
import { BEHAVIOR_LEVER_LABELS, PROFILE_STYLE_LINE, PROMPT_CAPS } from './core-prompts-targeted.js';
import { compactCaptureRules, hiddenNoteEventParagraph, hiddenNotePromptRules, NARRATION_CAPTURE_HEADER, NARRATION_CAPTURE_STORY } from './core-prompts-capture.js';
export function buildScannerPrompt({
    transcript,
    existingNpcs = [],
    candidates = [],
    userName = 'User',
    charName = 'Character',
    maxNpcs = 40,
    relationshipBaseline = DEFAULT_RELATIONSHIP,
    relationshipCaps = DEFAULT_RELATIONSHIP_CAPS,
    relationshipCriteria = DEFAULT_RELATIONSHIP_CRITERIA,
    impactCriteria = DEFAULT_IMPACT_CRITERIA,
    memoryCriteria = DEFAULT_MEMORY_CRITERIA,
    detailLimit = 4,
    admissionMode = 'conservative',
    currentTranscript = '',
    fullScanMode = false,
    narrationCapture = false,
    dossierAbove = '',
    compactCapture = false,
    sceneNames = null,
    layeredSecrets = false,
    eventWatch = null,
    earlierOnly = false,
}) {
    const baseline = normalizeRelationshipBaseline(relationshipBaseline);
    const caps = normalizeRelationshipCaps(relationshipCaps);
    const admission = normalizeNpcAdmissionMode(admissionMode);
    const admissionPolicy = admission === 'manual_only'
        ? 'MANUAL ONLY: new people stay candidates until manual add; existing dossiers still update.'
        : admission === 'balanced'
            ? 'BALANCED: admit proper names, meaningful/persistent roles, and roles with direct two-way player interaction.'
            : 'CONSERVATIVE: proper names admit. First-seen role_label ALWAYS stays candidate regardless of dossierSignal/directInteraction; promote on confirmed same-person recurrence or manual add.';
    const identityIndex = [
        ...existingNpcs.map(npc => ({
            id: npc.id,
            name: npc.name,
            aliases: (npc.aliases || []).slice(0, 8),
            registryState: 'dossier',
            ...(isInterimNpcLabel(npc.name, npc.identityKind) ? {
                identityKind: 'role_label',
                role: cleanText(npc.role, 120),
                location: cleanText(npc.location, 120),
            } : {}),
        })),
        ...(Array.isArray(candidates) ? candidates : []).map(normalizeNpcCandidate).filter(Boolean).map(candidate => ({
            id: '',
            name: candidate.name,
            aliases: (candidate.aliases || []).slice(0, 6),
            registryState: 'candidate',
            seenCount: candidate.seenCount,
            role: candidate.role || '',
            gender: candidate.gender || '',
            location: candidate.location || '',
            lastSeenTurn: candidate.lastSeenTurn || 0,
        })),
    ];

    const relevantLimit = fullScanMode ? 8 : Math.min(4, Number(detailLimit) || 4);
    const profileLimit = fullScanMode ? Math.min(6, relevantLimit) : 3;
    // (v2 World view) While Story Block keeps the scene, who it lists as present now (`sceneNames`, from
    // Story Director's `director.world.here` or Story Block's `scene.present`): those dossiers join the live
    // context after the mentioned ones, their `present` is the scene's, and one dynamic line names them.
    const scene = scenePresentFocus(existingNpcs, sceneNames);
    const relevantExisting = scene ? withScenePresent(selectScannerContextNpcs(existingNpcs, transcript, relevantLimit), scene.npcs, relevantLimit) : selectScannerContextNpcs(existingNpcs, transcript, relevantLimit);
    const profileIds = new Set(selectScannerProfileContextNpcs(relevantExisting, transcript, profileLimit).map(npc => npc.id));
    const runtimeExisting = relevantExisting.map(npc => {
        const stronglyRelevant = profileIds.has(npc.id);
        const aliases = (npc.aliases || []).slice(0, 6);
        const role = cleanText(npc.role, 180);
        const gender = normalizeGender(npc.gender);
        const lifeState = normalizeLifeState(npc.lifeState);
        const lifeStateCertainty = normalizeLifeStateCertainty(npc.lifeStateCertainty);
        const age = cleanText(npc.age, 60);
        const apparentAge = cleanText(npc.apparentAge, 60);
        const goal = cleanText(npc.goal, 180);
        const status = cleanText(npc.status, 220);
        const relationshipSummary = cleanText(npc.relationshipSummary, 260);
        const mood = cleanText(npc.mood, 160);
        const location = cleanText(npc.location, 180);
        return {
            id: npc.id,
            name: npc.name,
            ...(aliases.length ? { aliases } : {}),
            ...(role ? { role } : {}),
            ...(gender ? { gender } : {}),
            currentRelationship: npc.relationship || baseline,
            present: scene ? scene.ids.has(npc.id) : Boolean(npc.present),
            worldActive: Boolean(npc.worldActive),
            ...(lifeState !== 'unknown' ? { lifeState } : {}),
            ...(lifeStateCertainty ? { lifeStateCertainty } : {}),
            ...(npc.archived ? { archived: true, archiveReason: npc.archiveReason || '' } : {}),
            ...(age ? { age } : {}),
            ...(apparentAge ? { apparentAge } : {}),
            ...(goal ? { goal } : {}),
            ...(status ? { status } : {}),
            ...(stronglyRelevant && relationshipSummary ? { relationshipSummary } : {}),
            ...(mood ? { mood } : {}),
            ...(location ? { location } : {}),
        };
    });
    const profileExisting = relevantExisting
        .filter(npc => profileIds.has(npc.id))
        .map(npc => {
            const species = cleanText(npc.species, 120);
            const homeBase = cleanText(npc.homeBase, 240);
            const appearance = cleanText(npc.appearance, 500);
            const personality = cleanWords(npc.personality, DURABLE_PROFILE_LIMITS.personality);
            const speech = cleanWords(npc.speech, DURABLE_PROFILE_LIMITS.speech);
            const behaviorProfile = normalizeBehaviorProfile(npc.behaviorProfile);
            const background = cleanText(npc.background, 320);
            const mannerisms = (npc.mannerisms || []).slice(0, 4).map(item => cleanWords(item, DURABLE_PROFILE_LIMITS.mannerism)).filter(Boolean);
            const keyRelationships = cleanWordsList(npc.keyRelationships, KEY_RELATIONSHIP_LIMIT, DURABLE_PROFILE_LIMITS.keyRelationship);
            const memories = cleanWordsList(npc.memories, IMPORTANT_MEMORY_LIMIT, DURABLE_PROFILE_LIMITS.memory);
            const profileEvidence = promptProfileEvidence(npc.profileEvidence);
            const locked = (npc.manualProfileFields || []).filter(field => PROFILE_EVIDENCE_FIELDS.includes(field));
            return {
                id: npc.id,
                name: npc.name,
                ...(species ? { species } : {}),
                ...(homeBase ? { homeBase } : {}),
                ...(appearance ? { appearance } : {}),
                ...(personality ? { personality } : {}),
                ...(speech ? { speech } : {}),
                ...(behaviorProfile.length ? { behaviorProfile } : {}),
                ...(background ? { background } : {}),
                ...(mannerisms.length ? { mannerisms } : {}),
                ...(keyRelationships.length ? { keyRelationships } : {}),
                ...(profileEvidenceCount(profileEvidence) ? { recentProfileEvidence: profileEvidence } : {}),
                ...(locked.length ? { lockedProfileFields: locked } : {}),
                ...(memories.length ? { memories } : {}),
            };
        });

    // (1.2.17) One-pass capture with the live dossier in the same prompt: a value the dossier above
    // already gives word for word is not sent twice. Only exact repeats go (a value the dossier
    // shortened or left out stays); ids, presence, the numeric relationship, evidence and locks stay.
    const dossierText = narrationCapture ? String(dossierAbove || '') : '';
    let dedupedCount = 0;
    // Each NPC's values are looked for in its own dossier line ("- Name: …"), never another's.
    const dossierLineOf = name => dossierText.split('\n').filter(line => line.startsWith(`- ${name}:`) || line.startsWith(`- ${name} (`)).join('\n');
    const withoutDossierRepeats = (entry, keep) => {
        const line = dossierText && entry?.name ? dossierLineOf(entry.name) : '';
        if (!line) return entry;
        const out = {};
        let dropped = false;
        for (const [key, value] of Object.entries(entry)) {
            const repeated = !keep.has(key) && (typeof value === 'string'
                ? value.length >= 3 && line.includes(value)
                : Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && line.includes(item.replace(/[.;]\s*$/, ''))));
            if (repeated) dropped = true;
            else out[key] = value;
        }
        if (!dropped) return entry;
        dedupedCount += 1;
        return { ...out, inDossier: true };
    };
    const ALWAYS_SENT = new Set(['id', 'name', 'aliases', 'currentRelationship', 'present', 'worldActive', 'lifeState', 'lifeStateCertainty', 'archived', 'archiveReason', 'recentProfileEvidence', 'lockedProfileFields']);
    const liveDeduped = runtimeExisting.map(entry => withoutDossierRepeats(entry, ALWAYS_SENT));
    const profileDeduped = profileExisting.map(entry => withoutDossierRepeats(entry, ALWAYS_SENT));
    const dedupeNote = '\n(inDossier: fields left out here are the NPC STATE DELTA DOSSIER\'s values above, current and unchanged.)';
    // Only when it is shorter, note included: a short repeat is cheaper to send than to explain.
    const dedupeSaves = dedupedCount > 0 && JSON.stringify(liveDeduped).length + JSON.stringify(profileDeduped).length + dedupeNote.length
        < JSON.stringify(runtimeExisting).length + JSON.stringify(profileExisting).length;
    const liveSent = dedupeSaves ? liveDeduped : runtimeExisting;
    const profileSent = dedupeSaves ? profileDeduped : profileExisting;
    const dossierNote = dedupeSaves ? dedupeNote : '';

    const relationshipRubric = compactRelationshipRubric(relationshipCriteria);
    const impactRubric = compactImpactRubric(impactCriteria);
    const memoryRubric = compactMemoryRubric(memoryCriteria);
    const currentExchange = String(currentTranscript || transcript || '').trim();
    const fullScanRule = fullScanMode
        ? `\nFULL-WINDOW RECONCILIATION: Story context contains the configured recent-history window. Use durable evidence anywhere in the supplied recent-history window to recover missed durable facts (identity, role/species/gender/age, profile, background, social ties, memories). Earlier turns are context, NOT new events. For present/worldActive and LIVE mood/location/goal/status, use only the newest CURRENT exchange below; older states must never overwrite newer/established live state. Numeric relationshipImpact/relationshipDelta MUST use only CURRENT exchange, never older window events. Do not replay old deltas.`
        : '';

    // A lean scan of several exchanges: the latest is CURRENT (presence, mood, location, meters come only from it); the
    // earlier ones are context for durable facts.
    const wholeStory = String(transcript || '').trim();
    const earlierStory = !narrationCapture && !fullScanMode && currentExchange && wholeStory.length > currentExchange.length && wholeStory.endsWith(currentExchange)
        ? wholeStory.slice(0, wholeStory.length - currentExchange.length).trim()
        : '';
    const EARLIER_LABEL = 'EARLIER exchanges (replies since the last scan, each read once; durable facts and relationship changes that happened then, with their own evidence; never current presence, mood or location)';
    const storyContext = narrationCapture
        ? NARRATION_CAPTURE_STORY
        : earlierOnly
            ? `Story context:\n${EARLIER_LABEL}:\n${wholeStory}`
            : earlierStory
            ? `Story context:\n${EARLIER_LABEL}:\n${earlierStory}\n\nCURRENT exchange (authoritative for presence, mood and location):\n${currentExchange}`
            : `Story context:\n${String(transcript || '').trim()}${fullScanMode ? `\n\nCURRENT exchange (authoritative for presence, mood and location):\n${currentExchange}` : ''}`;

    // (1.2.17) Opt-in compact one-pass rules: the same fields and gates in fewer words (about 1,200
    // tokens instead of 2,000). Only for one-pass capture; the scanner keeps its full rules.
    const rulesBlock = narrationCapture && compactCapture ? compactCaptureRules(caps) : null;
    // (b5b r2-8) One-pass rules go early and must not change from reply to reply; in a group chat the
    // character about to speak does. So the capture rules name roles and this line, in the context
    // part, names the people.
    const captureNames = narrationCapture ? `\nNot NPCs: the player is ${userName}; the character you play is ${charName}.` : '';
    const sceneLine = scene ? `\nIn the scene now (the story's scene list): ${scene.names.join(', ')}.` : '';
    // Hidden notes (Story Suite hosted only; absent by default, so the prompt is byte-identical without them): layered
    // secrets for a NEW dossier-worthy NPC, and the story events to look for in the CURRENT exchange. A one-pass capture
    // keeps its rules the same from reply to reply: the layered rule goes with them, the list of events (which changes)
    // goes in the context part.
    const hiddenNoteRules = hiddenNotePromptRules({ layeredSecrets, eventWatch, events: !narrationCapture });
    const hiddenNoteContext = narrationCapture ? hiddenNoteEventParagraph(eventWatch) : '';
    if (rulesBlock) {
        return `${NARRATION_CAPTURE_HEADER}
Admission: ${admissionPolicy}
${rulesBlock}${hiddenNotePromptRules({ layeredSecrets, start: 12, events: false })}

Relationship rubric: ${relationshipRubric || '(none)'}
Impact rubric: ${impactRubric || '(none)'}
Memory criteria: ${memoryRubric || '(none configured; store only clearly durable story-relevant events)'}
Delta caps: ordinary ${caps.ordinary}; meaningful ${caps.meaningful}; major ${caps.major}; extreme ${caps.extreme}. New-NPC baseline: ${JSON.stringify(baseline)}

Identity index (matching only):
${JSON.stringify(identityIndex)}${captureNames}${sceneLine}

Relevant live context (dynamic fields only):
${JSON.stringify(liveSent)}

Stable profile context (strongly relevant existing only):
${JSON.stringify(profileSent)}${dossierNote}${hiddenNoteContext}

${storyContext}`;
    }

    return `${narrationCapture ? NARRATION_CAPTURE_HEADER : 'Private NPC dossier scanner.'}
Admission: ${admissionPolicy}${fullScanRule}
Rules:
1. ${narrationCapture ? 'Exclude the player, the character you play, extras.' : `Exclude player (${userName}), main speaker (${charName}), extras.`}
2. EXISTING: match id/name/alias/role. Return compact JSON deltas: changed fields only; omitted persist. Identity promotion: role/interim dossier + grounded proper name => MUST reuse id; old label in aliases; identityKind:"proper_name"; never duplicate/downgrade.
3. NEW/CANDIDATE: include name,identityKind,dossierSignal,dossierReason,sameIndividual,directInteraction,present,worldActive. Dossier-worthy NEW: populate every grounded field now; directInteraction affects admission/relationship only, NEVER enrichment. Incidental role candidates may stay lightweight.
4. Candidates are not dossiers. sameIndividual=true only when proven. Use narration, World State, durable Inner Chatter; proper names there MUST be returned even when prose uses role.
5. Return ONLY observed/new/meaningfully changed NPCs; new grounded durable profile facts count as changes. present=true only latest-scene physical presence; World State/Inner Chatter alone never presence. worldActive=true only explicit current off-screen activity. Inner Chatter supports durable facts, not transient monologue.
6. Goal/status/mood/location are LIVE: output goal,goalState,status,statusState,mood,moodState,location,locationState as needed; actively reassess each returned EXISTING NPC every scan. Unchanged -> omit; changed -> replace; ended mood/goal/status -> matching *State:"clear". Location=current/last reliable; locationState:"clear" only when old place explicitly obsolete and replacement unknown. Off-screen/no evidence alone never clears it. Never use "Unknown".
7. DURABLE PROFILE CHANNEL: ALWAYS emit profileUpdates for grounded durable facts; npc delta optional. One scene may support multiple fields; emit each grounded (speech+behaviorProfile allowed). EXISTING grounded visual=>MUST emit appearance/overallAppearance+evidence.appearance in profileUpdates, even with other fields. Correction/reveal=>*State:"refine"; clothes/form/presentation change=>appearanceState:"change"+reason+FULL Appearance. matching *State:"refine"=>FULL; personality/speech/mannerism/behaviorProfile "evolve"+reason. behaviorProfile FULL max6 "Label: level - effect" levers (evidence too); Label=${BEHAVIOR_LEVER_LABELS}; habits/routines=>mannerisms. Mannerisms FULL max4. Locks never rewrite. ${PROFILE_STYLE_LINE}
8. IDENTITY FIREWALL: mood/stress/intimacy/injury/relationship-specific behavior never becomes global Personality/Speech/Mannerisms/behaviorProfile. Grounded Appearance exempt; fleeting pose/expression is not identity. Kindness stays general unless broader change; necessary force != cruelty. Scores don't create tropes.
9. DEVELOPMENT SPEED: developmentScale=gradual|explicit|batch. assistant/main-speaker=gradual; Player explicit/batch only for declarative canon, not quotes/questions/speculation/requests/conditionals/wishes. Speech evidence/candidate=voice style, not bare quote/personality. Time-compressed refine/evolve/change MUST include developmentReason + changed FULL candidate; unchanged/reinforcing=>omit/keep. Time skip alone invents nothing.
10. SOCIAL: grounded non-player kin/friend/rival/mentor/partner => ALWAYS top-level keyRelationshipEdges {aId,a,bId,b,aToB=b's role to a,bToA,reason}; one entry/counterpart. Use late/surviving, never dangling "(deceased)". Social change may evolve+reason; omission NEVER erases other bonds.
11. Age/ApparentAge separate: age=chronology only; apparentAge=visual cue ~N; cue=>MUST return apparentAge when age unknown; species literal; no species-aging inference. Birthday/elapsed=>ageState:"advance"+reason; correction=>ageState:"correct"+reason; visual=>apparentAgeState:"evolve"+reason. Appearance:no age; vague time skip insufficient. gender=male|female only if explicit; never infer; change=>genderState:"correct"+reason.
12. RELATIONSHIP -100..+100 DELTA-ONLY; currentRelationship read-only. Return relationshipDelta+relationshipEvidence (all 4 keys). NEW only; continuation/aftermath=>0. Raw max ${caps.ordinary}/${caps.meaningful}/${caps.major}/${caps.extreme}; axis max 1/2/3/4. EVERY non-zero axis needs grounded evidence from the CURRENT exchange or, when EARLIER exchanges are shown, from the EARLIER exchange it happened in (each is read once). Desire needs explicit attraction/intimacy narration; rescue/gratitude/affection/trust/proximity=>0. Trust!=obedience; Affection!=devotion; Tension!=jealousy.
13. lifeState unknown|alive|deceased; deceased+explicit=terminal death; alive output cannot revive.
14. Memories: max3 NEW in npcs[] (existing too), ADDED to cap5 stored; no duplicate/paraphrased memories. If crowded use memoryRetention=top5 consequential/durable; recency=tiebreak only. homeBase=durable home/workplace/HQ/haunt, never current scene location; keep-by-default; change needs homeBaseState:"update"+homeBaseReason. Caps: ${PROMPT_CAPS}. COMPACT; never invent.
15. JSON only: {"npcs":[...],"profileUpdates":[...],"keyRelationshipEdges":[...]}. profileUpdates example: {"id":"npc_myla","evidence":{"appearance":["bronze braid","patched smock"],"speech":["'Sit, I'll pour.'"]},"appearanceState":"refine","appearance":"A bronze braid gone grey at the tips; a patched wool smock, sleeves rolled, stained with dye.","speechState":"refine","speech":"Quiet, formal: 'Sit, I'll pour.'"}. Existing relationship delta example: {"id":"npc_myla","relationshipDelta":{"trust":-2,"affection":0,"desire":0,"tension":2},"relationshipEvidence":{"trust":"lie","affection":"","desire":"","tension":"conflict"}}.${hiddenNoteRules}

Relationship rubric: ${relationshipRubric || '(none)'}
Impact rubric: ${impactRubric || '(none)'}
Memory criteria: ${memoryRubric || '(none configured; store only clearly durable story-relevant events)'}
Delta caps: ordinary ${caps.ordinary}; meaningful ${caps.meaningful}; major ${caps.major}; extreme ${caps.extreme}. New-NPC baseline: ${JSON.stringify(baseline)}

Identity index (matching only):
${JSON.stringify(identityIndex)}${captureNames}${sceneLine}

Relevant live context (dynamic fields only):
${JSON.stringify(liveSent)}

Stable profile context (strongly relevant existing only):
${JSON.stringify(profileSent)}${dossierNote}${hiddenNoteContext}

${storyContext}`;
}
