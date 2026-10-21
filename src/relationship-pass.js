// The focused relationship pass: who in the current exchange needs a relationship decision, the
// isolated evaluator request for them (batches of four), and applying its decisions after the merge.
// (cleanup step 10) Moved out of index.js unchanged; the one host read (the chat's dossiers, for
// matching a returned row by name) is passed in by the caller.
import {
    DEFAULT_RELATIONSHIP,
    appendRelationshipEvent,
    applyRelationshipDelta,
    applyRelationshipMilestoneCrossings,
    buildRelationshipPassPrompt,
    calibrateRelationshipSummary,
    filterRelationshipDeltaByEvidence,
    isTerminalNpcDeath,
    normalizeName,
    normalizeRelationshipEventHistory,
    normalizeRelationshipEvidence,
    normalizeScanNpc,
    npcMatchesLabel,
    relationshipAxisEvidenceGrounded,
    relationshipChangeReasonGrounded,
    relationshipEventMessage,
    relationshipHistoryLooksDuplicate,
    relationshipSummaryConsistent,
    stampChangedFields,
} from '../core.js';
import { isScannerRoutingError } from '../scanner-routing.js';
import { RELATIONSHIP_RESPONSE_LENGTH, generateParsedNpcJson } from './scanner-request.js';

export function transcriptMentionsNpcRecord(transcript, npc) {
    const haystack = ` ${normalizeName(transcript)} `;
    if (!haystack.trim() || !npc) return false;
    const labels = [npc.name, ...(npc.aliases || [])]
        .map(normalizeName)
        .filter(label => label.length >= 2);
    return labels.some(label => haystack.includes(` ${label} `));
}

export function currentExchangeRelationshipRelevant(npc, transcript, raw = null, { currentExchangeOnly = false } = {}) {
    if (!npc || npc.archived) return false;
    // Full-window reconciliation must never turn historical presence or a previous live flag
    // into a fresh relationship event. Only an explicit name/alias participation cue in the
    // current exchange can make an omitted existing dossier a relationship target. Quick scans
    // already operate on the current exchange, so their returned row remains sufficient.
    if (transcriptMentionsNpcRecord(transcript, npc)) return true;
    if (currentExchangeOnly) return false;
    return Boolean(raw);
}

export function rawScanMatchesExisting(raw, npc) {
    if (!raw || !npc) return false;
    if (raw.id && String(raw.id) === String(npc.id)) return true;
    if (raw.name && npcMatchesLabel(npc, raw.name)) return true;
    return Array.isArray(raw.aliases) && raw.aliases.some(alias => npcMatchesLabel(npc, alias));
}

export function hasCompletePrimaryRelationshipDecision(raw, transcript = '') {
    if (!raw || typeof raw !== 'object') return false;
    const delta = raw.relationshipDelta ?? raw.relationship_delta;
    const hasFullDelta = delta && typeof delta === 'object'
        && ['trust', 'affection', 'desire', 'tension'].every(key => Number.isFinite(Number(delta[key])));
    if (!hasFullDelta) return false;
    const rawImpact = String(raw.relationshipImpact ?? raw.impactLevel ?? raw.relationshipImpactLevel ?? '').trim().toLowerCase();
    if (!['none', 'ordinary', 'meaningful', 'major', 'extreme'].includes(rawImpact)) return false;
    const hasNonZero = ['trust', 'affection', 'desire', 'tension'].some(key => Number(delta[key]) !== 0);
    if (hasNonZero && rawImpact === 'none') return false;
    if (!hasNonZero && rawImpact !== 'none') return false;
    if (hasNonZero) {
        const reason = String(raw.relationshipChangeReason ?? raw.relationship_change_reason ?? raw.relationshipReason ?? '').trim();
        if (!reason) return false;
        const evidenceSource = raw.relationshipEvidence ?? raw.relationship_evidence;
        if (!evidenceSource || typeof evidenceSource !== 'object') return false;
        const evidence = normalizeRelationshipEvidence(evidenceSource);
        for (const key of ['trust', 'affection', 'desire', 'tension']) {
            if (Number(delta[key]) !== 0 && !relationshipAxisEvidenceGrounded(key, evidence[key], transcript)) return false;
        }
    }
    if (hasNonZero && ['major', 'extreme'].includes(rawImpact)) {
        const summary = raw.relationshipSummary ?? raw.relationship_summary;
        if (typeof summary !== 'string' || !summary.trim()) return false;
    }
    return true;
}

