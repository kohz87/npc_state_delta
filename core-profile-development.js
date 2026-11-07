/* NPC State Delta profile development diagnostics: the per-scan profile, appearance, secondary-profile
   and birthday receipts the merge records, plus profile evidence/application markers. The ledger model,
   observation and readiness parts live in core-profile-development-*.js and are re-exported here unchanged;
   this root path keeps every public export. A pure part of core.js (same owner); never imports core.js. */
import * as mechanics from './core-mechanics.js';
import { normalizeCalendarDate } from './calendar.js';
import * as continuity from './continuity-core.js';
import { birthdayPromptSource, exactStoredAge, sameCalendarBirthday } from './core-birthday.js';
import { birthdayEvidenceInText } from './birthday.js';
import { PROFILE_DEVELOPMENT_OBSERVATION_LIMIT, parseProfileDevelopmentEvidence, profileDevelopmentSourceMessageId, profileDevelopmentText } from './core-profile-development-ledger.js';

export {
    PROFILE_DEVELOPMENT_READY_COUNT,
    PROFILE_DEVELOPMENT_FIELDS,
    profileDevelopmentText,
    profileDevelopmentEvidence,
    emptyProfileDevelopment,
    resetProfileDevelopment,
    rebaseProfileDevelopment,
    profileDevelopmentForNpc,
} from './core-profile-development-ledger.js';
export {
    profileDevelopmentProvenanceReady,
    durableUpdateForNpc,
    appearanceUpdateForNpc,
    prepareProfileDevelopmentState,
} from './core-profile-development-readiness.js';

export function clearProfileEvidence(npc, field) {
    const profileEvidence = npc?.profileEvidence && typeof npc.profileEvidence === 'object' && !Array.isArray(npc.profileEvidence)
        ? npc.profileEvidence
        : {};
    npc.profileEvidence = { ...profileEvidence, [field]: [] };
}

export function markProfileApplied(report, npcId) {
    if (!report || !npcId) return;
    report.updated = Array.isArray(report.updated) ? report.updated : [];
    report.profileUpdated = Array.isArray(report.profileUpdated) ? report.profileUpdated : [];
    if (!report.updated.includes(npcId)) report.updated.push(npcId);
    const alreadyApplied = report.profileUpdated.includes(npcId);
    if (!alreadyApplied) report.profileUpdated.push(npcId);
    report.profileUpdateStats = report.profileUpdateStats && typeof report.profileUpdateStats === 'object'
        ? report.profileUpdateStats
        : { provided: 0, applied: 0, evidenceAdded: 0 };
    if (!alreadyApplied) report.profileUpdateStats.applied = Number(report.profileUpdateStats.applied || 0) + 1;
}

export function recordProfileDevelopmentDiagnostic(report, npcId, field, outcome, plan = null, details = {}) {
    if (!report || !npcId || !field || !outcome) return;
    report.profileDevelopment = Array.isArray(report.profileDevelopment) ? report.profileDevelopment : [];
    const observations = Math.max(0, ...(plan?.ledger?.concepts || []).map(record => Number(record?.observationCount || 0)));
    const evidence = (Array.isArray(plan?.evidence) ? plan.evidence : []).slice(0, PROFILE_DEVELOPMENT_OBSERVATION_LIMIT).map(item => ({
        sourceMessageId: profileDevelopmentSourceMessageId(item?.sourceMessageId),
        concept: profileDevelopmentText(field, item?.explicitConcept || item?.concept, 60),
        sample: profileDevelopmentText(field, item?.body, mechanics.DURABLE_PROFILE_LIMITS.evidence),
    }));
    report.profileDevelopment.push({
        npcId: String(npcId),
        field,
        outcome,
        ready: Boolean(plan?.readyRecords?.length),
        aggregateReady: Boolean(plan?.aggregateEvidence?.ready),
        aggregateObservations: Number(plan?.aggregateEvidence?.count || 0),
        locked: Boolean(plan?.locked),
        observations,
        previous: profileDevelopmentText(field, plan?.beforeValue),
        candidate: profileDevelopmentText(field, plan?.update?.[field]),
        evidence,
        ...details,
    });
    if (report.profileDevelopment.length > 48) report.profileDevelopment.splice(0, report.profileDevelopment.length - 48);
}

