/* NPC State Delta record normalization: stored memories, scan-NPC and candidate normalizing, candidate admission and promotion,
   custom fields, normalizeNpcRecord, createNpcRecord and applyStaleNpcLifecycle, with the record limits, portrait-seed, admission-mode
   and appearance-canon normalizers they use. It also holds the list/field merge helpers (mergeLists, memory and custom-field
   merging, label/place matching, durable-text acceptance) that both the durable profile update and the scan merge read, so
   that core-development.js, core-merge-incoming.js and core-merge.js import only downward. A pure part of core-mechanics.js
   (same owner, moved without change); core-mechanics.js re-exports every name it exported before. Never imports
   core-mechanics.js or core.js. */
import { AGE_NUMBER_WORD_RE, ageSpecificity, inferNpcIdentityKind, isInterimNpcLabel, isRoleDescriptionLabel, makeNpcId, normalizeAgeFields, normalizeBoolean, normalizeDossierSignal, normalizeGender, normalizeLifeState, normalizeStoredAgeFields, slugify } from './core-identity.js';
import { appendRelationshipEvent, calibrateRelationshipSummary, compactDurableText, DEFAULT_RELATIONSHIP, DURABLE_PROFILE_LIMITS, durableSeedGrounded, durableSemanticSimilarity, normalizeRelationshipAbsolutePatch, normalizeRelationshipAuditDelta, normalizeRelationshipBaseline, normalizeRelationshipDelta, normalizeRelationshipEventHistory, normalizeRelationshipEvidence, normalizeRelationshipImpact, normalizeRelationshipMilestones, normalizeRelationshipProgress, normalizeScannerRelationshipImpact, RELATIONSHIP_KEYS, relationshipEventMessage, semanticDedupeItems } from './core-relationship.js';
import { cleanList, cleanText, normalizeName } from './core-text.js';
import { compactKeyRelationshipEntry, KEY_RELATIONSHIP_LIMIT, keyRelationshipSubject, mergeKeyRelationshipUpdates } from './core-keyrel.js';
import { isSafeUnmarkedDurableReplacement, normalizeMannerisms } from './core-durable.js';
import { BEHAVIOR_PROFILE_LIMIT, isBehaviorLever, normalizeBehaviorProfile } from './core-behavior.js';
import { PORTRAIT_NPC_PROMPT_LIMIT } from './core-portrait.js';
import { emptyProfileEvidence, normalizeProfileEvidence } from './core-evidence.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';

export const NPC_ADMISSION_MODES = Object.freeze(['conservative', 'balanced', 'manual_only']);
export const IMPORTANT_MEMORY_LIMIT = 5;

export const PORTRAIT_SEED_MAX = Number.MAX_SAFE_INTEGER;

export function normalizePortraitSeed(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const seed = Number(value);
    return Number.isSafeInteger(seed) && seed >= 0 && seed <= PORTRAIT_SEED_MAX ? seed : null;
}

export function normalizeNpcAdmissionMode(value) {
    const mode = String(value ?? '').trim().toLowerCase();
    return NPC_ADMISSION_MODES.includes(mode) ? mode : 'conservative';
}

export function normalizeLifeStateCertainty(value) {
    const certainty = String(value ?? '').trim().toLowerCase();
    return ['explicit', 'inferred'].includes(certainty) ? certainty : '';
}

export function setNpcArchived(npc, archived, { reason = 'manual', sourceMessageId = null, lifeState = null } = {}) {
    const next = normalizeNpcRecord(npc || {});
    next.archived = Boolean(archived);
    if (next.archived) {
        next.archiveReason = reason === 'deceased' ? 'deceased' : (reason === 'stale' ? 'stale' : 'manual');
        next.archivedAt = Date.now();
        next.archiveSourceMessageId = Number.isInteger(sourceMessageId) ? sourceMessageId : null;
        next.present = false;
        next.worldActive = false;
        if (next.archiveReason === 'deceased') {
            next.lifeState = 'deceased';
            next.lifeStateCertainty = 'explicit';
        }
    } else {
        const wasDeceased = next.archiveReason === 'deceased' || next.lifeState === 'deceased';
        next.archiveReason = '';
        next.archivedAt = null;
        next.archiveSourceMessageId = null;
        if (lifeState !== null) next.lifeState = normalizeLifeState(lifeState);
        else if (wasDeceased) next.lifeState = 'alive';
        if (next.lifeState === 'alive') next.lifeStateCertainty = 'explicit';
    }
    next.updatedAt = Date.now();
    return next;
}



/** The longest a cast dossier's stored appearance can be: the pack's look and wears (1800 each) joined by "; ". */
export const CAST_APPEARANCE_WIDE = 3700;

/**
 * (the living cast) Which of a cast dossier's appearance fields still are the pack's own words (`castFrom.first`), and the stored
 * current appearance split into its parts. The stored `appearance` is the RESOLVED text, "<overallAppearance>; <current part>", so the
 * pack's `wears` is compared with the part after the physical words, not with the whole. Returns
 * { overall, appearance, head, part } where `overall` / `appearance` say the field still is the pack's words, `head` is the physical
 * text and `part` the stored text after it (the whole stored text when it does not start with the physical words).
 */
