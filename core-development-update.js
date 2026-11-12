/* NPC State Delta durable profile update: profile-update evidence normalization and the single-NPC
   applyDurableProfileUpdate rules for text fields, personality, speech, appearance, mannerisms,
   behavior profile, extra durable facts and memories. Split from core-development.js as a line-for-line
   part; the original keeps the public exports. */

import { durableProfileEvidenceReason, gradualProfileEvolutionReady, mergeProfileEvidence, mergeRecentProfileEvidence, normalizeProfileEvidence, profileEvidenceCount, unresolvedCollectionEvidence, unresolvedProfileEvidence } from './core-evidence.js';
import { cleanText, normalizeName } from './core-text.js';
import { DURABLE_PROFILE_LIMITS, durableEvidenceGroundsValue, durableSeedGrounded } from './core-relationship.js';
import { durableRefinementCandidateGrounded, filterSafeMannerismRefinements, groundedAppearanceChange, groundedAppearanceCorrection, identityMoralityConflict, isExplicitRecurringMannerism, isSafeIdentityTextRefinement, isSafeSpeechRefinement, isSafeUnmarkedDurableFieldReplacement, isSafeUnmarkedDurableRefinement, mergeDurableTextRefinement, normalizeMannerisms, presentationContinuationEvidence, speechSupportContext } from './core-durable.js';
import { durableTextAccepted, incomingCustomFields, incomingKeyRelationships, mergeImportantMemories, normalizeScanNpc, PROFILE_UPDATE_TEXT_FIELDS } from './core-record.js';
import { PROFILE_EVIDENCE_FIELDS } from './src/fields/registry.js';
import { durableProfileCollectionCandidateGrounded, durableProfileCollectionEquivalent, groundedBehaviorProfile, mergeBehaviorProfileRefinements, normalizeBehaviorProfile, reconcileBehaviorProfileWithPersonality, recoverBehaviorProfileKeepAdditions } from './core-behavior.js';
import { developmentScaleReady } from './core-development-episode.js';
import { cardLook, withoutTraitSwaps } from './appearance-physical.js';

function normalizeProfileUpdateEvidence(raw = {}) {
    return normalizeProfileEvidence(raw.evidence ?? raw.profileEvidence ?? raw.profile_evidence ?? raw.observations ?? {});
}