export function recordAppearanceDiagnostic(report, beforeNpc, afterNpc, rawUpdate, options = {}, allNpcs = []) {
    if (!report || !beforeNpc || !afterNpc) return;
    const raw = rawUpdate && typeof rawUpdate === 'object' ? rawUpdate : {};
    const normalized = continuity.normalizeScanNpc(raw);
    const evidenceSource = raw?.evidence ?? raw?.profileEvidence ?? raw?.profile_evidence ?? {};
    const rawEvidence = Array.isArray(evidenceSource?.appearance) ? evidenceSource.appearance : [];
    const providerFieldPresent = [
        'appearance', 'appearanceState', 'appearance_state', 'appearanceReason', 'appearance_reason',
        'overallAppearance', 'overall_appearance', 'appearanceForms', 'appearance_forms',
        'currentForm', 'current_form', 'currentFormState', 'current_form_state',
    ].some(key => Object.prototype.hasOwnProperty.call(raw, key));
    const providerEvidencePresent = rawEvidence.length > 0;
    const structuredAppearancePresent = [
        'overallAppearance', 'overall_appearance', 'appearanceForms', 'appearance_forms',
        'currentForm', 'current_form', 'currentFormState', 'current_form_state',
    ].some(key => Object.prototype.hasOwnProperty.call(raw, key));
    const previousValue = profileDevelopmentText('appearance', beforeNpc.appearance, 720);
    const candidateValue = profileDevelopmentText('appearance', normalized.appearance, 720);
    const currentValue = profileDevelopmentText('appearance', afterNpc.appearance, 720);
    const locked = Array.isArray(beforeNpc?.manualProfileFields) && beforeNpc.manualProfileFields.includes('appearance');
    const flatCandidateChanged = Boolean(candidateValue)
        && mechanics.normalizeName(candidateValue) !== mechanics.normalizeName(previousValue);
    const changed = mechanics.normalizeName(currentValue) !== mechanics.normalizeName(previousValue);
    const diagnosticCandidate = candidateValue || (structuredAppearancePresent && changed ? currentValue : '');
    const candidateChanged = Boolean(diagnosticCandidate)
        && mechanics.normalizeName(diagnosticCandidate) !== mechanics.normalizeName(previousValue);
    const candidateAlreadyRepresented = Boolean(diagnosticCandidate) && !candidateChanged;
    const otherLabels = (Array.isArray(allNpcs) ? allNpcs : [])
        .filter(other => String(other?.id || '') !== String(afterNpc?.id || ''))
        .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
        .filter(Boolean).slice(0, 64);
    const binding = {
        npc: afterNpc,
        evidence: rawEvidence,
        targeted: options.allowTargetedDurableSeed === true || options.developmentSingleTarget === true,
        otherLabels,
    };
    const candidateGrounded = flatCandidateChanged && normalized.appearanceState !== 'change'
        ? mechanics.durableRefinementCandidateGrounded(
            'appearance',
            previousValue,
            candidateValue,
            options.developmentContext || '',
            rawEvidence,
            binding,
        )
        : null;
    const fieldReason = profileDevelopmentText('appearance', normalized.appearanceReason, 500);
    const outcome = !providerFieldPresent && !providerEvidencePresent ? 'not-provided'
        : (locked ? 'locked'
            : (changed ? (structuredAppearancePresent && !candidateValue ? 'applied-form-update' : `applied-${normalized.appearanceState || 'update'}`)
                : (!candidateValue
                    ? (structuredAppearancePresent ? 'form-update-unchanged-or-gated' : 'candidate-missing')
                    : (candidateAlreadyRepresented ? 'unchanged' : 'unchanged-or-gated'))));
    const evidence = rawEvidence.slice(0, PROFILE_DEVELOPMENT_OBSERVATION_LIMIT).map(item => {
        const parsed = parseProfileDevelopmentEvidence('appearance', item);
        return {
            sourceMessageId: parsed?.sourceMessageId ?? null,
            concept: parsed?.explicitConcept || parsed?.concept || '',
            sample: parsed?.body || profileDevelopmentText('appearance', item, mechanics.DURABLE_PROFILE_LIMITS.evidence),
        };
    });
    report.profileDevelopment = Array.isArray(report.profileDevelopment) ? report.profileDevelopment : [];
    report.profileDevelopment.push({
        npcId: String(afterNpc.id || ''),
        field: 'appearance',
        outcome,
        modelState: normalized.appearanceState || 'keep',
        scale: '',
        effectiveScale: '',
        locked,
        previous: previousValue,
        candidate: diagnosticCandidate,
        fieldReason,
        providerReasonPresent: Boolean(fieldReason),
        effectiveReason: fieldReason,
        effectiveReasonSource: fieldReason ? 'field' : 'none',
        candidateChanged,
        candidateAlreadyRepresented,
        evidenceAlreadyRepresented: null,
        evidenceResolved: false,
        candidateGrounded,
        reasonGrounded: null,
        providerFieldPresent,
        structuredAppearancePresent,
        providerEvidencePresent,
        evidence,
    });
    if (report.profileDevelopment.length > 48) report.profileDevelopment.splice(0, report.profileDevelopment.length - 48);
}

