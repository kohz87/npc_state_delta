/* NPC State Delta record facade: canonical stored-record normalization and lifecycle owners. The implementation is split
   across core-record-shared.js, core-record-scan.js, core-record-custom-fields.js and core-record-merge.js; this module
   keeps its original path and re-exports every public name unchanged. */
import { inferNpcIdentityKind, makeNpcId, normalizeBoolean, normalizeGender, normalizeLifeState, normalizeStoredAgeFields } from './core-identity.js';
import { appendRelationshipEvent, calibrateRelationshipSummary, compactDurableText, DEFAULT_RELATIONSHIP, DURABLE_PROFILE_LIMITS, normalizeRelationshipAuditDelta, normalizeRelationshipBaseline, normalizeRelationshipEventHistory, normalizeRelationshipEvidence, normalizeRelationshipImpact, normalizeRelationshipMilestones, normalizeRelationshipProgress, RELATIONSHIP_KEYS, relationshipEventMessage } from './core-relationship.js';
import { cleanList, cleanText, normalizeName } from './core-text.js';

import { cleanTieSeen, compactKeyRelationshipEntry, KEY_RELATIONSHIP_LIMIT, mergeKeyRelationshipUpdates } from './core-keyrel.js';
import { normalizeMannerisms } from './core-durable.js';
import { BEHAVIOR_PROFILE_LIMIT, normalizeBehaviorProfile } from './core-behavior.js';
import { PORTRAIT_NPC_PROMPT_LIMIT } from './core-portrait.js';
import { emptyProfileEvidence, normalizeProfileEvidence } from './core-evidence.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
import { CAST_APPEARANCE_WIDE, castAppearanceKept, normalizeAppearanceCanon, normalizeLifeStateCertainty, normalizeMemoryStamps, normalizePortraitSeed, normalizeStoredMemories, stripRecordCitations } from './core-record-shared.js';
import { portraitHasImage } from './src/portrait-file.js';
import { impactDayProblems } from './src/relationship-pacing.js';
import { normalizeCustomFields } from './core-record-custom-fields.js';
export function setNpcArchived(npc, archived, { reason = 'manual', sourceMessageId = null, lifeState = null, now = null } = {}) {
    // `now` is the caller's clock (the replay clock while a history is replayed); without it, the real one (live, manual).
    const at = Number.isFinite(now) ? now : Date.now();
    const next = normalizeNpcRecord(npc || {});
    next.archived = Boolean(archived);
    if (next.archived) {
        next.archiveReason = reason === 'deceased' ? 'deceased' : (reason === 'stale' ? 'stale' : 'manual');
        next.archivedAt = at;
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
    next.updatedAt = at;
    return next;
}




export function normalizeNpcRecord(rawInput = {}) {
    const raw = stripRecordCitations(rawInput);
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
    const memoryStamps = normalizeMemoryStamps(raw.memoryStamps, npc.memories);
    if (memoryStamps) npc.memoryStamps = memoryStamps;
    else delete npc.memoryStamps;
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
    { const seen = cleanTieSeen(raw.tieSeen); if (seen) npc.tieSeen = seen; }   // last story day each tie's person was mentioned (core-keyrel.js)
    npc.profileEvidence = normalizeProfileEvidence(raw.profileEvidence ?? raw.profile_evidence);
    // Current Thoughts are not durable dossier state; NPC Inner Chatter is ephemeral.
    delete npc.thoughts;
    const relationship = raw.relationship && typeof raw.relationship === 'object' ? raw.relationship : {};
    npc.relationship = normalizeRelationshipBaseline(relationship);
    npc.relationshipProgress = normalizeRelationshipProgress(raw.relationshipProgress ?? raw.relationship_progress);
    // The events counted for the story day (src/relationship-pacing.js); absent until a paced event, dropped when unusable.
    if (!impactDayProblems(raw.impactDay).length) npc.impactDay = structuredClone(raw.impactDay);
    else delete npc.impactDay;
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


// A dossier that matters is archived by the stale pass, never deleted, with no count bound: it holds a portrait image (the main one or
// a form's, in `formIds`), comes from the cast pack, has a relationship meter off the configured starting value, or its id is in
// options.keepIds (Story Director's key people and away list). Stored memories alone do not count.
export function npcMattersForRetention(npc, keepIds = new Set(), formIds = new Set(), baseline = null) {
    const start = normalizeRelationshipBaseline(baseline || {});
    const moved = RELATIONSHIP_KEYS.some(key => Number.isFinite(Number(npc?.relationship?.[key])) && Number(npc.relationship[key]) !== Number(start[key] ?? 0));
    return portraitHasImage(npc?.portrait) || formIds.has(npc?.id) || Boolean(npc?.castFrom && typeof npc.castFrom === 'object') || moved
        || keepIds.has(npc?.id);
}

export function applyStaleNpcLifecycle(state = {}, options = {}) {
    const turn = Math.max(0, Math.round(Number(options.turn ?? state?.turn ?? 0) || 0));
    const archiveAfter = Math.max(1, Math.round(Number(options.archiveAfter) || 30));
    const deleteAfter = Math.max(archiveAfter + 1, Math.round(Number(options.deleteAfter) || 50));
    const protectedIds = new Set((options.protectedIds || []).map(value => String(value || '').trim()).filter(Boolean));
    const keepIds = new Set((options.keepIds || []).map(value => String(value || '').trim()).filter(Boolean));
    const formIds = new Set(Object.entries(state?.formPortraitAssets || {}).filter(([, forms]) => forms && typeof forms === 'object'
        && Object.values(forms).some(portrait => portraitHasImage(portrait))).map(([id]) => String(id)));
    const noDelete = options.noDelete === true; // a hosted read failed: nothing is deleted this round
    const now = Number.isFinite(options.now) ? options.now : null;
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
        const matters = noDelete || npcMattersForRetention(npc, keepIds, formIds, options.baseline);
        if (npc.archived) {
            if (npc.archiveReason === 'stale' && age >= deleteAfter && !matters) {
                removed.push({ id: npc.id, name: npc.name, age, activityTurn, archiveReason: 'stale' });
                removedIds.add(npc.id);
                continue;
            }
            next.npcs.push(npc);
            continue;
        }

        if (age >= deleteAfter && !matters) {
            // On upgrades or very long gaps, a dossier may already be beyond both thresholds.
            // Delete it directly rather than creating a one-scan zombie archive.
            removed.push({ id: npc.id, name: npc.name, age, activityTurn, archiveReason: 'stale' });
            removedIds.add(npc.id);
            continue;
        }
        if (age >= archiveAfter) { // (also a dossier that matters past the delete age: archived, kept)
            npc = setNpcArchived(npc, true, { reason: 'stale', now });
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

export { NPC_ADMISSION_MODES, IMPORTANT_MEMORY_LIMIT, PORTRAIT_SEED_MAX, normalizePortraitSeed, normalizeNpcAdmissionMode, normalizeLifeStateCertainty, CAST_APPEARANCE_WIDE, castAppearanceKept, NPC_CANDIDATE_TTL_TURNS, NPC_CANDIDATE_LIMIT, npcMatchesLabel, normalizeStoredMemories, stripRecordCitations } from './core-record-shared.js';
export { normalizeScanNpc, normalizeNpcCandidate, candidateRecordMatches, makeNpcCandidate, shouldCreateDossierImmediately, shouldPromoteCandidate } from './core-record-scan.js';
export { CUSTOM_FIELD_LIMIT, normalizeCustomFieldNames, normalizeCustomFields, customFieldValues } from './core-record-custom-fields.js';
export { applySheetLevels, sheetLevelOf, withoutSheetLevels } from './core-record-custom-fields.js';
export { PROFILE_UPDATE_TEXT_FIELDS, durableTextAccepted, incomingCustomFields, incomingKeyRelationships, mergeLists, mergeImportantMemories, scanLabelsMatch, candidateMatches } from './core-record-merge.js';
