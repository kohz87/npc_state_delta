/* NPC State Delta scan-row and candidate normalization: normalizeScanNpc, candidate records, admission/promotion and
   candidate matching. Split from core-record.js without change; core-record.js re-exports every name it exported before. */
import { inferNpcIdentityKind, normalizeAgeFields, normalizeBoolean, normalizeDossierSignal, normalizeGender, normalizeLifeState, slugify } from './core-identity.js';
import { compactDurableText, DURABLE_PROFILE_LIMITS, normalizeRelationshipAbsolutePatch, normalizeRelationshipDelta, normalizeRelationshipEvidence, normalizeScannerRelationshipImpact, RELATIONSHIP_KEYS, semanticDedupeItems } from './core-relationship.js';
import { cleanList, cleanText, normalizeName } from './core-text.js';

import { mergeKeyRelationshipUpdates } from './core-keyrel.js';
import { normalizeMannerisms } from './core-durable.js';
import { isBehaviorLever, normalizeBehaviorProfile } from './core-behavior.js';

import { IMPORTANT_MEMORY_LIMIT, normalizeAppearanceCanon, normalizeNpcAdmissionMode, normalizeLifeStateCertainty, stripRecordCitations } from './core-record-shared.js';
import { normalizeCustomFields } from './core-record-custom-fields.js';
// (ONEPASSCAP-2) keyRelationships sent as one string instead of a list: each non-empty line is one "Name — role | dynamic" entry (the
// prompt's entry form); a list is read as before.
const tieList = (value, historicalRead) => (!historicalRead && typeof value === 'string' ? value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : value);
export function normalizeScanNpc(rawInput = {}, options = {}) {
    const raw = stripRecordCitations(rawInput);
    const memoryInputLimit = Math.max(1, Math.min(IMPORTANT_MEMORY_LIMIT, Math.round(Number(options.memoryInputLimit) || 3)));
    const relationshipDeltaProvided = Object.prototype.hasOwnProperty.call(raw, 'relationshipDelta')
        || Object.prototype.hasOwnProperty.call(raw, 'relationship_delta');
    const proposedDelta = raw.relationshipDelta ?? raw.relationship_delta ?? {};
    const relationshipDelta = normalizeRelationshipDelta(proposedDelta);
    const hasRelationshipDelta = RELATIONSHIP_KEYS.some(key => relationshipDelta[key] !== 0);
    // Compatibility recovery for models that ignore the compact delta contract and
    // return absolute scores under `relationship`. The merge layer converts only
    // explicitly supplied axes back into deltas relative to the stored scores.
    const relationshipAbsolutePatch = normalizeRelationshipAbsolutePatch(raw.relationship);
    const ageFields = normalizeAgeFields(raw);
    const npc = {
        id: cleanText(raw.id, 100),
        name: cleanText(raw.name, 120),
        aliases: cleanList(raw.aliases, 8, 120),
        role: cleanText(raw.role, 300),
        // (card traits win) roleState/roleReason are optional: a bare role is judged by the story event itself (groundedTraitEvent); an explicit reason must be that event.
        roleState: ['update', 'change', 'promote', 'promotion', 'promoted', 'reveal', 'revealed'].includes(String(raw.roleState ?? raw.role_state ?? '').trim().toLowerCase()) ? 'update' : 'keep',
        roleReason: cleanText(raw.roleReason ?? raw.role_reason, 500),
        species: cleanText(raw.species ?? raw.race ?? raw.ancestry ?? raw.speciesRace ?? raw.species_race, 160),
        gender: normalizeGender(raw.gender ?? raw.sex),
        genderState: (() => {
            const state = String(raw.genderState ?? raw.gender_state ?? raw.sexState ?? raw.sex_state ?? '').trim().toLowerCase();
            return state === 'correct' || state === 'correction' ? 'correct' : 'keep';
        })(),
        genderReason: cleanText(raw.genderReason ?? raw.gender_reason ?? raw.sexReason ?? raw.sex_reason, 500),
        homeBase: cleanText(raw.homeBase ?? raw.home_base ?? raw.usualLocation ?? raw.usual_location ?? raw.whereToFind ?? raw.where_to_find, 300),
        homeBaseState: (() => {
            const state = String(raw.homeBaseState ?? raw.home_base_state ?? raw.usualLocationState ?? raw.usual_location_state ?? '').trim().toLowerCase();
            return ['update', 'change', 'move', 'relocate', 'establish', 'refine'].includes(state) ? 'update' : 'keep';
        })(),
        homeBaseReason: cleanText(raw.homeBaseReason ?? raw.home_base_reason ?? raw.usualLocationReason ?? raw.usual_location_reason, 500),
        backgroundState: String(raw.backgroundState ?? raw.background_state ?? '').trim().toLowerCase() === 'update' ? 'update' : '',
        backgroundReason: cleanText(raw.backgroundReason ?? raw.background_reason, 500),
        age: ageFields.age,
        ageState: (() => {
            const state = String(raw.ageState ?? raw.age_state ?? '').trim().toLowerCase();
            return state === 'advance' || state === 'correct' ? state : 'keep';
        })(),
        ageReason: cleanText(raw.ageReason ?? raw.age_reason, 500),
        apparentAge: ageFields.apparentAge,
        apparentAgeState: (() => {
            const state = String(raw.apparentAgeState ?? raw.apparent_age_state ?? '').trim().toLowerCase();
            return state === 'evolve' || state === 'change' ? 'evolve' : 'keep';
        })(),
        apparentAgeReason: cleanText(raw.apparentAgeReason ?? raw.apparent_age_reason, 500),
        appearance: normalizeAppearanceCanon(raw.appearance),
        appearanceState: (() => {
            const state = String(raw.appearanceState ?? raw.appearance_state ?? '').trim().toLowerCase();
            if (state === 'change' || state === 'evolve') return 'change';
            if (['refine', 'update', 'learn', 'establish'].includes(state)) return 'refine';
            return 'keep';
        })(),
        appearanceReason: cleanText(raw.appearanceReason ?? raw.appearance_reason, 500),
        personality: compactDurableText(raw.personality, DURABLE_PROFILE_LIMITS.personality, 6),
        personalityState: (() => {
            const state = String(raw.personalityState ?? raw.personality_state ?? (normalizeBoolean(raw.evolvePersonality ?? raw.evolve_personality) ? 'evolve' : '')).trim().toLowerCase();
            if (state === 'evolve' || state === 'change') return 'evolve';
            if (['refine', 'update', 'learn', 'establish'].includes(state)) return 'refine';
            return 'keep';
        })(),
        personalityReason: cleanText(raw.personalityReason ?? raw.personality_reason, 500),
        speech: compactDurableText(raw.speech, DURABLE_PROFILE_LIMITS.speech, 5),
        speechState: (() => {
            const state = String(raw.speechState ?? raw.speech_state ?? (normalizeBoolean(raw.evolveSpeech ?? raw.evolve_speech) ? 'evolve' : '')).trim().toLowerCase();
            if (state === 'evolve' || state === 'change') return 'evolve';
            if (['refine', 'update', 'learn', 'establish'].includes(state)) return 'refine';
            return 'keep';
        })(),
        speechReason: cleanText(raw.speechReason ?? raw.speech_reason, 500),
        background: compactDurableText(raw.background, DURABLE_PROFILE_LIMITS.background, 8),
        keyRelationships: mergeKeyRelationshipUpdates([], tieList(raw.keyRelationships ?? raw.key_relationships ?? raw.innerCircle ?? raw.inner_circle ?? raw.family, options.historicalRead)), // (ONEPASSCAPR2-1) old rereads retain their original parser
        keyRelationshipsProvided: Object.prototype.hasOwnProperty.call(raw, 'keyRelationships') || Object.prototype.hasOwnProperty.call(raw, 'key_relationships') || Object.prototype.hasOwnProperty.call(raw, 'innerCircle') || Object.prototype.hasOwnProperty.call(raw, 'inner_circle') || Object.prototype.hasOwnProperty.call(raw, 'family'),
        keyRelationshipsState: (() => {
            const state = String(raw.keyRelationshipsState ?? raw.key_relationships_state ?? raw.innerCircleState ?? raw.inner_circle_state ?? (normalizeBoolean(raw.evolveKeyRelationships ?? raw.evolve_key_relationships) ? 'evolve' : '')).trim().toLowerCase();
            if (state === 'evolve' || state === 'change') return 'evolve';
            if (['update', 'refine', 'learn', 'establish'].includes(state)) return 'update';
            return 'keep';
        })(),
        keyRelationshipsReason: cleanText(raw.keyRelationshipsReason ?? raw.key_relationships_reason ?? raw.innerCircleReason ?? raw.inner_circle_reason, 500),
        relationshipSummary: compactDurableText(raw.relationshipSummary, DURABLE_PROFILE_LIMITS.relationshipSummary, 6),
        mood: cleanText(raw.mood, 300),
        moodState: String(raw.moodState ?? raw.mood_state ?? (normalizeBoolean(raw.clearMood ?? raw.clear_mood) ? 'clear' : '')).trim().toLowerCase() === 'clear' ? 'clear' : '',
        location: cleanText(raw.location, 300),
        locationState: String(raw.locationState ?? raw.location_state ?? (normalizeBoolean(raw.clearLocation ?? raw.clear_location) ? 'clear' : '')).trim().toLowerCase() === 'clear' ? 'clear' : '',
        goal: cleanText(raw.goal, 500),
        goalState: String(raw.goalState ?? raw.goal_state ?? (normalizeBoolean(raw.clearGoal ?? raw.clear_goal) ? 'clear' : '')).trim().toLowerCase() === 'clear' ? 'clear' : '',
        status: cleanText(raw.status, 500),
        statusState: String(raw.statusState ?? raw.status_state ?? (normalizeBoolean(raw.clearStatus ?? raw.clear_status) ? 'clear' : '')).trim().toLowerCase() === 'clear' ? 'clear' : '',
        memories: semanticDedupeItems(cleanList(raw.memories, Math.max(6, memoryInputLimit * 2), DURABLE_PROFILE_LIMITS.memory), { maxItems: memoryInputLimit, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58 }),
        memoryRetention: semanticDedupeItems(cleanList(raw.memoryRetention ?? raw.memory_retention, IMPORTANT_MEMORY_LIMIT * 2, DURABLE_PROFILE_LIMITS.memory), { maxItems: IMPORTANT_MEMORY_LIMIT, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58 }),
        mannerisms: normalizeMannerisms(raw.mannerisms),
        mannerismsProvided: Object.prototype.hasOwnProperty.call(raw, 'mannerisms'),
        mannerismState: (() => {
            const state = String(raw.mannerismState ?? raw.mannerism_state ?? (normalizeBoolean(raw.evolveMannerisms ?? raw.evolve_mannerisms) ? 'evolve' : '')).trim().toLowerCase();
            if (state === 'evolve' || state === 'change') return 'evolve';
            if (['refine', 'update', 'learn', 'establish'].includes(state)) return 'refine';
            return 'keep';
        })(),
        mannerismReason: cleanText(raw.mannerismReason ?? raw.mannerism_reason, 500),
        ...(() => {
            // Scanner-proposed levers only; routines/habits are kept aside as Mannerisms evidence.
            const proposed = normalizeBehaviorProfile(raw.behaviorProfile ?? raw.behavior_profile ?? raw.behaviorBreakdown ?? raw.behavior_breakdown);
            const levers = proposed.filter(isBehaviorLever);
            const provided = Object.prototype.hasOwnProperty.call(raw, 'behaviorProfile')
                || Object.prototype.hasOwnProperty.call(raw, 'behavior_profile')
                || Object.prototype.hasOwnProperty.call(raw, 'behaviorBreakdown')
                || Object.prototype.hasOwnProperty.call(raw, 'behavior_breakdown');
            return {
                behaviorProfile: levers,
                // A list made only of non-levers is not a behavior update, so it cannot clear or replace levers.
                behaviorProfileProvided: provided && (levers.length > 0 || proposed.length === 0),
                nonLeverBehavior: proposed.filter(entry => !isBehaviorLever(entry)),
            };
        })(),
        behaviorProfileState: (() => {
            const state = String(raw.behaviorProfileState ?? raw.behavior_profile_state ?? raw.behaviorBreakdownState ?? raw.behavior_breakdown_state ?? '').trim().toLowerCase();
            if (state === 'evolve' || state === 'change') return 'evolve';
            if (['refine', 'update', 'learn', 'establish'].includes(state)) return 'refine';
            return 'keep';
        })(),
        behaviorProfileReason: cleanText(raw.behaviorProfileReason ?? raw.behavior_profile_reason ?? raw.behaviorBreakdownReason ?? raw.behavior_breakdown_reason, 500),
        developmentScale: (() => {
            const scale = String(raw.developmentScale ?? raw.development_scale ?? '').trim().toLowerCase();
            return ['gradual', 'explicit', 'batch'].includes(scale) ? scale : '';
        })(),
        developmentReason: cleanText(raw.developmentReason ?? raw.development_reason, 500),
        present: normalizeBoolean(raw.present),
        worldActive: normalizeBoolean(raw.worldActive ?? raw.world_active ?? raw.activeOffscreen ?? raw.active_offscreen) && !normalizeBoolean(raw.present),
        lifeState: normalizeLifeState(raw.lifeState ?? raw.life_status ?? raw.lifeStatus),
        lifeStateCertainty: normalizeLifeStateCertainty(raw.lifeStateCertainty ?? raw.life_status_certainty ?? raw.lifeStatusCertainty),
        lifeStateReason: cleanText(raw.lifeStateReason ?? raw.lifeStatusReason, 500),
        identityKind: inferNpcIdentityKind(raw.name, raw.identityKind ?? raw.identity_kind),
        dossierSignal: normalizeDossierSignal(raw.dossierSignal ?? raw.dossier_signal ?? raw.persistenceSignal ?? raw.persistence_signal),
        dossierReason: cleanText(raw.dossierReason ?? raw.dossier_reason, 360),
        sameIndividual: normalizeBoolean(raw.sameIndividual ?? raw.same_individual),
        sameIndividualProvided: Object.prototype.hasOwnProperty.call(raw, 'sameIndividual') || Object.prototype.hasOwnProperty.call(raw, 'same_individual'),
        directInteraction: normalizeBoolean(raw.directInteraction ?? raw.direct_interaction ?? raw.interactedDirectly ?? raw.interacted_directly),
        relationshipDelta,
        relationshipDeltaProvided,
        relationshipAbsolutePatch,
        relationshipImpact: normalizeScannerRelationshipImpact(raw.relationshipImpact ?? raw.impactLevel ?? raw.relationshipImpactLevel, hasRelationshipDelta),
        relationshipEvidence: normalizeRelationshipEvidence(raw.relationshipEvidence ?? raw.relationship_evidence),
        relationshipChangeReason: cleanText(raw.relationshipChangeReason ?? raw.relationshipReason, 500),
    };
    const customFields = normalizeCustomFields(raw.customFields ?? raw.custom_fields);
    if (Object.keys(customFields).length) {
        npc.customFields = customFields;
        npc.customFieldsReason = cleanText(raw.customFieldsReason ?? raw.custom_fields_reason, 300);
    }
    return npc;
}