export function recordSecondaryProfileDiagnostics(report, beforeNpc, afterNpc, rawUpdate, options = {}, allNpcs = []) {
    if (!report || !afterNpc || !rawUpdate) return;
    const normalized = continuity.normalizeScanNpc(rawUpdate);
    const evidenceSource = rawUpdate?.evidence ?? rawUpdate?.profileEvidence ?? rawUpdate?.profile_evidence ?? {};
    const otherLabels = (Array.isArray(allNpcs) ? allNpcs : [])
        .filter(other => String(other?.id || '') !== String(afterNpc?.id || ''))
        .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
        .filter(Boolean).slice(0, 64);
    for (const field of ['mannerisms', 'behaviorProfile']) {
        const stateField = field === 'mannerisms' ? 'mannerismState' : 'behaviorProfileState';
        const reasonField = field === 'mannerisms' ? 'mannerismReason' : 'behaviorProfileReason';
        const provided = field === 'mannerisms' ? normalized.mannerismsProvided : normalized.behaviorProfileProvided;
        if (!provided) {
            // Explain why stored non-lever entries survived: the provider omitted the field or
            // proposed only non-lever entries, which intake drops.
            if (field !== 'behaviorProfile') continue;
            const rawBehavior = rawUpdate.behaviorProfile ?? rawUpdate.behavior_profile;
            const nonLeverOnly = Array.isArray(normalized.nonLeverBehavior) && normalized.nonLeverBehavior.length > 0;
            const stored = Array.isArray(beforeNpc?.behaviorProfile) ? beforeNpc.behaviorProfile : [];
            if (!nonLeverOnly && !stored.some(entry => !mechanics.isBehaviorLever(entry))) continue;
            report.profileDevelopment = Array.isArray(report.profileDevelopment) ? report.profileDevelopment : [];
            report.profileDevelopment.push({
                npcId: String(afterNpc.id || ''),
                field,
                outcome: nonLeverOnly ? 'non-lever-only' : 'not-provided',
                modelState: normalized[stateField] || 'keep',
                locked: Array.isArray(beforeNpc?.manualProfileFields) && beforeNpc.manualProfileFields.includes(field),
                providerFieldPresent: rawBehavior !== undefined,
                previous: profileDevelopmentText(field, stored.join(' | '), 720),
                candidate: profileDevelopmentText(field, (normalized.nonLeverBehavior || []).join(' | '), 720),
                evidence: [],
            });
            if (report.profileDevelopment.length > 48) report.profileDevelopment.splice(0, report.profileDevelopment.length - 48);
            continue;
        }
        const previousValue = Array.isArray(beforeNpc?.[field]) ? beforeNpc[field].join(' | ') : '';
        const candidateValue = Array.isArray(normalized?.[field]) ? normalized[field].join(' | ') : '';
        const currentValue = Array.isArray(afterNpc?.[field]) ? afterNpc[field].join(' | ') : '';
        const locked = Array.isArray(beforeNpc?.manualProfileFields) && beforeNpc.manualProfileFields.includes(field);
        const rawEvidence = Array.isArray(evidenceSource?.[field]) ? evidenceSource[field] : [];
        const binding = {
            npc: afterNpc,
            evidence: rawEvidence,
            targeted: options.allowTargetedDurableSeed === true || options.developmentSingleTarget === true,
            otherLabels,
        };
        const developmentReason = profileDevelopmentText(field, normalized.developmentReason, 500);
        const fieldReason = profileDevelopmentText(field, normalized[reasonField], 500);
        const evidenceReason = mechanics.durableProfileEvidenceReason(field, beforeNpc?.[field] || [], normalized?.[field] || [], rawEvidence);
        const effectiveReason = developmentReason || fieldReason || evidenceReason;
        const effectiveReasonSource = developmentReason ? 'provider' : (fieldReason ? 'field' : (evidenceReason ? 'evidence' : 'none'));
        const candidateChanged = !mechanics.durableProfileCollectionEquivalent(field, beforeNpc?.[field] || [], normalized?.[field] || []);
        const candidateSpecificGrounding = candidateChanged
            && mechanics.durableProfileCollectionCandidateGrounded(field, beforeNpc?.[field] || [], normalized?.[field] || [], rawEvidence);
        const episode = mechanics.developmentEpisodeDiagnostic(effectiveReason, options.developmentContext, binding);
        const inferredBatch = normalized.developmentScale === 'gradual'
            && candidateChanged
            && candidateSpecificGrounding
            && Boolean(effectiveReason)
            && Boolean(String(options.developmentContext || '').trim())
            && mechanics.developmentScaleReady('batch', effectiveReason, options.developmentContext, binding);
        const changed = !mechanics.durableProfileCollectionEquivalent(field, beforeNpc?.[field] || [], afterNpc?.[field] || []);
        const candidateAlreadyRepresented = Boolean(candidateValue)
            && mechanics.durableProfileCollectionEquivalent(field, beforeNpc?.[field] || [], normalized?.[field] || []);
        const evidenceAlreadyRepresented = mechanics.durableProfileEvidenceAlreadyRepresented(
            field,
            afterNpc?.[field] || [],
            rawEvidence,
        );
        const recoveredKeepRefinement = field === 'behaviorProfile'
            && changed
            && (normalized[stateField] || 'keep') === 'keep';
        const outcome = locked ? 'locked'
            : (changed && inferredBatch ? 'applied-inferred-batch'
                : (recoveredKeepRefinement ? 'applied-recovered-refine'
                    : (changed ? `applied-${normalized[stateField] || 'update'}`
                    : (candidateAlreadyRepresented
                        ? (evidenceAlreadyRepresented ? 'evidence-already-reflected' : 'waiting-for-revised-candidate')
                        : 'unchanged-or-gated'))));
        const evidence = rawEvidence.slice(0, PROFILE_DEVELOPMENT_OBSERVATION_LIMIT).map(item => {
            const parsed = parseProfileDevelopmentEvidence(field, item);
            return {
                sourceMessageId: parsed?.sourceMessageId ?? null,
                concept: parsed?.explicitConcept || parsed?.concept || '',
                sample: parsed?.body || profileDevelopmentText(field, item, mechanics.DURABLE_PROFILE_LIMITS.evidence),
            };
        });
        report.profileDevelopment = Array.isArray(report.profileDevelopment) ? report.profileDevelopment : [];
        report.profileDevelopment.push({
            npcId: String(afterNpc.id || ''),
            field,
            outcome,
            modelState: normalized[stateField] || 'keep',
            scale: normalized.developmentScale || 'gradual',
            effectiveScale: inferredBatch ? 'batch' : (normalized.developmentScale || 'gradual'),
            inferredScale: inferredBatch,
            locked,
            previous: profileDevelopmentText(field, previousValue, 720),
            candidate: profileDevelopmentText(field, candidateValue, 720),
            developmentReason,
            fieldReason,
            providerReasonPresent: Boolean(developmentReason),
            effectiveReason,
            effectiveReasonSource,
            candidateChanged,
            candidateAlreadyRepresented,
            evidenceAlreadyRepresented,
            evidenceResolved: rawEvidence.length ? evidenceAlreadyRepresented : false,
            candidateGrounded: candidateChanged ? candidateSpecificGrounding : null,
            reasonGrounded: effectiveReason ? episode.grounded : null,
            episode,
            evidence,
        });
        if (report.profileDevelopment.length > 48) report.profileDevelopment.splice(0, report.profileDevelopment.length - 48);
    }
}