export async function runFocusedRelationshipPass(ctx, parsed, existingNpcs, transcript, settings, options = {}) {
    const returned = Array.isArray(parsed?.npcs) ? parsed.npcs : [];
    // (1.2.12) `prose`: the exchange's story alone. Who takes part is who it names (a name only in
    // the World State's lists, Off-Screen above all, is no part in the scene), and it is what the
    // evaluator reads; evidence is still checked against the whole exchange.
    const prose = String(options.prose ?? '').trim();
    const named = prose || transcript;
    // (1.2.12) A one-pass block's own word: `covered` (its rows hold everyone whose feelings could
    // have changed) settles anyone it left out; `review` names whom it wants checked anyway.
    const review = Array.isArray(options.review) ? options.review.map(name => String(name ?? '').trim()).filter(Boolean).slice(0, 8) : [];
    // Relationship reconciliation is keyed to the CURRENT exchange, not to whether the broad
    // dossier scanner happened to return a row. This prevents an NPC who acts early in a long
    // response from being skipped merely because the response ends with another cast/location.
    const targets = (Array.isArray(existingNpcs) ? existingNpcs : [])
        .filter(npc => !npc?.archived && !isTerminalNpcDeath(npc))
        .filter(npc => {
            if (review.some(name => npcMatchesLabel(npc, name))) return true;
            const raw = returned.find(item => rawScanMatchesExisting(item, npc));
            if (!currentExchangeRelationshipRelevant(npc, named, raw, options)) return false;
            if (raw) return !hasCompletePrimaryRelationshipDecision(raw, transcript);
            return options.covered !== true;
        });
    if (!targets.length) return { decisions: new Map(), used: false, responseChars: 0, retried: false, targetCount: 0 };

    const decisions = new Map();
    let responseChars = 0;
    let retried = false;
    let failed = false;
    for (let offset = 0; offset < targets.length; offset += 4) {
        const batch = targets.slice(offset, offset + 4);
        try {
            const relationshipPrompt = buildRelationshipPassPrompt({
                transcript: prose || transcript,
                targets: batch,
                userName: ctx.name1 || 'User',
                relationshipCriteria: settings.relationshipCriteria,
                impactCriteria: settings.relationshipImpactCriteria,
                relationshipCaps: settings.relationshipCaps,
            });
            const { parsed: relationshipParsed, raw, retried: batchRetried } = await generateParsedNpcJson(ctx, {
                systemPrompt: "You are NPC State Delta's isolated relationship evaluator. Use only the supplied targets and current exchange. Return only the requested JSON object.",
                prompt: relationshipPrompt,
                responseLength: RELATIONSHIP_RESPONSE_LENGTH,
                label: `relationship pass ${Math.floor(offset / 4) + 1}`,
                requestScope: options.requestScope,
            });
            responseChars += String(raw ?? '').length;
            retried ||= Boolean(batchRetried);
            for (const target of batch) {
                const rawDecision = (relationshipParsed.npcs || []).find(item => String(item?.id || '') === String(target.id) || (item?.name && npcMatchesLabel(target, item.name)));
                if (!rawDecision) continue;
                const deltaSource = rawDecision.relationshipDelta ?? rawDecision.relationship_delta;
                const hasFullDelta = deltaSource && typeof deltaSource === 'object'
                    && ['trust', 'affection', 'desire', 'tension'].every(key => Number.isFinite(Number(deltaSource[key])));
                if (!hasFullDelta) continue;
                const normalized = normalizeScanNpc(rawDecision);
                const requestedHasDelta = Object.values(normalized.relationshipDelta).some(value => value !== 0);
                const reasonPresent = Boolean(String(normalized.relationshipChangeReason || '').trim());
                const relationshipDelta = requestedHasDelta && reasonPresent
                    ? filterRelationshipDeltaByEvidence(normalized.relationshipDelta, normalized.relationshipEvidence, transcript)
                    : { trust: 0, affection: 0, desire: 0, tension: 0 };
                const hasNonZeroNormalizedDelta = Object.values(relationshipDelta).some(value => value !== 0);
                const relationshipImpact = hasNonZeroNormalizedDelta ? normalized.relationshipImpact : 'none';
                const rawSummary = rawDecision.relationshipSummary ?? rawDecision.relationship_summary;
                const explicitSummaryProvided = typeof rawSummary === 'string';
                const explicitSummary = explicitSummaryProvided ? String(rawSummary).trim().slice(0, 700) : '';
                const hasNonZeroDelta = Object.values(relationshipDelta).some(value => value !== 0);
                const needsTurningPointSummary = hasNonZeroDelta && ['major', 'extreme'].includes(relationshipImpact);
                const fallbackSummary = needsTurningPointSummary && !explicitSummary && normalized.relationshipChangeReason
                    ? `${target.name || 'This NPC'}'s relationship with the player changed ${normalized.relationshipImpact === 'extreme' ? 'fundamentally' : 'substantially'}: ${normalized.relationshipChangeReason}`.slice(0, 700)
                    : '';
                const relationshipSummary = explicitSummary || fallbackSummary;
                const relationshipSummaryDecisionProvided = explicitSummaryProvided || Boolean(fallbackSummary);
                decisions.set(target.id, {
                    relationshipDelta,
                    relationshipImpact,
                    relationshipEvidence: normalized.relationshipEvidence,
                    relationshipChangeReason: normalized.relationshipChangeReason,
                    relationshipSummary,
                    relationshipSummaryDecisionProvided,
                    context: transcript,
                });
            }
            const missing = batch.filter(target => !decisions.has(target.id));
            if (missing.length) {
                console.warn('[NPC State Delta] focused relationship pass omitted or malformed one or more target decisions.', {
                    targets: batch.map(npc => npc.id),
                    decided: batch.filter(npc => decisions.has(npc.id)).map(npc => npc.id),
                });
            }
        } catch (error) {
            if (isScannerRoutingError(error)) throw error;
            failed = true;
            console.warn('[NPC State Delta] focused relationship batch failed; retaining safe zero/primary output for that batch.', error);
        }
    }
    return { decisions, used: true, responseChars, retried, targetCount: targets.length, failed };
}

