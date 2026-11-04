


import { normalizeName, cleanText, cleanList } from './core-text.js';

export { normalizeName, hasCompactMeguminWorldState, stripUiNoise, storyProse, extractNarrationCapture, parseNarrationCapture, parseScanJson } from './core-text.js';
export { NPC_LIFE_STATES, normalizeLifeState, clamp, normalizeGender, inferNpcIdentityKind, isRoleDescriptionLabel, normalizeDossierSignal, slugify, makeNpcId, normalizeAge, normalizeApparentAge } from './core-identity.js';

export { DEFAULT_PORTRAIT_STYLE_POSITIVE, DEFAULT_PORTRAIT_STYLE_NEGATIVE, DEFAULT_PORTRAIT_COMPOSITION, PORTRAIT_STYLE_PROMPT_LIMIT, PORTRAIT_COMPOSITION_PROMPT_LIMIT, PORTRAIT_NPC_PROMPT_LIMIT, PORTRAIT_PROMPT_FORMATS, normalizePortraitPromptFormat, buildNpcPortraitPrompts } from './core-portrait.js';
import { DEFAULT_RELATIONSHIP } from './core-relationship.js';
export { DURABLE_PROFILE_LIMITS, DEFAULT_RELATIONSHIP, RELATIONSHIP_KEYS, RELATIONSHIP_IMPACT_LEVELS, DEFAULT_RELATIONSHIP_CAPS, RELATIONSHIP_EVENT_HISTORY_LIMIT, DEFAULT_RELATIONSHIP_PROGRESS, RELATIONSHIP_MILESTONE_THRESHOLDS, RELATIONSHIP_MILESTONE_REQUIREMENTS, RELATIONSHIP_MILESTONE_MIN_RAW, RELATIONSHIP_MILESTONE_LIMIT, normalizeRelationshipBaseline, normalizeRelationshipCaps, normalizeRelationshipProgress, normalizeRelationshipMilestones, relationshipMilestoneUnlocked, inferManualRelationshipMilestones, applyRelationshipMilestoneCrossings, applyRelationshipDelta, normalizeRelationshipEvidence, relationshipAxisEvidenceGrounded, filterRelationshipDeltaByEvidence, relationshipEventMessage, normalizeRelationshipEventHistory, relationshipChangeLooksDuplicate, relationshipHistoryLooksDuplicate, appendRelationshipEvent, relationshipChangeReasonGrounded, relationshipSummaryConsistent, calibrateRelationshipSummary, durableRefinementTokens, durableSeedGrounded, durableSemanticSimilarity } from './core-relationship.js';
export { DEFAULT_RELATIONSHIP_CRITERIA, DEFAULT_IMPACT_CRITERIA, DEFAULT_MEMORY_CRITERIA, DEFAULT_BEHAVIOR_CRITERIA, prepareFullWindowRelationshipPayload, PROMPT_NAME_MAX, flatPromptName, buildRelationshipPassPrompt, scenePresentFocus, withScenePresent, selectScannerContextNpcs, PROMPT_CAPS, returnShape, buildBackfillPrompt, buildDossierImportPrompt, STALE_PROFILE_TURNS, STALE_PROFILE_DAYS, buildProfileRefreshPrompt, NARRATION_CAPTURE_REMINDER, hiddenNotePromptRules, hiddenNoteEventParagraph, appendHiddenNotePrompt, buildScannerPrompt } from './core-prompts.js';
export { buildBehaviorGuidance, scoreNpcRelevance, selectRelevantNpcs, DEFAULT_INJECTION_BUDGET_TOKENS, MIN_INJECTION_BUDGET_TOKENS, MAX_INJECTION_BUDGET_TOKENS, normalizeInjectionBudgetTokens, estimateInjectionTokens, buildInjection } from './core-injection.js';


export { identityMoralityConflict, speechSeedVetoed, speechSupportContext, durableRefinementCandidateGrounded, groundedAppearanceCorrection, npcScopedNarration, isSafeUnmarkedDurableRefinement, isSafeUnmarkedDurableReplacement } from './core-durable.js';
export { BEHAVIOR_PROFILE_LIMIT, isBehaviorLever, durableProfileCollectionEquivalent, durableProfileCollectionCandidateGrounded } from './core-behavior.js';
export { PROFILE_EVIDENCE_LIMIT, durableProfileEvidenceRelated, durableProfileEvolutionCandidateGrounded, durableProfileCandidateSupport, durableProfileAggregateCandidateGrounded, durableEvidenceContradicts, durableProfileEvidenceAlreadyRepresented, durableProfileEvidenceReason, tagScanEvidence } from './core-evidence.js';
export { KEY_RELATIONSHIP_LIMIT, normalizeKeyRelationshipEdges, extractExplicitKeyRelationshipEdges } from './core-keyrel.js';
import { setNpcArchived, npcMatchesLabel, candidateRecordMatches, createNpcRecord } from './core-record.js';

export { NPC_ADMISSION_MODES, IMPORTANT_MEMORY_LIMIT, PORTRAIT_SEED_MAX, normalizePortraitSeed, normalizeNpcAdmissionMode, setNpcArchived, NPC_CANDIDATE_TTL_TURNS, NPC_CANDIDATE_LIMIT, npcMatchesLabel, normalizeScanNpc, normalizeNpcCandidate, CUSTOM_FIELD_LIMIT, normalizeCustomFieldNames, normalizeCustomFields, customFieldValues, normalizeNpcRecord, createNpcRecord, applyStaleNpcLifecycle } from './core-record.js';
export { developmentEpisodeDiagnostic, developmentEpisodeEvidence, developmentScaleReady, resolveInterimIdentityPromotions } from './core-development.js';
export { applyScenePresence, mergeScanResult, npcNamedInText } from './core-merge.js';


