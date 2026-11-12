/* NPC State Delta incoming-NPC merge: applyIncoming, which folds one scanned NPC into the stored record (identity, text
   refinements, relationships, memories, key relationships, life state). A pure part of core-mechanics.js (same owner, moved
   without change). Never imports core-mechanics.js or core.js. */
import { appendRelationshipEvent, applyRelationshipDelta, applyRelationshipMilestoneCrossings, calibrateRelationshipSummary, DEFAULT_RELATIONSHIP, DEFAULT_RELATIONSHIP_CAPS, DEFAULT_RELATIONSHIP_PROGRESS, DURABLE_PROFILE_LIMITS, durableSeedGrounded, filterRelationshipDeltaByEvidence, normalizeRelationshipBaseline, normalizeRelationshipEventHistory, normalizeRelationshipEvidence, normalizeRelationshipMilestones, normalizeRelationshipProgress, normalizeScannerRelationshipImpact, RELATIONSHIP_KEYS, relationshipEventMessage, relationshipHistoryLooksDuplicate, relationshipSummaryConsistent } from './core-relationship.js';
import { developmentScaleReady } from './core-development.js';
import { cleanText, normalizeName } from './core-text.js';
import { identityLabelsRelated, inferNpcIdentityKind, isInterimNpcLabel } from './core-identity.js';
import { durableTextAccepted, incomingCustomFields, incomingKeyRelationships, mergeImportantMemories, mergeLists } from './core-record.js';
import { TEXT_FIELDS } from './src/fields/registry.js';
import { durableRefinementCandidateGrounded, filterSafeMannerismRefinements, groundedAppearanceChange, groundedAppearanceCorrection, isExplicitRecurringMannerism, isSafeIdentityTextRefinement, isSafeSpeechRefinement, isSafeUnmarkedDurableFieldReplacement, isSafeUnmarkedDurableRefinement, mergeDurableTextRefinement, normalizeMannerisms, presentationContinuationEvidence, speechSeedVetoed, speechSupportContext } from './core-durable.js';
import { groundedBehaviorProfile, mergeBehaviorProfileRefinements, reconcileBehaviorProfileWithPersonality } from './core-behavior.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
import { guessedTraits, physicalTraitSwaps, withoutTraitSwaps } from './appearance-physical.js';
import { groundedTraitEvent } from './core-durable-grounding.js';