export function recordBirthdayDiagnostic(report, beforeNpc, afterNpc, ordinaryUpdate, options, calendar, referenceDate) {
    if (!report || !beforeNpc || !afterNpc || !referenceDate) return;
    const birthdayMatched = sameCalendarBirthday(afterNpc.birthDate, referenceDate, calendar);
    const incomingBirthday = ordinaryUpdate?.birthDate ?? ordinaryUpdate?.birth_date ?? ordinaryUpdate?.birthday;
    const birthDateState = String(ordinaryUpdate?.birthDateState ?? ordinaryUpdate?.birth_date_state ?? '').trim().toLowerCase();
    const establishedNow = Boolean(incomingBirthday)
        && ['establish', 'set', 'update', 'refine', 'correct', 'correction'].includes(birthDateState);
    const narratedBirthday = birthdayEvidenceInText(birthdayPromptSource(options));
    const manualFields = Array.isArray(afterNpc.manualProfileFields) ? afterNpc.manualProfileFields : [];
    const previousAge = String(beforeNpc.age ?? '').trim();
    const age = String(afterNpc.age ?? '').trim();
    const previousApparentAge = String(beforeNpc.apparentAge ?? '').trim();
    const apparentAge = String(afterNpc.apparentAge ?? '').trim();
    const oldExact = exactStoredAge(previousAge);
    const newExact = exactStoredAge(age);
    const delta = oldExact !== null && newExact !== null ? newExact - oldExact : 0;
    const ageState = String(ordinaryUpdate?.ageState ?? ordinaryUpdate?.age_state ?? '').trim().toLowerCase();
    const birthdaySupplied = Boolean(incomingBirthday);
    if (!birthdayMatched && !birthdaySupplied && !['advance', 'correct', 'correction'].includes(ageState) && delta === 0) return;

    let reason = 'no-rollover';
    if (manualFields.includes('age')) reason = 'manual-age-lock';
    else if (delta > 0) reason = 'calendar-rollover';
    else if (establishedNow && birthdayMatched) reason = 'first-establishment-guard';
    else if (birthdayMatched && narratedBirthday) reason = 'birthday-held';
    else if (ageState === 'correct' || ageState === 'correction') reason = 'age-correction-held';
    else if (ageState === 'advance') reason = 'age-advance-held';

    report.birthdayDiagnostics = Array.isArray(report.birthdayDiagnostics) ? report.birthdayDiagnostics : [];
    report.birthdayDiagnostics.push({
        npcId: String(afterNpc.id || ''),
        outcome: delta > 0 ? 'advance' : 'hold',
        reason,
        birthdayMatched,
        establishedNow,
        birthdaySupplied,
        birthDateState,
        narratedBirthday,
        ageState,
        ageLocked: manualFields.includes('age'),
        apparentAgeLocked: manualFields.includes('apparentAge'),
        previousAge,
        age,
        previousApparentAge,
        apparentAge,
        delta,
        previousBirthDate: normalizeCalendarDate(beforeNpc.birthDate, calendar),
        birthDate: normalizeCalendarDate(afterNpc.birthDate, calendar),
        birthDateYearSource: String(afterNpc.birthDateYearSource || ''),
        calendarAge: Number.isInteger(afterNpc.calendarAge) ? afterNpc.calendarAge : null,
        referenceDate: normalizeCalendarDate(referenceDate, calendar),
    });
    if (report.birthdayDiagnostics.length > 32) report.birthdayDiagnostics.splice(0, report.birthdayDiagnostics.length - 32);
}