export function castAppearanceKept(raw) {
    const first = raw?.castFrom && typeof raw.castFrom.first === 'object' && raw.castFrom.first ? raw.castFrom.first : {};
    const text = (value, max) => (typeof value === 'string' ? cleanText(value, max) : '');
    const physical = text(raw?.overallAppearance, 1800);
    const stored = text(raw?.appearance, CAST_APPEARANCE_WIDE);
    const head = physical.replace(/[\s.;,]+$/, '');
    let part = stored;
    let split = false;
    if (physical) {
        if (stored === physical || stored === head) { part = ''; split = true; }
        else if (stored.startsWith(`${head}; `)) { part = stored.slice(head.length + 2); split = true; }
    }
    const firstPhysical = text(first.overallAppearance, 1800);
    const firstCurrent = text(first.appearance, 1800);
    const overall = Boolean(physical) && physical === firstPhysical;
    // No pack words for the current part (an entry without `wears`): the stored text is the physical words alone while it still is them.
    const appearance = Boolean(stored) && (firstCurrent ? part === firstCurrent : (overall && part === ''));
    return { overall, appearance, head, part, split };
}

export const NPC_CANDIDATE_TTL_TURNS = 15;
export const NPC_CANDIDATE_LIMIT = 60;

function normalizeAppearanceCanon(value) {
    let text = compactDurableText(value, DURABLE_PROFILE_LIMITS.appearance, 10);
    if (!text) return '';
    const ageToken = `(?:\\d{1,3}|${AGE_NUMBER_WORD_RE})`;
    const articlePattern = new RegExp(`^(\\s*(?:a|an)\\s+)${ageToken}(?:[-\\s]+years?[-\\s]+old)\\s+`, 'i');
    const barePattern = new RegExp(`^\\s*${ageToken}(?:[-\\s]+years?[-\\s]+old)\\s+`, 'i');
    text = text.replace(articlePattern, '$1').replace(barePattern, '');
    text = text.replace(new RegExp(`^\\s*(?:aged|age)\\s+${ageToken}\\s*[,;:-]?\\s*`, 'i'), '');
    text = text.replace(/\s+/g, ' ').trim();
    if (text && /^[a-z]/.test(text)) text = text.charAt(0).toUpperCase() + text.slice(1);
    return cleanText(text, DURABLE_PROFILE_LIMITS.appearance);
}

export function npcMatchesLabel(npc, label) {
    const key = normalizeName(label);
    if (!key || !npc) return false;
    return [npc.name, ...(npc.aliases || [])].some(value => normalizeName(value) === key);
}

export function normalizeStoredMemories(value) {
    const cleaned = semanticDedupeItems(cleanList(value, 64, DURABLE_PROFILE_LIMITS.memory), {
        maxItems: 64,
        maxChars: DURABLE_PROFILE_LIMITS.memory,
        similarity: 0.58,
    });
    if (cleaned.length <= IMPORTANT_MEMORY_LIMIT) return cleaned;
    // Keep only the most recent bounded set after semantic dedupe.
    return cleaned.slice(-IMPORTANT_MEMORY_LIMIT);
}

