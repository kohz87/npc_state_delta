/* NPC State Delta profile development finalizing: applies the planned Personality/Speech development to an NPC record at the
   end of a merge (finalizeProfileDevelopmentField, finalizeProfileDevelopment). A pure part of core.js (same owner, moved without
   change); core.js imports it. Never imports core.js. */
import { clearProfileEvidence, emptyProfileDevelopment, markProfileApplied, PROFILE_DEVELOPMENT_FIELDS, PROFILE_DEVELOPMENT_READY_COUNT, profileDevelopmentEvidence, profileDevelopmentProvenanceReady, profileDevelopmentText, rebaseProfileDevelopment, recordProfileDevelopmentDiagnostic, resetProfileDevelopment } from './core-profile-development.js';
import * as mechanics from './core-mechanics.js';
import * as continuity from './continuity-core.js';

function finalizeProfileDevelopmentField(npc, field, plan, options = {}, report = null) {
    if (!plan) return npc;
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    let ledger = plan.ledger;
    const currentValue = profileDevelopmentText(field, npc?.[field]);
    const beforeValue = profileDevelopmentText(field, plan.beforeValue);
    const changedByContinuity = mechanics.normalizeName(beforeValue) !== mechanics.normalizeName(currentValue);

    if (!plan.active) {
        if (ledger && changedByContinuity) ledger = rebaseProfileDevelopment(field, ledger, currentValue);
        if (ledger) npc[config.ledgerKey] = ledger;
        return npc;
    }
    if (plan.locked) {
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'locked', plan);
        if (ledger) npc[config.ledgerKey] = ledger;
        return npc;
    }

    const normalized = continuity.normalizeScanNpc(plan.update || {});
    const state = String(normalized[`${field}State`] || 'keep');
    const scale = String(normalized.developmentScale || 'gradual');
    const proposed = profileDevelopmentText(field, normalized[field]);
    const reason = profileDevelopmentText(field, normalized[`${field}Reason`], 500);
    const developmentReason = profileDevelopmentText(field, normalized.developmentReason, 500);
    const rawDevelopmentEvidence = profileDevelopmentEvidence(field, plan.update || {});
    const evidenceReason = mechanics.durableProfileEvidenceReason(field, currentValue, proposed, rawDevelopmentEvidence);
    const effectiveReason = developmentReason || reason || evidenceReason;
    const effectiveReasonSource = developmentReason ? 'provider' : (reason ? 'field' : (evidenceReason ? 'evidence' : 'none'));
    const authorityProvenanceSupplied = Object.prototype.hasOwnProperty.call(options, 'userDevelopmentContext');
    const authoritativeContext = String(authorityProvenanceSupplied
        ? (options.userDevelopmentContext || '')
        : (options.developmentContext || '')).trim();
    const developmentBinding = {
        npc,
        evidence: rawDevelopmentEvidence,
        targeted: options.allowTargetedDurableSeed === true || plan.singleTargetUpdate === true,
        otherLabels: plan.otherLabels || [],
        sourceAuthority: authorityProvenanceSupplied ? 'user' : null,
    };
    const episode = mechanics.developmentEpisodeDiagnostic(effectiveReason, authoritativeContext, developmentBinding);
    const authorityContextReady = !authorityProvenanceSupplied || Boolean(authoritativeContext);
    const explicitReady = scale === 'explicit'
        && Boolean(proposed)
        && Boolean(effectiveReason)
        && authorityContextReady
        && mechanics.developmentScaleReady('explicit', effectiveReason, authoritativeContext, developmentBinding);
    const inferredBatchEligible = (scale === 'gradual' || scale === 'batch') && Boolean(authoritativeContext);
    const batchReady = (scale === 'batch' || inferredBatchEligible)
        && Boolean(proposed)
        && Boolean(effectiveReason)
        && authorityContextReady
        && mechanics.developmentScaleReady('batch', effectiveReason, authoritativeContext, developmentBinding);
    const inferredBatch = scale !== 'batch' && batchReady;
    const observationalScale = authorityProvenanceSupplied
        && (scale === 'explicit' || scale === 'batch')
        && !explicitReady && !batchReady;
    const effectiveScale = batchReady ? 'batch' : (explicitReady ? 'explicit' : (observationalScale ? 'gradual' : scale));
    const candidateChanged = Boolean(proposed) && mechanics.normalizeName(proposed) !== mechanics.normalizeName(currentValue);
    const resolutionEvidence = [
        ...(Array.isArray(plan.aggregateEvidence?.groups) ? plan.aggregateEvidence.groups : []),
        ...rawDevelopmentEvidence,
    ];
    const evidenceAlreadyRepresented = mechanics.durableProfileEvidenceAlreadyRepresented(field, currentValue, resolutionEvidence);
    const diagnosticBase = {
        modelState: state,
        scale,
        effectiveScale,
        authority: explicitReady ? 'user-explicit' : (batchReady ? 'user-batch' : (observationalScale ? 'model-observed' : 'observational')),
        developmentReason,
        fieldReason: reason,
        providerReasonPresent: Boolean(developmentReason),
        effectiveReason,
        effectiveReasonSource,
        candidateChanged,
        candidateAlreadyRepresented: Boolean(proposed) && !candidateChanged,
        evidenceAlreadyRepresented: Boolean(proposed) && !candidateChanged ? evidenceAlreadyRepresented : null,
        evidenceResolved: false,
        candidateGrounded: null,
        episode,
        reasonGrounded: (batchReady || explicitReady) ? true : (effectiveReason ? episode.grounded : null),
    };

    if (changedByContinuity) {
        if (state === 'evolve') {
            clearProfileEvidence(npc, field);
            if (ledger) ledger = resetProfileDevelopment(field, ledger, currentValue, options);
            const authorityApplied = authorityProvenanceSupplied && (explicitReady || batchReady);
            const outcome = authorityApplied
                ? (explicitReady ? 'applied-explicit' : 'applied-batch')
                : 'applied-model-evolve';
            recordProfileDevelopmentDiagnostic(report, npc.id, field, outcome, plan, {
                ...diagnosticBase,
                candidateGrounded: authorityApplied ? true : null,
                readinessPath: authorityApplied
                    ? (explicitReady ? 'authoritative-narrative' : 'batch')
                    : 'continuity',
                requiredObservations: authorityApplied ? 1 : null,
                inferredScale: inferredBatch,
                inferredEffectiveScale: inferredBatch ? 'batch' : '',
            });
        } else {
            if (ledger) ledger = rebaseProfileDevelopment(field, ledger, currentValue);
            recordProfileDevelopmentDiagnostic(report, npc.id, field, state === 'refine' ? 'applied-refine' : 'applied-recovery', plan, { modelState: state, scale });
        }
        if (ledger) npc[config.ledgerKey] = ledger;
        return npc;
    }

    // A copied full candidate cannot be applied. Classify it before explicit/batch
    // authorization so a failed episode gate cannot hide the real candidate state or
    // discard novel evidence. This is intentionally limited to provider-declared batch
    // development; ordinary gradual concept ledgers keep their existing readiness rules.
    if (scale === 'batch' && proposed && !candidateChanged) {
        if (!evidenceAlreadyRepresented) {
            recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-revised-candidate', plan, {
                ...diagnosticBase,
                candidateAlreadyRepresented: true,
                evidenceAlreadyRepresented: false,
                evidenceResolved: false,
            });
            if (ledger) npc[config.ledgerKey] = ledger;
            return npc;
        }
        clearProfileEvidence(npc, field);
        npc[config.ledgerKey] = resetProfileDevelopment(field, ledger || emptyProfileDevelopment(field, npc), currentValue, options);
        npc.updatedAt = Date.now();
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'evidence-already-reflected', plan, {
            ...diagnosticBase,
            candidateAlreadyRepresented: true,
            evidenceAlreadyRepresented: true,
            evidenceResolved: true,
        });
        return npc;
    }

    if (explicitReady) {
        if (!proposed) {
            recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-candidate', plan, {
                ...diagnosticBase,
                authority: 'user-explicit',
                readinessPath: 'authoritative-narrative',
                requiredObservations: 1,
            });
            if (ledger) npc[config.ledgerKey] = ledger;
            return npc;
        }
        if (!candidateChanged) {
            if (evidenceAlreadyRepresented) {
                clearProfileEvidence(npc, field);
                npc[config.ledgerKey] = resetProfileDevelopment(field, ledger || emptyProfileDevelopment(field, npc), currentValue, options);
                npc.updatedAt = Date.now();
                recordProfileDevelopmentDiagnostic(report, npc.id, field, 'evidence-already-reflected', plan, {
                    ...diagnosticBase,
                    authority: 'user-explicit',
                    readinessPath: 'authoritative-narrative',
                    requiredObservations: 1,
                    evidenceResolved: true,
                });
            } else {
                recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-revised-candidate', plan, {
                    ...diagnosticBase,
                    authority: 'user-explicit',
                    readinessPath: 'authoritative-narrative',
                    requiredObservations: 1,
                });
                if (ledger) npc[config.ledgerKey] = ledger;
            }
            return npc;
        }
        const groundingEvidence = [
            ...plan.evidence.map(item => item.body).filter(Boolean),
            reason,
            developmentReason,
            authoritativeContext,
        ].filter(Boolean);
        if (!mechanics.durableProfileEvolutionCandidateGrounded(field, currentValue, proposed, groundingEvidence)) {
            recordProfileDevelopmentDiagnostic(report, npc.id, field, 'candidate-ungrounded', plan, {
                ...diagnosticBase,
                authority: 'user-explicit',
                readinessPath: 'authoritative-narrative',
                requiredObservations: 1,
                candidateGrounded: false,
            });
            if (ledger) npc[config.ledgerKey] = ledger;
            return npc;
        }
        npc[field] = proposed;
        clearProfileEvidence(npc, field);
        npc[config.ledgerKey] = resetProfileDevelopment(field, ledger || emptyProfileDevelopment(field, npc), proposed, options);
        npc.updatedAt = Date.now();
        markProfileApplied(report, npc.id);
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'applied-explicit', plan, {
            ...diagnosticBase,
            authority: 'user-explicit',
            readinessPath: 'authoritative-narrative',
            requiredObservations: 1,
            candidateGrounded: true,
        });
        return npc;
    }

    if (batchReady) {
        if (!proposed) {
            recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-candidate', plan, diagnosticBase);
            if (ledger) npc[config.ledgerKey] = ledger;
            return npc;
        }
        if (!candidateChanged && !evidenceAlreadyRepresented) {
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-revised-candidate', plan, {
            ...diagnosticBase,
            candidateAlreadyRepresented: true,
            evidenceAlreadyRepresented: false,
            evidenceResolved: false,
        });
        if (ledger) npc[config.ledgerKey] = ledger;
        return npc;
    }
    if (!candidateChanged) {
            clearProfileEvidence(npc, field);
            npc[config.ledgerKey] = resetProfileDevelopment(field, ledger || emptyProfileDevelopment(field, npc), currentValue, options);
            npc.updatedAt = Date.now();
            recordProfileDevelopmentDiagnostic(report, npc.id, field, 'evidence-already-reflected', plan, {
                ...diagnosticBase,
                candidateAlreadyRepresented: true,
                evidenceAlreadyRepresented: true,
                evidenceResolved: true,
                inferredScale: inferredBatch,
                inferredEffectiveScale: inferredBatch ? 'batch' : '',
            });
            return npc;
        }
        const groundingEvidence = [
            ...plan.evidence.map(item => item.body).filter(Boolean),
            reason,
            developmentReason,
            mechanics.developmentEpisodeEvidence(developmentReason, authoritativeContext, developmentBinding),
        ].filter(Boolean);
        if (!mechanics.durableProfileEvolutionCandidateGrounded(field, currentValue, proposed, groundingEvidence)) {
            recordProfileDevelopmentDiagnostic(report, npc.id, field, 'candidate-ungrounded', plan, { ...diagnosticBase, candidateGrounded: false });
            if (ledger) npc[config.ledgerKey] = ledger;
            return npc;
        }
        npc[field] = proposed;
        clearProfileEvidence(npc, field);
        npc[config.ledgerKey] = resetProfileDevelopment(field, ledger || emptyProfileDevelopment(field, npc), proposed, options);
        npc.updatedAt = Date.now();
        markProfileApplied(report, npc.id);
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'applied-batch', plan, {
            ...diagnosticBase,
            candidateGrounded: true,
            inferredScale: inferredBatch,
            inferredEffectiveScale: inferredBatch ? 'batch' : '',
        });
        return npc;
    }

    if (effectiveScale !== 'gradual') {
        const outcome = state === 'evolve' && !reason ? 'missing-reason' : 'waiting-for-explicit-gate';
        recordProfileDevelopmentDiagnostic(report, npc.id, field, outcome, plan, diagnosticBase);
        if (ledger) npc[config.ledgerKey] = ledger;
        return npc;
    }
    const aggregateReady = Boolean(plan.aggregateEvidence?.ready);
    const aggregateFallback = !plan.readyRecords?.length && aggregateReady;
    const candidateSupport = field === 'speech' && proposed && candidateChanged
        ? mechanics.durableProfileCandidateSupport(field, currentValue, proposed, plan.aggregateEvidence?.groups || [])
        : null;
    const candidateBridgeReady = !plan.readyRecords?.length && !aggregateReady
        && Boolean(candidateSupport?.ready)
        && profileDevelopmentProvenanceReady(plan.aggregateEvidence, candidateSupport.requiredObservations);
    if (!ledger || (!plan.readyRecords?.length && !aggregateReady && !candidateBridgeReady)) {
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-evidence', plan, {
            ...diagnosticBase,
            aggregateFallback,
            authority: observationalScale ? 'model-observed' : 'observational',
            readinessPath: candidateSupport ? 'speech-candidate-support' : 'concept',
            changeClass: candidateSupport?.changeClass || null,
            requiredObservations: candidateSupport?.requiredObservations || plan.aggregateEvidence?.required || PROFILE_DEVELOPMENT_READY_COUNT,
            supportingGroups: candidateSupport?.supportingGroups || 0,
        });
        if (ledger) npc[config.ledgerKey] = ledger;
        return npc;
    }
    if (!proposed) {
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-candidate', plan, {
            ...diagnosticBase,
            aggregateFallback,
            readinessPath: candidateBridgeReady ? 'speech-candidate-support' : (aggregateFallback ? 'aggregate' : 'concept'),
            requiredObservations: candidateSupport?.requiredObservations || plan.aggregateEvidence?.required || PROFILE_DEVELOPMENT_READY_COUNT,
        });
        npc[config.ledgerKey] = ledger;
        return npc;
    }
    if (!candidateChanged && !evidenceAlreadyRepresented) {
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-revised-candidate', plan, {
            ...diagnosticBase,
            candidateAlreadyRepresented: true,
            evidenceAlreadyRepresented: false,
            evidenceResolved: false,
        });
        if (ledger) npc[config.ledgerKey] = ledger;
        return npc;
    }
    if (!candidateChanged) {
        if (aggregateFallback) {
            clearProfileEvidence(npc, field);
            npc[config.ledgerKey] = resetProfileDevelopment(field, ledger, currentValue, options);
            npc.updatedAt = Date.now();
            recordProfileDevelopmentDiagnostic(report, npc.id, field, 'evidence-already-reflected', plan, {
                ...diagnosticBase,
                aggregateFallback: true,
                candidateAlreadyRepresented: true,
                evidenceAlreadyRepresented: true,
                evidenceResolved: true,
            });
            return npc;
        }
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'waiting-for-candidate', plan, {
            ...diagnosticBase,
            aggregateFallback: false,
            candidateAlreadyRepresented: true,
        });
        npc[config.ledgerKey] = ledger;
        return npc;
    }

    const groundingEvidence = [
        ...plan.readyRecords.flatMap(record => {
            const samples = Array.isArray(record.evidenceSamples) && record.evidenceSamples.length
                ? record.evidenceSamples
                : [record.latestEvidence];
            return samples.filter(Boolean);
        }),
        ...plan.evidence.map(item => item.body).filter(Boolean),
    ];
    // A provider-declared evolve with a reason may admit reworded development (strict concept
    // grounding froze legitimate growth), but never a protected morality reversal on that label alone.
    const modelAuthorized = state === 'evolve' && Boolean(reason)
        && !(field === 'personality' && mechanics.identityMoralityConflict(currentValue, proposed));
    const conceptCandidateGrounded = mechanics.durableProfileEvolutionCandidateGrounded(field, currentValue, proposed, groundingEvidence);
    const aggregateCandidateGrounded = aggregateFallback
        ? mechanics.durableProfileAggregateCandidateGrounded(field, currentValue, proposed, plan.aggregateEvidence?.groups || [], plan.aggregateEvidence?.required)
        : false;
    const bridgeCandidateGrounded = candidateBridgeReady ? Boolean(candidateSupport?.grounded) : false;
    if ((candidateBridgeReady && !bridgeCandidateGrounded)
        || (!candidateBridgeReady && aggregateFallback && !aggregateCandidateGrounded)
        || (!candidateBridgeReady && !aggregateFallback && !modelAuthorized && !conceptCandidateGrounded)) {
        recordProfileDevelopmentDiagnostic(report, npc.id, field, 'candidate-ungrounded', plan, {
            ...diagnosticBase,
            candidateGrounded: candidateBridgeReady ? bridgeCandidateGrounded : (aggregateFallback ? aggregateCandidateGrounded : conceptCandidateGrounded),
            aggregateFallback,
            readinessPath: candidateBridgeReady ? 'speech-candidate-support' : (aggregateFallback ? 'aggregate' : 'concept'),
            changeClass: candidateSupport?.changeClass || null,
            requiredObservations: candidateSupport?.requiredObservations || plan.aggregateEvidence?.required || PROFILE_DEVELOPMENT_READY_COUNT,
            supportingGroups: candidateSupport?.supportingGroups || 0,
        });
        npc[config.ledgerKey] = ledger;
        return npc;
    }

    npc[field] = proposed;
    clearProfileEvidence(npc, field);
    npc[config.ledgerKey] = resetProfileDevelopment(field, ledger, proposed, options);
    npc.updatedAt = Date.now();
    markProfileApplied(report, npc.id);
    recordProfileDevelopmentDiagnostic(report, npc.id, field,
        candidateBridgeReady ? 'applied-speech-candidate' : (aggregateFallback ? 'applied-aggregate-gradual' : 'applied'),
        plan, {
            ...diagnosticBase,
            candidateGrounded: candidateBridgeReady
                ? bridgeCandidateGrounded
                : (aggregateFallback ? aggregateCandidateGrounded : conceptCandidateGrounded),
            aggregateFallback,
            authority: !candidateBridgeReady && !aggregateFallback && modelAuthorized && !conceptCandidateGrounded
                ? 'model-evolve'
                : (observationalScale ? 'model-observed' : 'observational'),
            readinessPath: candidateBridgeReady ? 'speech-candidate-support' : (aggregateFallback ? 'aggregate' : 'concept'),
            changeClass: candidateSupport?.changeClass || null,
            requiredObservations: candidateSupport?.requiredObservations || plan.aggregateEvidence?.required || PROFILE_DEVELOPMENT_READY_COUNT,
            supportingGroups: candidateSupport?.supportingGroups || 0,
        });
    return npc;
}

export function finalizeProfileDevelopment(npc, plans, options = {}, report = null) {
    if (!plans) return npc;
    let next = npc;
    for (const field of Object.keys(PROFILE_DEVELOPMENT_FIELDS)) {
        next = finalizeProfileDevelopmentField(next, field, plans[field], options, report);
    }
    return next;
}