// A scan row or profile update is about this NPC: the same id, its name, or one of its aliases.
export function scanRowMatchesNpc(raw = {}, npc = {}) {
    if (raw?.id && String(raw.id) === String(npc?.id)) return true;
    if (raw?.name && npcMatchesLabel(npc, raw.name)) return true;
    return Array.isArray(raw?.aliases) && raw.aliases.some(alias => npcMatchesLabel(npc, alias));
}

// The records in `source` that are this NPC (by id, or a name or alias matching either way).
export function matchingNpcRecords(npc, source = []) {
    return (Array.isArray(source) ? source : []).filter(item => item && (
        String(item.id || '') === String(npc?.id || '')
        || (npc?.name && npcMatchesLabel(item, npc.name))
        || (item?.name && npcMatchesLabel(npc, item.name))
        || (item?.aliases || []).some(alias => npcMatchesLabel(npc, alias))
    ));
}

// Structured manual add/remove helper shared by the settings UI. Story text is never parsed here.
export function applyNpcStateCommand(state, command, options = {}) {
    const next = {
        ...(state || {}),
        npcs: Array.isArray(state?.npcs) ? state.npcs.map(n => ({ ...n, aliases: [...(n.aliases || [])] })) : [],
        candidates: Array.isArray(state?.candidates) ? state.candidates.map(c => ({ ...c, aliases: [...(c.aliases || [])] })) : [],
        dismissed: Array.isArray(state?.dismissed) ? [...state.dismissed] : [],
    };
    const action = command?.action === 'remove' ? 'remove' : command?.action === 'add' ? 'add' : '';
    const name = cleanText(command?.name, 120);
    const key = normalizeName(name);
    const report = { action, name, status: 'ignored', npcId: null };
    if (!action || !key) return { state: next, report };

    const excluded = new Set((options.excludeNames || []).map(normalizeName).filter(Boolean));
    const maxNpcs = Math.max(1, Math.min(100, Number(options.maxNpcs) || 40));
    const turn = Number(options.turn ?? state?.turn ?? 0);
    const targetNpcId = cleanText(command?.npcId, 160);
    const existingIndex = targetNpcId
        ? next.npcs.findIndex(npc => String(npc?.id || '') === targetNpcId)
        : next.npcs.findIndex(npc => npcMatchesLabel(npc, name));

    if (action === 'remove') {
        const labels = new Set([key]);
        if (existingIndex >= 0) {
            const npc = next.npcs[existingIndex];
            for (const label of [npc.name, ...(npc.aliases || [])]) {
                const normalized = normalizeName(label);
                if (normalized) labels.add(normalized);
            }
            report.npcId = npc.id;
            report.name = npc.name;
            report.status = 'removed';
            next.npcs.splice(existingIndex, 1);
        } else {
            report.status = 'suppressed';
        }
        next.candidates = next.candidates.filter(candidate => !candidateRecordMatches(candidate, { name, aliases: [] }));
        next.dismissed = [...new Set([...next.dismissed.map(normalizeName).filter(Boolean), ...labels])];
        return { state: next, report };
    }

    if (excluded.has(key)) {
        report.status = 'excluded';
        return { state: next, report };
    }
    next.dismissed = next.dismissed.filter(label => normalizeName(label) !== key);
    const promotedCandidate = next.candidates.find(candidate => candidateRecordMatches(candidate, { name, aliases: [] })) || null;
    next.candidates = next.candidates.filter(candidate => !candidateRecordMatches(candidate, { name, aliases: [] }));
    if (existingIndex >= 0) {
        let npc = next.npcs[existingIndex];
        const wasArchived = Boolean(npc.archived);
        if (wasArchived) {
            npc = setNpcArchived(npc, false);
            next.npcs[existingIndex] = npc;
        }
        if (promotedCandidate) {
            npc.aliases = cleanList([...(npc.aliases || []), promotedCandidate.name, ...(promotedCandidate.aliases || [])], 8, 120)
                .filter(alias => normalizeName(alias) !== normalizeName(npc.name));
            if (!npc.role && promotedCandidate.role) npc.role = promotedCandidate.role;
            if (!npc.location && promotedCandidate.location) npc.location = promotedCandidate.location;
        }
        npc.lastSeenTurn = Math.max(Number(npc.lastSeenTurn || 0), turn);
        npc.updatedAt = Date.now();
        report.npcId = npc.id;
        report.name = npc.name;
        report.status = wasArchived ? 'restored' : 'exists';
        return { state: next, report };
    }
    if (next.npcs.filter(npc => !npc?.archived).length >= maxNpcs) {
        report.status = 'full';
        return { state: next, report };
    }
    const record = createNpcRecord(name, next.npcs.map(n => n.id), options.relationshipBaseline || DEFAULT_RELATIONSHIP);
    if (promotedCandidate) {
        record.aliases = cleanList([promotedCandidate.name, ...(promotedCandidate.aliases || [])], 8, 120)
            .filter(alias => normalizeName(alias) !== normalizeName(record.name));
        record.role = promotedCandidate.role || '';
        record.location = promotedCandidate.location || '';
    }
    record.lastSeenTurn = turn;
    next.npcs.push(record);
    report.npcId = record.id;
    report.name = record.name;
    report.status = 'added';
    return { state: next, report };
}