export function normalizeNpcCandidate(raw = {}) {
    const name = cleanText(raw.name ?? raw.label, 120);
    if (!name) return null;
    return {
        id: cleanText(raw.id, 100) || `candidate_${slugify(name)}`,
        name,
        aliases: cleanList(raw.aliases, 6, 120),
        identityKind: inferNpcIdentityKind(name, raw.identityKind),
        dossierSignal: normalizeDossierSignal(raw.dossierSignal),
        dossierReason: cleanText(raw.dossierReason, 360),
        role: cleanText(raw.role, 180),
        gender: normalizeGender(raw.gender ?? raw.sex),
        location: cleanText(raw.location, 220),
        seenCount: Math.max(1, Math.min(99, Math.round(Number(raw.seenCount) || 1))),
        firstSeenTurn: Math.max(0, Math.round(Number(raw.firstSeenTurn) || 0)),
        lastSeenTurn: Math.max(0, Math.round(Number(raw.lastSeenTurn) || 0)),
    };
}

export function candidateRecordMatches(candidate, incoming) {
    if (!candidate || !incoming) return false;
    const incomingNames = new Set([incoming.name, ...(incoming.aliases || [])].map(normalizeName).filter(Boolean));
    return [candidate.name, ...(candidate.aliases || [])].map(normalizeName).filter(Boolean).some(name => incomingNames.has(name));
}