export function applyDurableProfileUpdate(npc, raw = {}, options = {}) {
    const incoming = normalizeScanNpc(raw);
    const manualFields = new Set(Array.isArray(npc.manualProfileFields) ? npc.manualProfileFields : []);
    const beforeEvidence = normalizeProfileEvidence(npc.profileEvidence);
    const incomingEvidence = normalizeProfileUpdateEvidence(raw);
    if (incoming.nonLeverBehavior?.length) {
        incomingEvidence.mannerisms = mergeRecentProfileEvidence(incomingEvidence.mannerisms, incoming.nonLeverBehavior);
    }
    let evidence = mergeProfileEvidence(beforeEvidence, Object.fromEntries(PROFILE_EVIDENCE_FIELDS.map(field => [
        field, manualFields.has(field) ? [] : incomingEvidence[field],
    ])));
    let changed = false;

    const evolutionReady = (field, { allowObservationCount = true } = {}) => {
        const scale = incoming.developmentScale || 'gradual';
        const authorityProvenanceSupplied = Object.prototype.hasOwnProperty.call(options, 'userDevelopmentContext');
        if (authorityProvenanceSupplied && (field === 'personality' || field === 'speech')) return false;
        const fieldReason = field === 'mannerisms' ? incoming.mannerismReason
            : field === 'behaviorProfile' ? incoming.behaviorProfileReason
                : field === 'personality' ? incoming.personalityReason
                    : field === 'speech' ? incoming.speechReason : '';
        const currentValue = field === 'mannerisms' || field === 'behaviorProfile' ? npc[field] || [] : npc[field] || '';
        const candidateValue = field === 'mannerisms' || field === 'behaviorProfile' ? incoming[field] || [] : incoming[field] || '';
        const evidenceReason = durableProfileEvidenceReason(field, currentValue, candidateValue, incomingEvidence[field] || []);
        const effectiveReason = cleanText(incoming.developmentReason || fieldReason || evidenceReason, 500);
        const authoritativeContext = String(authorityProvenanceSupplied
            ? (options.userDevelopmentContext || '')
            : (options.developmentContext || '')).trim();
        const binding = {
            npc,
            evidence: incomingEvidence[field] || [],
            targeted: options.targeted === true,
            sourceAuthority: authorityProvenanceSupplied ? 'user' : null,
        };
        const candidateSpecificGrounding = field === 'mannerisms' || field === 'behaviorProfile'
            ? durableProfileCollectionCandidateGrounded(field, currentValue, candidateValue, incomingEvidence[field] || [])
            : true;
        if (scale === 'gradual') {
            return (allowObservationCount && gradualProfileEvolutionReady(field, beforeEvidence, incomingEvidence))
                || (authoritativeContext && effectiveReason && candidateSpecificGrounding
                    && developmentScaleReady('batch', effectiveReason, authoritativeContext, binding));
        }
        return (!authorityProvenanceSupplied || Boolean(authoritativeContext))
            && Boolean(effectiveReason) && candidateSpecificGrounding
            && developmentScaleReady(scale, effectiveReason, authoritativeContext, binding);
    };

    const applyText = (field, stateField, reasonField, refineState, evolveState, maxChars) => {
        if (manualFields.has(field)) return;
        let value = cleanText(incoming[field], maxChars);
        if (!value) return;
        const current = cleanText(npc[field], maxChars);
        const state = String(incoming[stateField] || 'keep');
        if (!current) {
            const repeatedEvidence = gradualProfileEvolutionReady(field, beforeEvidence, incomingEvidence)
                && durableEvidenceGroundsValue(value, [...(beforeEvidence[field] || []), ...(incomingEvidence[field] || [])]);
            // A first Speech seed must rest on this NPC's own affirmative voice in the narration.
            const seedContext = field === 'speech' && String(options.developmentContext || '').trim()
                ? (speechSupportContext(options.developmentContext, { npc, otherLabels: options.otherLabels || [] }) || '-')
                : options.developmentContext;
            const seedReady = durableSeedGrounded(value, seedContext) || repeatedEvidence;
            if (!seedReady) {
                evidence[field] = mergeRecentProfileEvidence(evidence[field], incomingEvidence[field] || [], field);
                return;
            }
            npc[field] = value;
            evidence[field] = [];
            changed = true;
            return;
        }
        const fieldEvidence = [...(beforeEvidence[field] || []), ...(incomingEvidence[field] || [])];
        const binding = {
            npc,
            evidence: fieldEvidence,
            targeted: options.targeted === true,
            otherLabels: options.otherLabels || [],
        };
        if (state === evolveState) {
            if (!String(incoming[reasonField] || '').trim()) return;
            const directAppearanceChange = field === 'appearance' && groundedAppearanceChange(
                current,
                value,
                incoming[reasonField],
                options.developmentContext,
                [...fieldEvidence, ...presentationContinuationEvidence(options.developmentContext, npc, options.otherLabels)],
                binding,
            );
            if (!directAppearanceChange && !evolutionReady(field)) return;
            // A count of observations with an evolve label may develop Personality, but a protected
            // morality reversal (kind -> cruel) needs grounded story authority, not the label alone.
            if (field === 'personality' && identityMoralityConflict(current, value)
                && !evolutionReady(field, { allowObservationCount: false })) return;
            if (normalizeName(current) !== normalizeName(value)) { npc[field] = value; changed = true; }
            evidence[field] = [];
            return;
        }
        // (card traits win) Short of the grounded change above, an Appearance refine keeps the held value of a trait the card names.
        if (field === 'appearance') value = withoutTraitSwaps(current, value, cardLook(npc)).text;
        if (!value) return;
        const safeRefinement = field === 'personality'
            ? isSafeIdentityTextRefinement(current, value, options.developmentContext, fieldEvidence, binding)
            : (field === 'speech'
                ? isSafeSpeechRefinement(current, value, options.developmentContext, fieldEvidence, binding)
                : (groundedAppearanceCorrection(current, value, options.developmentContext, fieldEvidence, binding)
                    || (isSafeUnmarkedDurableRefinement(current, value)
                        && durableRefinementCandidateGrounded(field, current, value, options.developmentContext, fieldEvidence, binding))));
        const explicitRefinement = state === refineState && safeRefinement;
        const unmarkedRecovery = state !== refineState && state !== evolveState
            && isSafeUnmarkedDurableFieldReplacement(field, current, value)
            && durableRefinementCandidateGrounded(field, current, value, options.developmentContext, fieldEvidence, binding);
        if (explicitRefinement || unmarkedRecovery) {
            const merged = mergeDurableTextRefinement(current, value, maxChars);
            if (normalizeName(merged) !== normalizeName(current)) { npc[field] = merged; changed = true; }
            evidence[field] = unresolvedProfileEvidence(field, merged, beforeEvidence[field] || [], incomingEvidence[field] || []);
        }
    };

    applyText('personality', 'personalityState', 'personalityReason', 'refine', 'evolve', DURABLE_PROFILE_LIMITS.personality);
    applyText('speech', 'speechState', 'speechReason', 'refine', 'evolve', DURABLE_PROFILE_LIMITS.speech);
    applyText('appearance', 'appearanceState', 'appearanceReason', 'refine', 'change', DURABLE_PROFILE_LIMITS.appearance);

    if (!manualFields.has('mannerisms') && incoming.mannerismsProvided) {
        const current = normalizeMannerisms(npc.mannerisms || []);
        if (!current.length) {
            const source = String(options.developmentContext || '').trim();
            const gradualSeedReady = gradualProfileEvolutionReady('mannerisms', beforeEvidence, incomingEvidence);
            const mannerEvidence = [...(beforeEvidence.mannerisms || []), ...(incomingEvidence.mannerisms || [])];
            const seed = source
                ? (incoming.mannerisms || []).filter(entry => isExplicitRecurringMannerism(entry, source)
                    || (gradualSeedReady && durableEvidenceGroundsValue(entry, mannerEvidence)))
                : (incoming.mannerisms || []);
            npc.mannerisms = normalizeMannerisms(seed);
            if (npc.mannerisms.length) evidence.mannerisms = [];
            changed = npc.mannerisms.length > 0 || changed;
        } else if (incoming.mannerismState === 'evolve' && String(incoming.mannerismReason || '').trim() && evolutionReady('mannerisms')) {
            const replacement = normalizeMannerisms(incoming.mannerisms || []);
            if (JSON.stringify(replacement) !== JSON.stringify(current)) { npc.mannerisms = replacement; changed = true; }
            evidence.mannerisms = [];
        } else if (incoming.mannerismState === 'refine') {
            const allowNewPattern = evolutionReady('mannerisms');
            const safe = filterSafeMannerismRefinements(current, incoming.mannerisms, allowNewPattern, options.developmentContext);
            const proposedRefined = safe.length ? normalizeMannerisms(safe) : current;
            const refined = durableProfileCollectionEquivalent('mannerisms', current, proposedRefined) ? current : proposedRefined;
            if (JSON.stringify(refined) !== JSON.stringify(current)) { npc.mannerisms = refined; changed = true; }
            const refinedChanged = JSON.stringify(refined) !== JSON.stringify(current);
            const acceptedMannerisms = refinedChanged ? refined : current;
            evidence.mannerisms = unresolvedCollectionEvidence('mannerisms', acceptedMannerisms, beforeEvidence.mannerisms || [], incomingEvidence.mannerisms || []);


        }
    }

    if (!manualFields.has('behaviorProfile') && incoming.behaviorProfileProvided) {
        const current = normalizeBehaviorProfile(npc.behaviorProfile || []);
        if (!current.length) {
            const behaviorEvidence = [...(beforeEvidence.behaviorProfile || []), ...(incomingEvidence.behaviorProfile || [])];
            const grounded = groundedBehaviorProfile(incoming.behaviorProfile || [], npc.personality, options.developmentContext, behaviorEvidence, {
                npc,
                evidence: behaviorEvidence,
                targeted: options.targeted === true,
                otherLabels: options.otherLabels || [],
            });
            npc.behaviorProfile = reconcileBehaviorProfileWithPersonality(grounded, npc.personality);
            if (npc.behaviorProfile.length) evidence.behaviorProfile = [];
            else evidence.behaviorProfile = mergeRecentProfileEvidence(evidence.behaviorProfile, incomingEvidence.behaviorProfile || [], 'behaviorProfile');
            changed = npc.behaviorProfile.length > 0 || changed;
        } else if (incoming.behaviorProfileState === 'evolve' && String(incoming.behaviorProfileReason || '').trim() && evolutionReady('behaviorProfile')) {
            const replacement = reconcileBehaviorProfileWithPersonality(incoming.behaviorProfile || [], npc.personality);
            if (JSON.stringify(replacement) !== JSON.stringify(current)) { npc.behaviorProfile = replacement; changed = true; }
            evidence.behaviorProfile = [];
        } else if (incoming.behaviorProfileState === 'refine') {
            const proposedRefined = mergeBehaviorProfileRefinements(current, incoming.behaviorProfile, {
                context: options.developmentContext,
                personality: npc.personality,
                rejected: incoming.nonLeverBehavior || [],
                evidenceItems: [...(beforeEvidence.behaviorProfile || []), ...(incomingEvidence.behaviorProfile || [])],
                binding: {
                    npc,
                    evidence: [...(beforeEvidence.behaviorProfile || []), ...(incomingEvidence.behaviorProfile || [])],
                    targeted: options.targeted === true,
                    otherLabels: options.otherLabels || [],
                },
            });
            const refined = durableProfileCollectionEquivalent('behaviorProfile', current, proposedRefined) ? current : proposedRefined;
            if (JSON.stringify(refined) !== JSON.stringify(current)) { npc.behaviorProfile = refined; changed = true; }
            const refinedChanged = JSON.stringify(refined) !== JSON.stringify(current);
            const acceptedBehaviorProfile = refinedChanged ? refined : current;
            evidence.behaviorProfile = unresolvedCollectionEvidence('behaviorProfile', acceptedBehaviorProfile, beforeEvidence.behaviorProfile || [], incomingEvidence.behaviorProfile || []);
        } else if (incoming.behaviorProfileState === 'keep') {
            const behaviorEvidence = [...(beforeEvidence.behaviorProfile || []), ...(incomingEvidence.behaviorProfile || [])];
            const recovered = recoverBehaviorProfileKeepAdditions(current, incoming.behaviorProfile, {
                context: options.developmentContext,
                rejected: incoming.nonLeverBehavior || [],
                evidenceItems: behaviorEvidence,
                binding: {
                    npc,
                    evidence: behaviorEvidence,
                    targeted: options.targeted === true,
                    otherLabels: options.otherLabels || [],
                },
            });
            if (JSON.stringify(recovered) !== JSON.stringify(current)) { npc.behaviorProfile = recovered; changed = true; }
            const acceptedBehaviorProfile = JSON.stringify(recovered) !== JSON.stringify(current) ? recovered : current;
            evidence.behaviorProfile = unresolvedCollectionEvidence('behaviorProfile', acceptedBehaviorProfile, beforeEvidence.behaviorProfile || [], incomingEvidence.behaviorProfile || []);
        }
    }

    // (cleanup step 5) The other durable facts a profile update carries (the scanner rule sends an
    // existing NPC's durable facts there) are applied by the same rules as in the NPC's npcs[] entry;
    // they used to be dropped without a word. Live state (mood, location, goal, status) stays npcs[]-only.
    for (const field of PROFILE_UPDATE_TEXT_FIELDS) {
        if (manualFields.has(field)) continue;
        const value = typeof incoming[field] === 'string' ? incoming[field].trim() : '';
        if (!value || value === String(npc[field] ?? '').trim()) continue;
        if (!durableTextAccepted(field, npc, incoming, value, options)) continue;
        npc[field] = value;
        changed = true;
    }
    const customFields = incomingCustomFields(npc, incoming, manualFields, options);
    if (customFields) {
        npc.customFields = customFields;
        changed = true;
    }
    if (incoming.keyRelationshipsProvided && !manualFields.has('keyRelationships')) {
        const bonds = incomingKeyRelationships(npc, incoming, manualFields);
        if (JSON.stringify(bonds) !== JSON.stringify(npc.keyRelationships || [])) {
            npc.keyRelationships = bonds;
            changed = true;
        }
    }

    // (1.2.19) A model that files a known NPC's new memory under profileUpdates (a durable fact,
    // which the rules send there) used to lose it: only the npcs[] entry merged memories. Merged
    // here the same way: added to the stored ones, deduplicated, capped, never replacing them.
    if ((incoming.memories || []).length && !manualFields.has('memories')) {
        const before = JSON.stringify(npc.memories || []);
        npc.memories = mergeImportantMemories(npc.memories, incoming.memories, incoming.memoryRetention, options.memoryInputLimit || 3, npc.manualMemories, { stamps: npc.memoryStamps, message: options.sourceMessageId });
        if (JSON.stringify(npc.memories) !== before) changed = true;
    }

    const evidenceChanged = JSON.stringify(beforeEvidence) !== JSON.stringify(evidence);
    npc.profileEvidence = evidence;
    if (changed || evidenceChanged) npc.updatedAt = Date.now();
    return { changed, evidenceAdded: Math.max(0, profileEvidenceCount(evidence) - profileEvidenceCount(beforeEvidence)) };
}