export function suppressPrimaryRelationshipForFocusedDecisions(parsed, decisions, stateNpcs = () => []) {
    if (!decisions?.size) return parsed;
    const clone = structuredClone(parsed || { npcs: [] });
    for (const raw of clone.npcs || []) {
        const matchedId = [...decisions.keys()].find(id => {
            if (String(raw?.id || '') === String(id)) return true;
            const stateNpc = stateNpcs().find(npc => npc.id === id);
            return Boolean(stateNpc && raw?.name && npcMatchesLabel(stateNpc, raw.name));
        });
        if (!matchedId) continue;
        delete raw.relationship;
        delete raw.relationship_delta;
        if (decisions.get(matchedId)?.relationshipSummaryDecisionProvided) {
            delete raw.relationshipSummary;
            delete raw.relationship_summary;
        }
        raw.relationshipImpact = 'none';
        raw.relationshipDelta = { trust: 0, affection: 0, desire: 0, tension: 0 };
        raw.relationshipEvidence = { trust: '', affection: '', desire: '', tension: '' };
        raw.relationshipChangeReason = '';
    }
    return clone;
}

// Copies the "changed at" stamps for whatever differs between `before` and the record (`npc`) onto it.
export function stampNpcChanges(npc, before, { turn, message = null, storyDay = null } = {}) {
    const stamped = stampChangedFields(before, npc, { turn, message, storyDay });
    for (const key of ['fieldChanges', 'fieldChangeDays', 'fieldChangeMessages']) {
        if (stamped[key] === undefined) delete npc[key];
        else npc[key] = stamped[key];
    }
    return npc;
}