export function normalizeScanNpc(raw = {}, options = {}) {
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
        keyRelationships: mergeKeyRelationshipUpdates([], raw.keyRelationships ?? raw.key_relationships ?? raw.innerCircle ?? raw.inner_circle ?? raw.family),
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

// User-defined dossier fields (for example Level or Class), named once in settings for every chat.
export const CUSTOM_FIELD_LIMIT = 6;
const CUSTOM_FIELD_STORED_LIMIT = 12;
const CUSTOM_FIELD_NAME_MAX = 40;
const CUSTOM_FIELD_VALUE_MAX = 60;

export function normalizeCustomFieldNames(value) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
    const names = [];
    for (const item of items) {
        const name = cleanText(String(item ?? '').replace(/["{}:]/g, ' '), CUSTOM_FIELD_NAME_MAX);
        if (name && !names.some(other => other.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    return names.slice(0, CUSTOM_FIELD_LIMIT);
}

export function normalizeCustomFields(raw) {
    const entries = Array.isArray(raw)
        ? raw.map(item => [item?.name ?? item?.field, item?.value])
        : Object.entries(raw && typeof raw === 'object' ? raw : {});
    const out = {};
    for (const [key, value] of entries) {
        const name = cleanText(key, CUSTOM_FIELD_NAME_MAX);
        const text = cleanText(typeof value === 'number' ? String(value) : value, CUSTOM_FIELD_VALUE_MAX);
        if (!name || !text || Object.keys(out).some(other => other.toLowerCase() === name.toLowerCase())) continue;
        out[name] = text;
        if (Object.keys(out).length >= CUSTOM_FIELD_STORED_LIMIT) break;
    }
    return out;
}

// The stored values of the configured fields, keyed by the configured spelling.
export function customFieldValues(npc = {}, names = []) {
    const stored = normalizeCustomFields(npc?.customFields);
    const out = {};
    for (const name of normalizeCustomFieldNames(names)) {
        const key = Object.keys(stored).find(other => other.toLowerCase() === name.toLowerCase());
        if (key) out[name] = stored[key];
    }
    return out;
}

function collapsedText(value) {
    return String(value ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Keep-by-default: a configured field is set from the scan only when the source text carries the
// value, and an established value changes only with a stated reason. Omission keeps what is stored.
function mergeCustomFieldValues(existing, incoming, { names = [], reason = '', context = '' } = {}) {
    const configured = normalizeCustomFieldNames(names);
    if (!configured.length) return null;
    const out = normalizeCustomFields(existing);
    const source = collapsedText(context);
    let changed = false;
    for (const [key, value] of Object.entries(normalizeCustomFields(incoming))) {
        const name = configured.find(item => item.toLowerCase() === key.toLowerCase());
        if (!name) continue;
        const storedKey = Object.keys(out).find(other => other.toLowerCase() === name.toLowerCase());
        const prior = storedKey ? out[storedKey] : '';
        if (prior && prior.toLowerCase() === value.toLowerCase()) continue;
        if (prior && !String(reason || '').trim()) continue;
        if (source && !source.includes(collapsedText(value))) continue;
        if (storedKey && storedKey !== name) delete out[storedKey];
        out[name] = value;
        changed = true;
    }
    return changed ? out : null;
}

export function normalizeNpcRecord(raw = {}) {
    const npc = { ...raw };
    // Manual profile locks block scanner rewrites. Data hygiene still normalizes whitespace,
    // but semantic compaction is skipped for explicitly locked stable fields.
    npc.manualProfileFields = Array.isArray(raw.manualProfileFields)
        ? [...new Set(raw.manualProfileFields.map(value => String(value || '').trim()).filter(Boolean))]
        : [];
    const locked = new Set(npc.manualProfileFields);

    npc.name = cleanText(raw.name, 120) || 'Unnamed NPC';
    npc.identityKind = inferNpcIdentityKind(npc.name, raw.identityKind ?? raw.identity_kind);
    npc.role = cleanText(raw.role, 300);
    npc.species = cleanText(raw.species ?? raw.race ?? raw.ancestry ?? raw.speciesRace ?? raw.species_race, 160);
    npc.gender = normalizeGender(raw.gender ?? raw.sex);
    npc.homeBase = cleanText(raw.homeBase ?? raw.home_base ?? raw.usualLocation ?? raw.usual_location ?? raw.whereToFind ?? raw.where_to_find, 300);
    const customFields = normalizeCustomFields(raw.customFields);
    if (Object.keys(customFields).length) npc.customFields = customFields;
    else delete npc.customFields;
    const ageFields = normalizeStoredAgeFields(raw);
    npc.age = ageFields.age;
    npc.apparentAge = ageFields.apparentAge;
    // (the living cast) A dossier made from the pack's cast keeps the pack's words exactly as written (`castFrom.first`) for as long as
    // the stored field still is those words; once a scan or the reader changes the field it is compacted like any other.
    const packFirst = raw.castFrom && typeof raw.castFrom.first === 'object' && raw.castFrom.first ? raw.castFrom.first : {};
    const packWords = (field, max) => {
        const text = typeof packFirst[field] === 'string' ? cleanText(packFirst[field], max) : '';
        return text && cleanText(raw[field], max) === text;
    };
    npc.personality = locked.has('personality') || packWords('personality', 900)
        ? cleanText(raw.personality, 900)
        : compactDurableText(raw.personality, DURABLE_PROFILE_LIMITS.personality, 6);
    npc.speech = locked.has('speech') || packWords('speech', 600)
        ? cleanText(raw.speech, 600)
        : compactDurableText(raw.speech, DURABLE_PROFILE_LIMITS.speech, 5);
    // The stored appearance of a cast dossier is "<physical>; <current part>": the pack's `wears` is the current part, compared apart
    // from the physical words. While it is unchanged the whole text stays exact (any size the pack allows); once a scan or the reader
    // changed the current part, the normal canon applies to that part alone and the pack's physical words stay in front of it.
    const castKept = castAppearanceKept(raw);
    if (locked.has('appearance')) npc.appearance = cleanText(raw.appearance, 1800);
    else if (castKept.appearance) npc.appearance = cleanText(raw.appearance, CAST_APPEARANCE_WIDE);
    else if (castKept.overall && castKept.split && castKept.part) {
        const part = normalizeAppearanceCanon(castKept.part);
        npc.appearance = part ? cleanText(`${castKept.head}; ${part}`, CAST_APPEARANCE_WIDE) : cleanText(castKept.head, CAST_APPEARANCE_WIDE);
    } else npc.appearance = normalizeAppearanceCanon(raw.appearance);
    npc.background = locked.has('background') || packWords('background', 1200)
        ? cleanText(raw.background, 1200)
        : compactDurableText(raw.background, DURABLE_PROFILE_LIMITS.background, 8);
    npc.relationshipSummary = compactDurableText(raw.relationshipSummary, DURABLE_PROFILE_LIMITS.relationshipSummary, 6);
    npc.mood = cleanText(raw.mood, 300);
    npc.location = cleanText(raw.location, 300);
    npc.goal = cleanText(raw.goal, 500);
    npc.status = cleanText(raw.status, 500);
    npc.portraitPromptPositive = cleanText(raw.portraitPromptPositive ?? raw.portrait_prompt_positive, PORTRAIT_NPC_PROMPT_LIMIT);
    npc.portraitPromptNegative = cleanText(raw.portraitPromptNegative ?? raw.portrait_prompt_negative, PORTRAIT_NPC_PROMPT_LIMIT);
    npc.portraitPromptReplace = normalizeBoolean(raw.portraitPromptReplace ?? raw.portrait_prompt_replace);
    npc.portraitSeed = normalizePortraitSeed(raw.portraitSeed ?? raw.portrait_seed);
    npc.aliases = cleanList(raw.aliases, 8, 120);
    npc.memories = normalizeStoredMemories(raw.memories);
    // The memories the reader entered by hand (never evicted by a later scan), while they are stored.
    const manualMemories = Array.isArray(raw.manualMemories)
        ? raw.manualMemories.map(item => cleanText(item, DURABLE_PROFILE_LIMITS.memory)).filter(item => item && npc.memories.some(stored => normalizeName(stored) === normalizeName(item)))
        : [];
    if (manualMemories.length) npc.manualMemories = [...new Set(manualMemories)];
    else delete npc.manualMemories;
    // A pack's levers and mannerisms are lists: whole while the stored list still is the pack's list (the cast builds them to pass the
    // normalizers unchanged; this keeps them if a normalizer ever changes).
    const packList = (field, max, chars) => {
        const first = Array.isArray(packFirst[field]) ? cleanList(packFirst[field], max, chars) : [];
        const stored = cleanList(field === 'behaviorProfile' ? raw.behaviorProfile ?? raw.behavior_profile : raw[field], max, chars);
        return first.length && first.length === stored.length && first.every((item, index) => item === stored[index]) ? stored : null;
    };
    npc.mannerisms = locked.has('mannerisms')
        ? cleanList(raw.mannerisms, 8, 320)
        : packList('mannerisms', 4, DURABLE_PROFILE_LIMITS.mannerism) ?? normalizeMannerisms(raw.mannerisms);
    npc.behaviorProfile = locked.has('behaviorProfile')
        ? cleanList(raw.behaviorProfile ?? raw.behavior_profile, BEHAVIOR_PROFILE_LIMIT, 320)
        : packList('behaviorProfile', BEHAVIOR_PROFILE_LIMIT, DURABLE_PROFILE_LIMITS.behaviorProfile) ?? normalizeBehaviorProfile(raw.behaviorProfile ?? raw.behavior_profile);
    npc.keyRelationships = locked.has('keyRelationships')
        ? (Array.isArray(raw.keyRelationships ?? raw.key_relationships ?? raw.innerCircle ?? raw.inner_circle ?? raw.family)
            ? (raw.keyRelationships ?? raw.key_relationships ?? raw.innerCircle ?? raw.inner_circle ?? raw.family)
                .map(compactKeyRelationshipEntry).filter(Boolean).slice(0, KEY_RELATIONSHIP_LIMIT)
            : [])
        : mergeKeyRelationshipUpdates([], raw.keyRelationships ?? raw.key_relationships ?? raw.innerCircle ?? raw.inner_circle ?? raw.family);
    npc.profileEvidence = normalizeProfileEvidence(raw.profileEvidence ?? raw.profile_evidence);
    // Current Thoughts are not durable dossier state; NPC Inner Chatter is ephemeral.
    delete npc.thoughts;
    const relationship = raw.relationship && typeof raw.relationship === 'object' ? raw.relationship : {};
    npc.relationship = normalizeRelationshipBaseline(relationship);
    npc.relationshipProgress = normalizeRelationshipProgress(raw.relationshipProgress ?? raw.relationship_progress);
    npc.relationshipMilestones = normalizeRelationshipMilestones(raw.relationshipMilestones ?? raw.relationship_milestones, npc.relationship);
    npc.relationshipEventHistory = normalizeRelationshipEventHistory(raw.relationshipEventHistory ?? raw.relationship_event_history);
    npc.relationshipSummary = calibrateRelationshipSummary(npc.relationshipSummary, npc.relationship);
    const lastChange = raw.lastRelationshipChange && typeof raw.lastRelationshipChange === 'object' ? raw.lastRelationshipChange : {};
    const normalizedAuditDelta = normalizeRelationshipAuditDelta(lastChange.delta ?? {});
    const auditHasDelta = RELATIONSHIP_KEYS.some(key => normalizedAuditDelta[key] !== 0);
    const auditEvidence = normalizeRelationshipEvidence(lastChange.evidence);
    const auditHasEvidence = RELATIONSHIP_KEYS.some(key => auditEvidence[key]);
    const auditReason = cleanText(lastChange.reason, 500);
    const auditIsManual = String(lastChange.impact || '').toLowerCase() === 'manual';
    npc.lastRelationshipChange = (auditHasDelta || auditHasEvidence) && !auditReason && !auditIsManual
        ? {
            impact: 'none',
            delta: { trust: 0, affection: 0, desire: 0, tension: 0 },
            evidence: normalizeRelationshipEvidence(),
            reason: '',
            sourceMessageId: null,
        }
        : {
            impact: auditIsManual ? 'manual' : normalizeRelationshipImpact(lastChange.impact, auditHasDelta || auditHasEvidence),
            delta: normalizedAuditDelta,
            evidence: auditEvidence,
            reason: auditReason,
            sourceMessageId: Number.isInteger(lastChange.sourceMessageId) ? lastChange.sourceMessageId : null,
            ...(Number.isFinite(Number(lastChange.turn)) ? { turn: Number(lastChange.turn) } : {}),
            ...relationshipEventMessage(lastChange),
        };
    if (!npc.relationshipEventHistory.length
        && npc.lastRelationshipChange.impact !== 'none'
        && npc.lastRelationshipChange.impact !== 'manual'
        && npc.lastRelationshipChange.reason) {
        npc.relationshipEventHistory = appendRelationshipEvent([], npc.lastRelationshipChange);
    }
    npc.present = normalizeBoolean(raw.present);
    npc.worldActive = normalizeBoolean(raw.worldActive) && !npc.present;
    npc.lifeState = normalizeLifeState(raw.lifeState);
    npc.lifeStateCertainty = normalizeLifeStateCertainty(raw.lifeStateCertainty);
    npc.lifeStateReason = cleanText(raw.lifeStateReason, 500);
    npc.archived = normalizeBoolean(raw.archived);
    npc.archiveReason = raw.archiveReason === 'deceased' ? 'deceased' : (raw.archiveReason === 'stale' ? 'stale' : (raw.archiveReason === 'manual' ? 'manual' : ''));
    npc.minor = normalizeBoolean(raw.minor ?? raw.isMinor ?? raw.is_minor ?? raw.hideFromGallery ?? raw.hide_from_gallery);
    npc.archivedAt = Number.isFinite(Number(raw.archivedAt)) ? Number(raw.archivedAt) : null;
    npc.archiveSourceMessageId = Number.isInteger(raw.archiveSourceMessageId) ? raw.archiveSourceMessageId : null;
    npc.retentionProtected = normalizeBoolean(raw.retentionProtected ?? raw.retention_protected ?? raw.keepFromStaleCleanup ?? raw.keep_from_stale_cleanup);
    npc.lastSeenTurn = Math.max(0, Math.round(Number(raw.lastSeenTurn) || 0));
    npc.lastWorldActiveTurn = Math.max(0, Math.round(Number(raw.lastWorldActiveTurn) || 0));
    npc.seenCount = Math.max(0, Math.round(Number(raw.seenCount) || 0));
    npc.createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now();
    npc.updatedAt = Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : npc.createdAt;
    delete npc.importance;
    delete npc.manual;
    if (npc.archived) { npc.present = false; npc.worldActive = false; }
    return npc;
}

export function createNpcRecord(name, existingIds = [], baseline = DEFAULT_RELATIONSHIP) {
    return {
        id: makeNpcId(name, existingIds),
        name: cleanText(name, 120) || 'Unnamed NPC',
        identityKind: inferNpcIdentityKind(name),
        aliases: [],
        role: '',
        species: '',
        gender: '',
        homeBase: '',
        age: '',
        apparentAge: '',
        appearance: '',
        personality: '',
        speech: '',
        background: '',
        relationshipSummary: '',
        mood: '',
        location: '',
        goal: '',
        status: '',
        memories: [],
        mannerisms: [],
        behaviorProfile: [],
        keyRelationships: [],
        profileEvidence: emptyProfileEvidence(),
        present: false,
        worldActive: false,
        lastWorldActiveTurn: 0,
        lifeState: 'unknown',
        lifeStateCertainty: '',
        lifeStateReason: '',
        archived: false,
        archiveReason: '',
        archivedAt: null,
        archiveSourceMessageId: null,
        relationship: normalizeRelationshipBaseline(baseline),
        relationshipProgress: normalizeRelationshipProgress(),
        relationshipMilestones: [],
        relationshipEventHistory: [],
        lastRelationshipChange: { impact: 'none', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, evidence: normalizeRelationshipEvidence(), reason: '', sourceMessageId: null },
        portrait: null,
        portraitPromptPositive: '',
        portraitPromptNegative: '',
        portraitPromptReplace: false,
        portraitSeed: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSeenTurn: 0,
        seenCount: 0,
        manualProfileFields: [],
        retentionProtected: false,
        minor: false,
    };
}


export function applyStaleNpcLifecycle(state = {}, options = {}) {
    const turn = Math.max(0, Math.round(Number(options.turn ?? state?.turn ?? 0) || 0));
    const archiveAfter = Math.max(1, Math.round(Number(options.archiveAfter) || 30));
    const deleteAfter = Math.max(archiveAfter + 1, Math.round(Number(options.deleteAfter) || 50));
    const protectedIds = new Set((options.protectedIds || []).map(value => String(value || '').trim()).filter(Boolean));
    const next = { ...state };
    const archived = [];
    const removed = [];
    const removedIds = new Set();
    next.npcs = [];

    for (const raw of (Array.isArray(state?.npcs) ? state.npcs : [])) {
        let npc = normalizeNpcRecord(raw);
        if (isTerminalNpcDeath(npc) || npc.present || npc.worldActive || npc.retentionProtected || protectedIds.has(npc.id)) {
            next.npcs.push(npc);
            continue;
        }
        const activityTurn = Math.max(Number(npc.lastSeenTurn || 0), Number(npc.lastWorldActiveTurn || 0));
        const age = Math.max(0, turn - activityTurn);

        // Only stale-auto-archives participate in timed deletion. Manual and death archives are
        // durable records and remain until the player explicitly removes them.
        if (npc.archived) {
            if (npc.archiveReason === 'stale' && age >= deleteAfter) {
                removed.push({ id: npc.id, name: npc.name, age, activityTurn, archiveReason: 'stale' });
                removedIds.add(npc.id);
                continue;
            }
            next.npcs.push(npc);
            continue;
        }

        if (age >= deleteAfter) {
            // On upgrades or very long gaps, a dossier may already be beyond both thresholds.
            // Delete it directly rather than creating a one-scan zombie archive.
            removed.push({ id: npc.id, name: npc.name, age, activityTurn, archiveReason: 'stale' });
            removedIds.add(npc.id);
            continue;
        }
        if (age >= archiveAfter) {
            npc = setNpcArchived(npc, true, { reason: 'stale' });
            archived.push({ id: npc.id, name: npc.name, age, activityTurn });
        }
        next.npcs.push(npc);
    }

    if (removedIds.size) {
        if (Array.isArray(state?.pendingBackfills)) {
            next.pendingBackfills = state.pendingBackfills.filter(item => !removedIds.has(String(item?.npcId || '')));
        }
        if (Array.isArray(state?.inlineCards)) {
            next.inlineCards = state.inlineCards.map(entry => ({
                ...entry,
                cards: Array.isArray(entry?.cards) ? entry.cards.filter(card => !removedIds.has(String(card?.id || ''))) : [],
            })).filter(entry => Array.isArray(entry.cards) && entry.cards.length > 0);
        }
        if (state?.portraitAssets && typeof state.portraitAssets === 'object') {
            next.portraitAssets = { ...state.portraitAssets };
            for (const id of removedIds) delete next.portraitAssets[id];
        }
    }

    // Auto lifecycle never suppresses names. A stale NPC can return naturally and receive a new
    // dossier after timed deletion.
    return { state: next, archived, removed };
}

const GENERIC_PLACE_WORDS = new Set(['near', 'from', 'with', 'into', 'outside', 'inside', 'room', 'hall', 'house',
    'street', 'road', 'square', 'market', 'tavern', 'city', 'town', 'village', 'district', 'quarter']);

function placesOverlap(a, b) {
    const left = normalizeName(a);
    const right = normalizeName(b);
    if (!left || !right) return false;
    if (` ${left} `.includes(` ${right} `) || ` ${right} `.includes(` ${left} `)) return true;
    const words = new Set(left.split(' ').filter(word => word.length >= 4 && !GENERIC_PLACE_WORDS.has(word)));
    return right.split(' ').some(word => words.has(word));
}

// A shared role-description label ("Innkeeper", "the captain") fits many people, so on its own it
// links a scan row to a properly named record only with continuity evidence: sameIndividual, the
// record being present (before this scan reset presence), or an overlapping location/home base. A
// record still named by a role keeps plain label matching so interim-identity promotion and name
// reveals continue to work.
export function scanLabelsMatch(record, incoming, presentIds = new Set()) {
    const incomingLabels = [incoming.name, ...(incoming.aliases || [])].filter(label => normalizeName(label));
    const recordLabels = [record.name, ...(record.aliases || [])].filter(label => normalizeName(label));
    const sharedKeys = new Set(recordLabels.map(normalizeName).filter(key => incomingLabels.some(label => normalizeName(label) === key)));
    if (!sharedKeys.size) return false;
    if (isInterimNpcLabel(record.name, record.identityKind) || isRoleDescriptionLabel(record.name)) return true;
    // A label counts as a name when either side spells it as one ("Red" beside "red").
    if ([...recordLabels, ...incomingLabels].some(label => sharedKeys.has(normalizeName(label)) && !isRoleDescriptionLabel(label))) return true;
    if (incoming.sameIndividual === true || record.present === true || presentIds.has(record.id)) return true;
    return [record.location, record.homeBase].some(place =>
        [incoming.location, incoming.homeBase].some(other => placesOverlap(place, other)));
}

export function candidateMatches(existing, incoming, presentIds) {
    if (incoming.id && incoming.id === existing.id) return true;
    return scanLabelsMatch(existing, incoming, presentIds);
}

export function mergeLists(oldList, newList, limit = 8) {
    const result = [];
    const seen = new Set();
    for (const item of [...(oldList || []), ...(newList || [])]) {
        const key = normalizeName(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
        if (result.length >= limit) break;
    }
    return result;
}

// (cleanup step 6) Memories the reader entered by hand (`pinned`, the record's manualMemories) are
// never evicted: new ones take only the slots the reader's own leave free.
export function mergeImportantMemories(oldList, newList, retentionList = [], incomingLimit = 3, pinned = []) {
    const merged = mergeUnpinnedMemories(oldList, newList, retentionList, incomingLimit);
    const keep = (Array.isArray(pinned) ? pinned : []).map(normalizeName).filter(Boolean);
    if (!keep.length) return merged;
    const isPinned = item => keep.includes(normalizeName(item));
    const existing = cleanList(oldList, 64, DURABLE_PROFILE_LIMITS.memory);
    const missing = existing.filter(item => isPinned(item) && !merged.some(other => normalizeName(other) === normalizeName(item)));
    if (!missing.length) return merged;
    const order = [...existing, ...merged.filter(item => !existing.some(other => normalizeName(other) === normalizeName(item)))];
    const chosen = new Set([...merged, ...missing].map(normalizeName));
    const out = order.filter(item => chosen.has(normalizeName(item)));
    // Too many: drop the oldest memories the reader did not write.
    while (out.length > IMPORTANT_MEMORY_LIMIT) {
        const at = out.findIndex(item => !isPinned(item));
        if (at < 0) break;
        out.splice(at, 1);
    }
    return out.slice(-IMPORTANT_MEMORY_LIMIT);
}

function mergeUnpinnedMemories(oldList, newList, retentionList = [], incomingLimit = 3) {
    const existing = semanticDedupeItems(cleanList(oldList, 64, DURABLE_PROFILE_LIMITS.memory), {
        maxItems: 64, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58,
    });
    const limit = Math.max(1, Math.min(IMPORTANT_MEMORY_LIMIT, Math.round(Number(incomingLimit) || 3)));
    const incoming = semanticDedupeItems(cleanList(newList, Math.max(6, limit * 2), DURABLE_PROFILE_LIMITS.memory), {
        maxItems: limit, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58,
    });
    const pool = semanticDedupeItems([...existing, ...incoming], {
        maxItems: 64, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58,
    });
    if (pool.length <= IMPORTANT_MEMORY_LIMIT) return pool;

    const requested = semanticDedupeItems(cleanList(retentionList, IMPORTANT_MEMORY_LIMIT * 2, DURABLE_PROFILE_LIMITS.memory), {
        maxItems: IMPORTANT_MEMORY_LIMIT, maxChars: DURABLE_PROFILE_LIMITS.memory, similarity: 0.58,
    });
    const selected = [];
    const selectCanonical = request => {
        let best = null;
        let bestScore = 0;
        for (const candidate of pool) {
            const score = normalizeName(candidate) === normalizeName(request) ? 1 : durableSemanticSimilarity(candidate, request);
            if (score > bestScore) { best = candidate; bestScore = score; }
        }
        return bestScore >= 0.56 ? best : null;
    };
    for (const item of requested) {
        const canonical = selectCanonical(item);
        if (!canonical || selected.some(value => durableSemanticSimilarity(value, canonical) >= 0.58)) continue;
        selected.push(canonical);
    }

    if (selected.length) {
        // A partial/malformed model selection must not re-lock the list. Fill any
        // missing slots with newest semantically distinct memories first.
        for (const item of [...incoming, ...existing].reverse()) {
            if (selected.some(value => durableSemanticSimilarity(value, item) >= 0.58)) continue;
            selected.push(item);
            if (selected.length >= IMPORTANT_MEMORY_LIMIT) break;
        }
        return selected.slice(0, IMPORTANT_MEMORY_LIMIT);
    }

    // Scanner omitted semantic retention. Prefer the newest five distinct events.
    return pool.slice(-IMPORTANT_MEMORY_LIMIT);
}

// ---- Durable-field rules shared by a scan row (npcs[]) and a profile update (profileUpdates[]) ----
// (cleanup step 5) A model may send an existing NPC's durable facts in either channel; both apply
// them by these same rules.

// The plain durable texts a profile update applies with the npcs[] rules (the profile texts, Personality,
// Speech and Appearance, have their own evidence-gated rules there).
export const PROFILE_UPDATE_TEXT_FIELDS = Object.freeze(['role', 'species', 'gender', 'homeBase', 'age', 'apparentAge', 'background']);

// Gender, home base, background and ages are keep-by-default once established.
export function durableTextAccepted(field, existing, incoming, value, options = {}) {
    if (field === 'gender') {
        const prior = normalizeGender(existing.gender);
        return !(prior && prior !== value && (incoming.genderState !== 'correct' || !String(incoming.genderReason || '').trim()));
    }
    if (field === 'homeBase') {
        const prior = String(existing.homeBase || '').trim();
        const context = String(options.developmentContext || '').trim();
        if (prior) {
            if (incoming.homeBaseState !== 'update' || !String(incoming.homeBaseReason || '').trim()) return false;
            if (context && !durableSeedGrounded(value, context)) return false;
        } else if (context && !durableSeedGrounded(value, context)) {
            return false;
        }
        return true;
    }
    if (field === 'background') {
        // (cleanup step 6) Background is durable history and keep-by-default like the home base: an
        // established one changes with backgroundState:"update" + backgroundReason + grounding. No
        // prompt asks for that state yet, so a grounded restatement that keeps every stored concept
        // (the unmarked-refinement safety appearance uses) is accepted too; a shorter restatement that
        // drops a stored clause is not.
        const prior = String(existing.background || '').trim();
        const context = String(options.developmentContext || '').trim();
        if (prior && normalizeName(prior) === normalizeName(value)) return false;
        if (prior) {
            const marked = incoming.backgroundState === 'update' && String(incoming.backgroundReason || '').trim();
            if (!marked && !isSafeUnmarkedDurableReplacement(prior, value)) return false;
        }
        return !context || durableSeedGrounded(value, context);
    }
    if (field === 'age' && String(existing.age || '').trim()) {
        // Chronological age is keep-by-default once established. It may advance from
        // explicit elapsed chronology/birthdays or be corrected by stronger story evidence.
        // An advance may never move an exact numeric age backward or sideways.
        const state = String(incoming.ageState || 'keep');
        if ((state !== 'advance' && state !== 'correct') || !String(incoming.ageReason || '').trim()) return false;
        const oldExact = /^\d{1,3}$/.test(String(existing.age || '').trim()) ? Number(existing.age) : null;
        const newExact = /^\d{1,3}$/.test(String(value || '').trim()) ? Number(value) : null;
        if (state === 'advance' && oldExact !== null && newExact !== null && newExact <= oldExact) return false;
    }
    if (field === 'apparentAge' && String(existing.apparentAge || '').trim()) {
        // Apparent age is also keep-by-default. Visual aging, growth, rejuvenation,
        // transformation, or a grounded correction must be explicitly marked as evolution.
        if (incoming.apparentAgeState !== 'evolve' || !String(incoming.apparentAgeReason || '').trim()) return false;
    }
    if (field === 'age' || field === 'apparentAge') {
        // Even a lifecycle update cannot downgrade stronger age evidence to a weaker estimate.
        if (ageSpecificity(existing[field]) > ageSpecificity(value)) return false;
    }
    return true;
}

// Configured custom fields only, grounded in the source text; a change needs a reason. Null when
// nothing is accepted.
export function incomingCustomFields(existing, incoming, manualFields, options = {}) {
    if (!incoming.customFields || manualFields.has('customFields')) return null;
    return mergeCustomFieldValues(existing.customFields, incoming.customFields, {
        names: options.customFieldNames,
        reason: incoming.customFieldsReason,
        context: options.developmentContext,
    });
}

// The NPC's Key Relationships after an incoming row: merged by counterpart; unmarked rows add new
// counterparts only.
export function incomingKeyRelationships(existing, incoming, manualFields) {
    if (manualFields.has('keyRelationships')) {
        return [...(existing.keyRelationships || [])];
    } else if ((existing.keyRelationships || []).length) {
        // Key Relationships are durable social continuity, not a running contact log.
        // Scanner omission is never evidence that another important bond vanished. Even
        // during an evolution, update named counterparts in place and preserve unrelated
        // bonds; estrangement/death should change that counterpart's entry rather than
        // silently deleting everyone the model did not mention this turn.
        if (incoming.keyRelationshipsState === 'evolve'
            && String(incoming.keyRelationshipsReason || '').trim()
            && incoming.keyRelationshipsProvided) {
            return mergeKeyRelationshipUpdates(existing.keyRelationships, incoming.keyRelationships || []);
        } else if (incoming.keyRelationshipsState === 'update'
            && incoming.keyRelationshipsProvided) {
            // Discovery/clarification is not social evolution. A model that correctly
            // marks an update may omit the audit reason, so the explicit lifecycle state
            // plus grounded entries is sufficient to merge by counterpart.
            return mergeKeyRelationshipUpdates(existing.keyRelationships, incoming.keyRelationships);
        } else if (incoming.keyRelationshipsProvided && (incoming.keyRelationships || []).length) {
            // Recovery for models that extract an explicit newly revealed tie but omit
            // the lifecycle marker entirely. Only NEW counterparts are admitted here;
            // an unmarked rewrite of an already-known person's dynamic is still rejected.
            const knownSubjects = new Set((existing.keyRelationships || []).map(keyRelationshipSubject).filter(Boolean));
            const newlyEstablished = (incoming.keyRelationships || []).filter(entry => {
                const subject = keyRelationshipSubject(entry);
                return subject && !knownSubjects.has(subject);
            });
            return newlyEstablished.length
                ? mergeKeyRelationshipUpdates(existing.keyRelationships, newlyEstablished)
                : [...(existing.keyRelationships || [])];
        } else {
            return [...(existing.keyRelationships || [])];
        }
    } else {
        return mergeKeyRelationshipUpdates([], incoming.keyRelationships || []);
    }
}