export function makeNpcCandidate(incoming, turn, existingIds = []) {
    const base = `candidate_${slugify(incoming.name)}`;
    let id = base;
    let suffix = 2;
    while (existingIds.includes(id)) id = `${base}_${suffix++}`;
    return {
        id,
        name: incoming.name,
        aliases: [...(incoming.aliases || [])].slice(0, 6),
        identityKind: incoming.identityKind || inferNpcIdentityKind(incoming.name),
        dossierSignal: incoming.dossierSignal || 'incidental',
        dossierReason: incoming.dossierReason || '',
        role: cleanText(incoming.role, 180),
        gender: normalizeGender(incoming.gender),
        location: cleanText(incoming.location, 220),
        seenCount: 1,
        firstSeenTurn: turn,
        lastSeenTurn: turn,
    };
}

export function shouldCreateDossierImmediately(incoming, admissionMode = 'conservative') {
    const mode = normalizeNpcAdmissionMode(admissionMode);
    if (mode === 'manual_only') return false;
    if (incoming.identityKind === 'proper_name') return true;
    if (mode === 'balanced' && (incoming.dossierSignal === 'meaningful' || incoming.dossierSignal === 'persistent' || incoming.directInteraction)) return true;
    // Conservative intentionally ignores model-assigned relevance for a first-seen role label.
    // Role NPCs must earn promotion through confirmed recurrence or an explicit manual add.
    return false;
}

export function shouldPromoteCandidate(candidate, incoming, admissionMode = 'conservative') {
    const mode = normalizeNpcAdmissionMode(admissionMode);
    if (shouldCreateDossierImmediately(incoming, mode)) return true;
    if (mode === 'manual_only') return false;
    return Boolean(incoming.sameIndividual) && Number(candidate?.seenCount || 0) >= 2;
}