export function applyFocusedRelationshipDecisions(state, decisions, caps, sourceMessageId, report = null) {
    if (!decisions?.size) return state;
    for (const [id, decision] of decisions) {
        const npc = state.npcs.find(item => item.id === id);
        if (!npc || isTerminalNpcDeath(npc)) continue;
        // (cleanup step 9) The pass runs after the merge stamped its changes: it stamps its own.
        const before = structuredClone(npc);
        const requestedHasDelta = Object.values(decision.relationshipDelta || {}).some(value => Number(value) !== 0);
        const evidence = normalizeRelationshipEvidence(decision.relationshipEvidence);
        const duplicateAward = requestedHasDelta && relationshipHistoryLooksDuplicate(npc.relationshipEventHistory, decision.relationshipChangeReason, {
            sourceMessageId,
            turn: state.turn,
            evidence,
        });
        const validReason = !requestedHasDelta || (relationshipChangeReasonGrounded(decision.relationshipChangeReason, '') && !duplicateAward);
        const update = applyRelationshipDelta(
            npc.relationship || DEFAULT_RELATIONSHIP,
            validReason ? decision.relationshipDelta : { trust: 0, affection: 0, desire: 0, tension: 0 },
            validReason ? decision.relationshipImpact : 'none',
            caps,
            npc.relationshipProgress,
            npc.relationshipMilestones,
        );
        npc.relationship = update.relationship;
        npc.relationshipProgress = update.relationshipProgress;
        npc.relationshipMilestones = applyRelationshipMilestoneCrossings(
            npc.relationshipMilestones,
            update.milestoneCrossings,
            {
                reason: decision.relationshipChangeReason || '',
                sourceMessageId: Number.isInteger(sourceMessageId) ? sourceMessageId : null,
                turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
            },
        );
        const eventAccepted = Boolean(validReason && update.evidenceAccepted);
        const relationshipActuallyChanged = Object.values(update.appliedDelta || {}).some(value => Number(value) !== 0);
        const relationshipStateAdvanced = relationshipActuallyChanged
            || update.progressChanged
            || update.milestoneCrossings.length > 0;
        const narrativeAdvance = eventAccepted && (
            relationshipStateAdvanced
            || update.milestoneBlocks.length === 0
        );
        let summaryChanged = false;
        const mayInitializeSummary = !String(npc.relationshipSummary || '').trim() && !requestedHasDelta;
        if ((narrativeAdvance || mayInitializeSummary)
            && decision.relationshipSummaryDecisionProvided
            && !(Array.isArray(npc.manualProfileFields) && npc.manualProfileFields.includes('relationshipSummary'))) {
            const proposedSummary = String(decision.relationshipSummary || '').trim().slice(0, 700);
            if (relationshipSummaryConsistent(proposedSummary, npc.relationship, decision.context || '', npc.relationshipMilestones)) {
                const calibrated = calibrateRelationshipSummary(proposedSummary, npc.relationship);
                if (calibrated && calibrated !== String(npc.relationshipSummary || '').trim()) {
                    npc.relationshipSummary = calibrated;
                    summaryChanged = true;
                }
            }
        }
        if (eventAccepted) {
            const event = {
                impact: update.impact,
                delta: update.appliedDelta,
                evidence,
                reason: decision.relationshipChangeReason || '',
                sourceMessageId: Number.isInteger(sourceMessageId) ? sourceMessageId : null,
                turn: Number.isFinite(Number(state.turn)) ? Number(state.turn) : null,
                ...relationshipEventMessage({ message: sourceMessageId }),
            };
            npc.relationshipEventHistory = appendRelationshipEvent(npc.relationshipEventHistory, event);
            if (relationshipStateAdvanced) npc.lastRelationshipChange = event;
        } else {
            npc.relationshipEventHistory = normalizeRelationshipEventHistory(npc.relationshipEventHistory);
        }
        if (eventAccepted || update.progressChanged || summaryChanged) {
            npc.updatedAt = Date.now();
            if (report?.updated && !report.updated.includes(id)) report.updated.push(id);
        }
        stampNpcChanges(npc, before, { turn: state.turn, message: Number.isInteger(sourceMessageId) ? sourceMessageId : null });
    }
    return state;
}