export function applyIncoming(existing, incoming, turn, relationshipCaps = DEFAULT_RELATIONSHIP_CAPS, sourceMessageId = null, lifecycleOptions = {}) {
    const merged = { ...existing };
    const manualFields = new Set(Array.isArray(existing.manualProfileFields) ? existing.manualProfileFields : []);
    const directEvolutionReady = (field = '') => {
        // Existing durable identity must not leap merely because a weaker scanner omitted
        // developmentScale. Gradual evolution is evidence-gated through profileUpdates.
        // Runtime Personality/Speech authority is finalized later from role-aware provenance,
        // so this ordinary-delta layer must not pre-apply it.
        const scale = incoming.developmentScale || 'gradual';
        if (scale === 'gradual') return false;
        const authorityProvenanceSupplied = Object.prototype.hasOwnProperty.call(lifecycleOptions, 'userDevelopmentContext');
        if (authorityProvenanceSupplied && (field === 'personality' || field === 'speech')) return false;
        const authoritativeContext = String(authorityProvenanceSupplied
            ? (lifecycleOptions.userDevelopmentContext || '')
            : (lifecycleOptions.developmentContext || '')).trim();
        if (authorityProvenanceSupplied && !authoritativeContext) return false;
        return developmentScaleReady(scale, incoming.developmentReason, authoritativeContext, {
            npc: existing,
            targeted: lifecycleOptions.allowTargetedDurableSeed === true,
            sourceAuthority: authorityProvenanceSupplied ? 'user' : null,
        });
    };
    const existingName = cleanText(existing.name, 120);
    const incomingName = cleanText(incoming.name, 120);
    const incomingAliases = Array.isArray(incoming.aliases) ? incoming.aliases : [];
    const existingKind = inferNpcIdentityKind(existingName, existing.identityKind);
    const incomingKind = inferNpcIdentityKind(incomingName, incoming.identityKind);
    const incomingClaimsOldLabel = incomingAliases.some(alias => normalizeName(alias) === normalizeName(existingName));
    const exactIdContinuity = Boolean(incoming.id && existing.id && String(incoming.id) === String(existing.id));
    const targetedDurableSeedAllowed = lifecycleOptions.allowTargetedDurableSeed === true
        && exactIdContinuity
        && Boolean(String(lifecycleOptions.developmentContext || '').trim());
    const incomingBinding = {
        npc: existing,
        targeted: targetedDurableSeedAllowed,
        otherLabels: lifecycleOptions.otherLabels || [],
        // Used only to veto another roster member's voice sentences for Speech; it does not narrow
        // the narration other fields are grounded in.
        speechOtherLabels: lifecycleOptions.presentationOtherLabels || [],
    };
    const roleContinuity = Boolean(incoming.role && (identityLabelsRelated(existing.role, incoming.role) || identityLabelsRelated(existingName, incoming.role)));
    const interimIdentity = isInterimNpcLabel(existingName, existing.identityKind);
    const canPromoteIdentity = incomingKind === 'proper_name' && interimIdentity
        && (exactIdContinuity || incomingClaimsOldLabel || incoming.sameIndividual || roleContinuity);
    let promotedFromName = '';

    if (incomingName && normalizeName(incomingName) !== normalizeName(existingName)) {
        // A manual lock protects a real established name, but it must not strand a dossier under
        // a placeholder/job title after the story reveals a grounded proper name. The old label is
        // retained as an alias and the existing dossier id/history remains authoritative.
        if (canPromoteIdentity || (!manualFields.has('name') && incomingKind === 'proper_name' && incomingClaimsOldLabel)) {
            merged.name = incomingName;
            merged.identityKind = 'proper_name';
            promotedFromName = existingName;
        }
    }
    if (!merged.name) merged.name = incomingName || existingName || 'Unnamed NPC';
    if (!merged.identityKind) merged.identityKind = inferNpcIdentityKind(merged.name, existingKind);

    const acceptedCustomFields = incomingCustomFields(existing, incoming, manualFields, lifecycleOptions);
    if (acceptedCustomFields) merged.customFields = acceptedCustomFields;
    for (const field of TEXT_FIELDS) {
        let value = incoming[field];
        if (manualFields.has(field)) continue;
        if (field === 'relationshipSummary') continue; // gated after relationship evidence is accepted
        if (typeof value !== 'string' || !value.trim()) continue;
        if ((field === 'role' || field === 'gender' || field === 'homeBase' || field === 'background') && !durableTextAccepted(field, existing, incoming, value, lifecycleOptions)) continue;
        if (['personality', 'speech', 'appearance'].includes(field)
            && !String(existing[field] || '').trim()
            && !targetedDurableSeedAllowed
            && !durableSeedGrounded(value, lifecycleOptions.developmentContext)) {
            continue;
        }
        // A first Speech seed must come from this NPC's own affirmative voice, not another
        // person's sentence or a negated trait elsewhere in the narration.
        if (field === 'speech' && !String(existing.speech || '').trim()
            && String(lifecycleOptions.developmentContext || '').trim()
            && (targetedDurableSeedAllowed
                ? speechSeedVetoed(value, lifecycleOptions.developmentContext, incomingBinding)
                : !durableSeedGrounded(value, speechSupportContext(lifecycleOptions.developmentContext, incomingBinding) || '-'))) {
            continue;
        }
        if (field === 'appearance' && String(existing.appearance || '').trim()) {
            // Unlocked established Appearance can organically REFINE as new durable visual facts
            // become known. A lasting visual change remains stricter and needs a grounded reason.
            // A clearly additive unmarked description is accepted as a recovery path so a manual
            // baseline does not behave like a hidden lock when the scanner forgets the marker.
            const mode = String(incoming.appearanceState || 'keep');
            // (card traits win) Every established trait stays short of a target-specific event.
            const swaps = physicalTraitSwaps(existing.appearance, value, guessedTraits(existing));
            if (mode !== 'change') value = withoutTraitSwaps(existing.appearance, value, guessedTraits(existing)).text;
            if (!value) continue;
            if (mode === 'change') {
                if (swaps.length && !groundedTraitEvent(existing, swaps.map(swap => swap.said).join(' '), incoming.appearanceReason, lifecycleOptions.developmentContext)) continue;
                const directPresentationChange = groundedAppearanceChange(
                    existing.appearance,
                    value,
                    incoming.appearanceReason,
                    lifecycleOptions.developmentContext,
                    presentationContinuationEvidence(lifecycleOptions.developmentContext, existing, lifecycleOptions.presentationOtherLabels),
                    incomingBinding,
                );
                if (!directPresentationChange
                    && (!String(incoming.appearanceReason || '').trim() || !directEvolutionReady('appearance'))) continue;
            } else if (mode !== 'refine' && (!isSafeUnmarkedDurableFieldReplacement('appearance', existing.appearance, value)
                || !durableRefinementCandidateGrounded('appearance', existing.appearance, value, lifecycleOptions.developmentContext, [], incomingBinding))) {
                continue;
            }
            if (mode === 'refine') {
                const directCorrection = groundedAppearanceCorrection(
                    existing.appearance,
                    value,
                    lifecycleOptions.developmentContext,
                    [],
                    incomingBinding,
                );
                if (!directCorrection && (!isSafeUnmarkedDurableRefinement(existing.appearance, value)
                    || !durableRefinementCandidateGrounded('appearance', existing.appearance, value, lifecycleOptions.developmentContext, [], incomingBinding))) continue;
                merged.appearance = mergeDurableTextRefinement(existing.appearance, value, DURABLE_PROFILE_LIMITS.appearance);
                continue;
            }
        }
        if (field === 'personality' && String(existing.personality || '').trim()) {
            // Newly established/clarified stable traits are refinement, not character evolution.
            // Evolution still requires an explicit reason; refinement may enrich a manually entered
            // unlocked baseline, and a clearly additive unmarked result is recovered conservatively.
            const mode = String(incoming.personalityState || 'keep');
            if (mode === 'evolve') {
                if (!String(incoming.personalityReason || '').trim() || !directEvolutionReady('personality')) continue;
            } else if (mode !== 'refine' && (!isSafeUnmarkedDurableFieldReplacement('personality', existing.personality, value)
                || !durableRefinementCandidateGrounded('personality', existing.personality, value, lifecycleOptions.developmentContext, [], incomingBinding))) {
                continue;
            }
            if (mode === 'refine') {
                if (!isSafeIdentityTextRefinement(existing.personality, value, lifecycleOptions.developmentContext, [], incomingBinding)) continue;
                merged.personality = mergeDurableTextRefinement(existing.personality, value, DURABLE_PROFILE_LIMITS.personality);
                continue;
            }
        }
        if (field === 'speech' && String(existing.speech || '').trim()) {
            // Speech may refine as recurring vocabulary, formality, cadence, accent, or verbal
            // habits become established. Enduring register change remains evolution + reason.
            const mode = String(incoming.speechState || 'keep');
            if (mode === 'evolve') {
                if (!String(incoming.speechReason || '').trim() || !directEvolutionReady('speech')) continue;
            } else if (mode !== 'refine' && (!isSafeUnmarkedDurableFieldReplacement('speech', existing.speech, value)
                || !durableRefinementCandidateGrounded('speech', existing.speech, value, lifecycleOptions.developmentContext, [], incomingBinding))) {
                continue;
            }
            if (mode === 'refine') {
                if (!isSafeSpeechRefinement(existing.speech, value, lifecycleOptions.developmentContext, [], incomingBinding)) continue;
                merged.speech = mergeDurableTextRefinement(existing.speech, value, DURABLE_PROFILE_LIMITS.speech);
                continue;
            }
        }
        if ((field === 'age' || field === 'apparentAge') && !durableTextAccepted(field, existing, incoming, value, lifecycleOptions)) continue;
        if (field === 'appearance' && String(existing.appearance || '').trim() && incoming.appearanceState === 'keep') {
            merged.appearance = mergeDurableTextRefinement(existing.appearance, value, DURABLE_PROFILE_LIMITS.appearance);
            continue;
        }
        if (field === 'personality' && String(existing.personality || '').trim() && incoming.personalityState === 'keep') {
            merged.personality = mergeDurableTextRefinement(existing.personality, value, DURABLE_PROFILE_LIMITS.personality);
            continue;
        }
        if (field === 'speech' && String(existing.speech || '').trim() && incoming.speechState === 'keep') {
            merged.speech = mergeDurableTextRefinement(existing.speech, value, DURABLE_PROFILE_LIMITS.speech);
            continue;
        }
        merged[field] = value.trim();
    }
    if (!manualFields.has('goal') && incoming.goalState === 'clear' && !String(incoming.goal || '').trim()) {
        merged.goal = '';
    }
    if (!manualFields.has('status') && incoming.statusState === 'clear' && !String(incoming.status || '').trim()) {
        merged.status = '';
    }
    if (!manualFields.has('mood') && incoming.moodState === 'clear' && !String(incoming.mood || '').trim()) {
        merged.mood = '';
    }
    if (!manualFields.has('location') && incoming.locationState === 'clear' && !String(incoming.location || '').trim()) {
        merged.location = '';
    }
    // Locked aliases (edited by hand) take no scanner additions; a revealed name still keeps the old label.
    merged.aliases = mergeLists([...(existing.aliases || []), ...(promotedFromName ? [promotedFromName] : [])], manualFields.has('aliases') ? [] : incomingAliases, 8)
        .filter(alias => normalizeName(alias) !== normalizeName(merged.name));
    if (normalizeName(incomingName) === normalizeName(merged.name) && incoming.identityKind) {
        merged.identityKind = inferNpcIdentityKind(merged.name, incoming.identityKind);
    }
    merged.memories = manualFields.has('memories')
        ? [...(existing.memories || [])]
        : mergeImportantMemories(existing.memories, incoming.memories, incoming.memoryRetention, lifecycleOptions.memoryInputLimit || 3, existing.manualMemories, { stamps: existing.memoryStamps, message: sourceMessageId });
    if (manualFields.has('mannerisms')) {
        merged.mannerisms = [...(existing.mannerisms || [])];
    } else if ((existing.mannerisms || []).length) {
        // Refinement learns/clarifies durable habits without deleting the established current set.
        // Evolution is reserved for a real long-term habit change and replaces the full set so
        // obsolete tells can retire. Manual locks remain authoritative above.
        if (incoming.mannerismState === 'evolve'
            && String(incoming.mannerismReason || '').trim()
            && directEvolutionReady()
            && incoming.mannerismsProvided) {
            merged.mannerisms = normalizeMannerisms(incoming.mannerisms || []);
        } else if (incoming.mannerismState === 'refine' && incoming.mannerismsProvided) {
            const safe = filterSafeMannerismRefinements(existing.mannerisms, incoming.mannerisms, false, lifecycleOptions.developmentContext);
            // Refine is a full current list. If nothing in the proposed list survives the
            // existing safety gate, preserve the established set instead of clearing it.
            merged.mannerisms = safe.length ? normalizeMannerisms(safe) : [...(existing.mannerisms || [])];
        } else {
            merged.mannerisms = [...(existing.mannerisms || [])];
        }
    } else {
        // A first observed gesture is not yet a mannerism. With source narration available,
        // seed only habits whose recurrence is actually established; structured imports with no
        // narration permit direct structured population.
        const seed = String(lifecycleOptions.developmentContext || '').trim()
            ? (incoming.mannerisms || []).filter(entry => isExplicitRecurringMannerism(entry, lifecycleOptions.developmentContext))
            : (incoming.mannerisms || []);
        merged.mannerisms = normalizeMannerisms(seed);
    }
    if (manualFields.has('behaviorProfile')) {
        merged.behaviorProfile = [...(existing.behaviorProfile || [])];
    } else if ((existing.behaviorProfile || []).length) {
        if (incoming.behaviorProfileState === 'evolve'
            && String(incoming.behaviorProfileReason || '').trim()
            && directEvolutionReady()
            && incoming.behaviorProfileProvided) {
            merged.behaviorProfile = reconcileBehaviorProfileWithPersonality(incoming.behaviorProfile, merged.personality || existing.personality);
        } else if (incoming.behaviorProfileState === 'refine' && incoming.behaviorProfileProvided) {
            merged.behaviorProfile = mergeBehaviorProfileRefinements(existing.behaviorProfile, incoming.behaviorProfile, {
                context: lifecycleOptions.developmentContext,
                personality: merged.personality || existing.personality,
                rejected: incoming.nonLeverBehavior || [],
                evidenceItems: incoming.profileEvidence?.behaviorProfile || [],
                binding: incomingBinding,
            });
        } else {
            merged.behaviorProfile = [...(existing.behaviorProfile || [])];
        }
    } else {
        const grounded = groundedBehaviorProfile(
            incoming.behaviorProfile,
            merged.personality || existing.personality,
            lifecycleOptions.developmentContext,
            incoming.profileEvidence?.behaviorProfile || [],
            incomingBinding,
        );
        merged.behaviorProfile = reconcileBehaviorProfileWithPersonality(grounded, merged.personality || existing.personality);
    }
    merged.keyRelationships = incomingKeyRelationships(existing, incoming, manualFields);
    let relationshipEventAccepted = false;
    let relationshipNarrativeAdvance = false;
    if (!lifecycleOptions.skipRelationshipUpdate) {
        let proposedRelationshipDelta = incoming.relationshipDelta;
        let proposedRelationshipImpact = incoming.relationshipImpact;
        const proposedEvidence = normalizeRelationshipEvidence(incoming.relationshipEvidence);

        if (!incoming.relationshipDeltaProvided && Object.keys(incoming.relationshipAbsolutePatch || {}).length) {
            const currentRelationship = normalizeRelationshipBaseline(existing.relationship || DEFAULT_RELATIONSHIP);
            proposedRelationshipDelta = Object.fromEntries(RELATIONSHIP_KEYS.map(key => {
                if (!Object.prototype.hasOwnProperty.call(incoming.relationshipAbsolutePatch, key)) return [key, 0];
                return [key, incoming.relationshipAbsolutePatch[key] - currentRelationship[key]];
            }));
            const hasRecoveredDelta = RELATIONSHIP_KEYS.some(key => proposedRelationshipDelta[key] !== 0);
            proposedRelationshipImpact = normalizeScannerRelationshipImpact(proposedRelationshipImpact, hasRecoveredDelta);
        }

        const proposedHasDelta = RELATIONSHIP_KEYS.some(key => Number(proposedRelationshipDelta?.[key] || 0) !== 0);
        const duplicateAward = proposedHasDelta && relationshipHistoryLooksDuplicate(
            existing.relationshipEventHistory,
            incoming.relationshipChangeReason,
            { sourceMessageId, turn, evidence: proposedEvidence },
        );
        const reasonPresent = !proposedHasDelta || Boolean(cleanText(incoming.relationshipChangeReason, 500));
        if (proposedHasDelta && (!reasonPresent || duplicateAward)) {
            proposedRelationshipDelta = { trust: 0, affection: 0, desire: 0, tension: 0 };
            proposedRelationshipImpact = 'none';
        } else if (proposedHasDelta) {
            proposedRelationshipDelta = filterRelationshipDeltaByEvidence(
                proposedRelationshipDelta,
                proposedEvidence,
                lifecycleOptions.developmentContext,
            );
            if (!RELATIONSHIP_KEYS.some(key => Number(proposedRelationshipDelta[key] || 0) !== 0)) proposedRelationshipImpact = 'none';
        }
        const relationshipUpdate = applyRelationshipDelta(
            existing.relationship || DEFAULT_RELATIONSHIP,
            proposedRelationshipDelta,
            proposedRelationshipImpact,
            relationshipCaps,
            existing.relationshipProgress || DEFAULT_RELATIONSHIP_PROGRESS,
            existing.relationshipMilestones || [],
        );
        merged.relationship = relationshipUpdate.relationship;
        merged.relationshipProgress = relationshipUpdate.relationshipProgress;
        merged.relationshipMilestones = applyRelationshipMilestoneCrossings(
            existing.relationshipMilestones,
            relationshipUpdate.milestoneCrossings,
            {
                reason: incoming.relationshipChangeReason || '',
                sourceMessageId: Number.isInteger(sourceMessageId) ? sourceMessageId : null,
                turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
            },
        );
        relationshipEventAccepted = relationshipUpdate.evidenceAccepted;
        const relationshipActuallyChanged = RELATIONSHIP_KEYS.some(key => relationshipUpdate.appliedDelta[key] !== 0);
        const relationshipStateAdvanced = relationshipActuallyChanged
            || relationshipUpdate.progressChanged
            || relationshipUpdate.milestoneCrossings.length > 0;
        relationshipNarrativeAdvance = relationshipEventAccepted && (
            relationshipStateAdvanced
            || relationshipUpdate.milestoneBlocks.length === 0
        );
        if (relationshipEventAccepted) {
            const event = {
                impact: relationshipUpdate.impact,
                delta: relationshipUpdate.appliedDelta,
                evidence: proposedEvidence,
                reason: incoming.relationshipChangeReason || '',
                sourceMessageId: Number.isInteger(sourceMessageId) ? sourceMessageId : null,
                turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
                ...relationshipEventMessage({ message: sourceMessageId }),
            };
            merged.relationshipEventHistory = appendRelationshipEvent(existing.relationshipEventHistory, event);
            merged.lastRelationshipChange = relationshipStateAdvanced
                ? event
                : structuredClone(existing.lastRelationshipChange || { impact: 'none', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, evidence: normalizeRelationshipEvidence(), reason: '', sourceMessageId: null });
        } else {
            merged.lastRelationshipChange = structuredClone(existing.lastRelationshipChange || { impact: 'none', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, evidence: normalizeRelationshipEvidence(), reason: '', sourceMessageId: null });
            merged.relationshipEventHistory = normalizeRelationshipEventHistory(existing.relationshipEventHistory);
        }
        if (!relationshipActuallyChanged && relationshipUpdate.progressChanged) merged.updatedAt = Date.now();
    } else {
        merged.relationship = normalizeRelationshipBaseline(existing.relationship || DEFAULT_RELATIONSHIP);
        merged.relationshipProgress = normalizeRelationshipProgress(existing.relationshipProgress);
        merged.relationshipMilestones = normalizeRelationshipMilestones(existing.relationshipMilestones, merged.relationship);
        merged.relationshipEventHistory = normalizeRelationshipEventHistory(existing.relationshipEventHistory);
        merged.lastRelationshipChange = structuredClone(existing.lastRelationshipChange || { impact: 'none', delta: { trust: 0, affection: 0, desire: 0, tension: 0 }, evidence: normalizeRelationshipEvidence(), reason: '', sourceMessageId: null });
    }

    // Relationship prose may initialize an empty field from grounded story evidence, but an
    // established summary only changes when a NEW relationship event actually survives the
    // reason/evidence/dedup gates. Rejected duplicate events cannot advance prose by themselves.
    if (!manualFields.has('relationshipSummary')) {
        const proposedSummary = cleanText(incoming.relationshipSummary, DURABLE_PROFILE_LIMITS.relationshipSummary);
        const mayInitialize = !String(existing.relationshipSummary || '').trim()
            && proposedSummary
            && relationshipSummaryConsistent(proposedSummary, merged.relationship, lifecycleOptions.developmentContext, merged.relationshipMilestones);
        const mayUpdate = relationshipNarrativeAdvance
            && proposedSummary
            && relationshipSummaryConsistent(proposedSummary, merged.relationship, lifecycleOptions.developmentContext, merged.relationshipMilestones);
        if (mayInitialize || mayUpdate) merged.relationshipSummary = calibrateRelationshipSummary(proposedSummary, merged.relationship);
        else merged.relationshipSummary = calibrateRelationshipSummary(existing.relationshipSummary || merged.relationshipSummary, merged.relationship);
    } else {
        merged.relationshipSummary = calibrateRelationshipSummary(existing.relationshipSummary, merged.relationship);
    }
    const autoArchiveDeaths = lifecycleOptions.autoArchiveDeaths !== false;
    const autoReactivateArchived = lifecycleOptions.autoReactivateArchived !== false;
    const confirmedDeath = incoming.lifeState === 'deceased' && incoming.lifeStateCertainty === 'explicit';

    // A confirmed death stays (C05); other life states follow the scan.
    if (incoming.lifeState !== 'unknown' && !isTerminalNpcDeath(existing)) {
        merged.lifeState = incoming.lifeState;
        merged.lifeStateCertainty = incoming.lifeStateCertainty;
        merged.lifeStateReason = incoming.lifeStateReason || merged.lifeStateReason || '';
    }

    if (confirmedDeath && autoArchiveDeaths) {
        merged.archived = true;
        merged.archiveReason = 'deceased';
        merged.archivedAt = Date.now();
        merged.archiveSourceMessageId = Number.isInteger(sourceMessageId) ? sourceMessageId : null;
    } else if (existing.archived && autoReactivateArchived && (incoming.present || incoming.worldActive)) {
        // A manual or stale archive comes back when the NPC is in the scene again. A death archive
        // never does (C05): no scan output revives a confirmed-dead NPC.
        const recoverableReturn = existing.archiveReason === 'manual' || existing.archiveReason === 'stale';
        if (recoverableReturn) {
            merged.archived = false;
            merged.archiveReason = '';
            merged.archivedAt = null;
            merged.archiveSourceMessageId = null;
        }
    }

    merged.present = Boolean(incoming.present) && !merged.archived;
    merged.worldActive = Boolean(incoming.worldActive) && !merged.present && !merged.archived;
    merged.updatedAt = Date.now();
    if (merged.present) {
        merged.lastSeenTurn = turn;
        merged.seenCount = Number(existing.seenCount || 0) + 1;
    }
    if (merged.worldActive) merged.lastWorldActiveTurn = turn;
    // A scanner update must never erase a portrait or user/manual metadata.
    merged.portrait = existing.portrait || null;
    merged.manualProfileFields = [...manualFields];
    return merged;
}
