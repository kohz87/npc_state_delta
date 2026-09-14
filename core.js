export * from './core-mechanics.js';
export * from './appearance.js';
export * from './terminal-lifecycle.js';
export * from './calendar.js';
import * as continuity from './continuity-core.js';
import * as mechanics from './core-mechanics.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
import { removeNpcFromSocialGraph, purgeNpcStructuredReferences } from './social.js';
import {
    currentCalendarDate,
    extractStructuredWorldDate,
    getActiveCalendarConfig,
    normalizeCalendarDate,
} from './calendar.js';
import {
    applyNpcBirthdayUpdate,
    birthdayEvidenceInText,
    birthdayPromptRule,
    effectiveChronologicalAge,
    mergeNpcBirthdayKnowledge,
    normalizeNpcBirthday,
    normalizeScanBirthday,
    reanchorDerivedBirthYearFromAge,
} from './birthday.js';
export {
    BIRTHDAY_PROMPT_RULE,
    birthDatePrecision,
    deriveBirthDateFromAge,
    deterministicBirthday,
    formatBirthDate,
    normalizeBirthDate,
    normalizeBirthDateState,
} from './birthday.js';

const ROUTINE_APPARENT_AGE_RULE = '11. Age/ApparentAge separate: age=chronology only; apparentAge=visual cue, compact ~N, never prose; species literal; no species-aging inference. Birthday/exact elapsed=>ageState:"advance"+reason; correction=>ageState:"correct"+reason; visual aging/growth/rejuvenation=>apparentAgeState:"evolve"+reason. Appearance must not repeat explicit age. Vague time skip insufficient.';
const ROUTINE_APPARENT_AGE_RULE_FIXED = '11. Age/ApparentAge separate: age=chronology only; apparentAge=visual cue ~N. NEW dossier + cue => MUST return apparentAge when age unknown. species literal; no species-aging inference. Birthday/exact elapsed=>ageState:"advance"+reason; correction=>ageState:"correct"+reason; visual change=>apparentAgeState:"evolve"+reason. Appearance:no age; vague time skip insufficient.';
const SPEECH_DEVELOPMENT_VERSION = 1;
const SPEECH_DEVELOPMENT_CONCEPT_LIMIT = 4;
const SPEECH_DEVELOPMENT_OBSERVATION_LIMIT = 4;
const SPEECH_DEVELOPMENT_READY_COUNT = 3;
const SPEECH_DEVELOPMENT_MIN_TURN_SPAN = 2;

function strengthenRoutineApparentAgeRule(prompt) {
    return String(prompt).replace(ROUTINE_APPARENT_AGE_RULE, ROUTINE_APPARENT_AGE_RULE_FIXED);
}

function explicitVisualAgeCueFromAppearance(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';

    const exactYears = text.match(/\b(\d{1,3})[-\s]+years?[-\s]+old\b/i);
    if (exactYears) return exactYears[1];

    const decadeWords = 'twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties';
    const band = text.match(new RegExp(String.raw`\b(?:in\s+(?:his|her|their)\s+)?((?:early|mid|middle|late)\s+(?:[1-9]\d?s|${decadeWords}))\b`, 'i'));
    if (band) return band[1];

    const broadDecade = text.match(new RegExp(String.raw`\b(?:in\s+(?:his|her|their)\s+|about\s+|around\s+|approximately\s+)?(${decadeWords})\b`, 'i'));
    if (broadDecade) return broadDecade[1];

    const looksNumeric = text.match(/\b(?:looks?|appears?)(?:\s+to\s+be)?\s+(?:about\s+|around\s+|approximately\s+)?(\d{1,3}(?:\s*(?:-|to)\s*\d{1,3})?)(?:\s*(?:years?|yrs?)\s*(?:old)?)?\b/i);
    if (looksNumeric) return looksNumeric[1];

    const descriptor = text.match(/\b(young adult|middle[- ]aged|older adult|newborn|infant|toddler|pre[- ]?teen|adolescent|teenager|teen|elderly|senior|child|young)\b/i);
    return descriptor ? descriptor[1] : '';
}

function withAppearanceDerivedApparentAge(npc = {}, sourceAppearance = '') {
    if (!npc || typeof npc !== 'object' || String(npc.apparentAge ?? '').trim()) return npc;
    const cue = explicitVisualAgeCueFromAppearance(sourceAppearance || npc.appearance);
    if (!cue) return npc;
    const seed = npc.id || npc.name || npc.species || '';
    const apparentAge = mechanics.normalizeApparentAge(cue, seed);
    return apparentAge ? { ...npc, apparentAge } : npc;
}

function sameNpc(raw = {}, npc = {}) {
    if (raw?.id && String(raw.id) === String(npc?.id)) return true;
    if (raw?.name && mechanics.npcMatchesLabel(npc, raw.name)) return true;
    return Array.isArray(raw?.aliases) && raw.aliases.some(alias => mechanics.npcMatchesLabel(npc, alias));
}

function matchingPrevious(npc, source = []) {
    return (Array.isArray(source) ? source : []).filter(item => item && (
        String(item.id || '') === String(npc?.id || '')
        || (npc?.name && mechanics.npcMatchesLabel(item, npc.name))
        || (item?.name && mechanics.npcMatchesLabel(npc, item.name))
        || (item?.aliases || []).some(alias => mechanics.npcMatchesLabel(npc, alias))
    ));
}

function birthdayPromptSource(options = {}) {
    return String(options?.transcript || options?.dossierText || options?.developmentContext || '');
}

function calendarReference(options = {}, calendar = getActiveCalendarConfig()) {
    const extracted = extractStructuredWorldDate(options.calendarSource ?? birthdayPromptSource(options), calendar);
    return {
        extracted,
        fallback: !extracted && !normalizeCalendarDate(options?.referenceDate, calendar),
        date: extracted?.date || normalizeCalendarDate(options?.referenceDate, calendar) || currentCalendarDate(calendar),
    };
}

function calendarNpcProjection(raw = null, referenceDate = null, fallback = true) {
    if (!raw || typeof raw !== 'object') return raw;
    const calendar = getActiveCalendarConfig();
    const npc = normalizeNpcBirthday(raw, calendar, referenceDate);
    const acceptedAge = String(raw.age ?? '').trim();
    const protectedAge = isTerminalNpcDeath(raw) || (Array.isArray(raw.manualProfileFields) && raw.manualProfileFields.includes('age'));
    const computedAge = referenceDate && !protectedAge ? effectiveChronologicalAge(npc, calendar, referenceDate) : acceptedAge;
    const staleFallback = fallback && /^\d+$/.test(acceptedAge) && /^\d+$/.test(computedAge) && Number(computedAge) < Number(acceptedAge);
    return withAppearanceDerivedApparentAge({ ...npc, age: staleFallback ? acceptedAge : computedAge }, raw.appearance || npc.appearance);
}

function speechText(value, maxChars = mechanics.DURABLE_PROFILE_LIMITS.speech) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, Math.max(1, Number(maxChars) || mechanics.DURABLE_PROFILE_LIMITS.speech));
}

function speechTurn(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function speechSourceMessageId(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function speechEvidence(raw = {}) {
    const evidence = raw?.evidence ?? raw?.profileEvidence ?? raw?.profile_evidence ?? raw?.observations ?? {};
    const values = Array.isArray(evidence?.speech) ? evidence.speech : [];
    return values.map(item => speechText(item, mechanics.DURABLE_PROFILE_LIMITS.evidence)).filter(Boolean).slice(0, 8);
}

function speechConceptLabel(value) {
    const text = speechText(value, mechanics.DURABLE_PROFILE_LIMITS.evidence);
    const match = text.match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]{1,48})\s*:\s*(.+)$/u);
    return match ? mechanics.normalizeName(match[1]).slice(0, 60) : '';
}

function normalizeSpeechConcept(raw = {}) {
    const concept = mechanics.normalizeName(raw?.concept).slice(0, 60);
    if (!concept) return null;
    const sourceMessageIds = [...new Set((Array.isArray(raw?.sourceMessageIds) ? raw.sourceMessageIds : [])
        .map(speechSourceMessageId).filter(value => value !== null))].slice(-SPEECH_DEVELOPMENT_OBSERVATION_LIMIT);
    const turns = [...new Set((Array.isArray(raw?.turns) ? raw.turns : [])
        .map(speechTurn).filter(value => value !== null))].sort((a, b) => a - b).slice(-SPEECH_DEVELOPMENT_OBSERVATION_LIMIT);
    const firstTurn = speechTurn(raw?.firstTurn);
    const lastTurn = speechTurn(raw?.lastTurn);
    const observationCount = Math.max(
        0,
        Math.min(9, Math.round(Number(raw?.observationCount) || 0)),
        sourceMessageIds.length,
        turns.length,
    );
    return {
        concept,
        firstTurn: firstTurn ?? (turns.length ? Math.min(...turns) : null),
        lastTurn: lastTurn ?? (turns.length ? Math.max(...turns) : null),
        observationCount,
        sourceMessageIds,
        turns,
        latestEvidence: speechText(raw?.latestEvidence, mechanics.DURABLE_PROFILE_LIMITS.evidence),
    };
}

function legacySpeechConcepts(npc = {}) {
    const seen = new Set();
    const concepts = [];
    for (const evidence of speechEvidence({ evidence: npc?.profileEvidence || {} })) {
        const concept = speechConceptLabel(evidence);
        if (!concept || seen.has(concept)) continue;
        seen.add(concept);
        concepts.push({
            concept,
            firstTurn: null,
            lastTurn: null,
            observationCount: 1,
            sourceMessageIds: [],
            turns: [],
            latestEvidence: evidence,
        });
        if (concepts.length >= SPEECH_DEVELOPMENT_CONCEPT_LIMIT) break;
    }
    return concepts;
}

function emptySpeechDevelopment(npc = {}, concepts = []) {
    return {
        version: SPEECH_DEVELOPMENT_VERSION,
        epoch: 0,
        baselineSpeech: speechText(npc?.speech),
        baselineTurn: null,
        baselineSourceMessageId: null,
        concepts: concepts.map(normalizeSpeechConcept).filter(Boolean).slice(-SPEECH_DEVELOPMENT_CONCEPT_LIMIT),
    };
}

function normalizeSpeechDevelopment(raw, npc = {}, { seedLegacy = false } = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!source) {
        const seeded = seedLegacy ? legacySpeechConcepts(npc) : [];
        return seeded.length ? emptySpeechDevelopment(npc, seeded) : null;
    }
    const concepts = [];
    const byConcept = new Map();
    for (const item of Array.isArray(source.concepts) ? source.concepts : []) {
        const normalized = normalizeSpeechConcept(item);
        if (!normalized) continue;
        if (byConcept.has(normalized.concept)) concepts[byConcept.get(normalized.concept)] = normalized;
        else {
            byConcept.set(normalized.concept, concepts.length);
            concepts.push(normalized);
        }
    }
    return {
        version: SPEECH_DEVELOPMENT_VERSION,
        epoch: Math.max(0, Math.round(Number(source.epoch) || 0)),
        baselineSpeech: speechText(source.baselineSpeech ?? npc?.speech),
        baselineTurn: speechTurn(source.baselineTurn),
        baselineSourceMessageId: speechSourceMessageId(source.baselineSourceMessageId),
        concepts: concepts.slice(-SPEECH_DEVELOPMENT_CONCEPT_LIMIT),
    };
}

function resetSpeechDevelopment(ledger, speech, options = {}) {
    return {
        version: SPEECH_DEVELOPMENT_VERSION,
        epoch: Math.max(0, Math.round(Number(ledger?.epoch) || 0)) + 1,
        baselineSpeech: speechText(speech),
        baselineTurn: speechTurn(options.turn),
        baselineSourceMessageId: speechSourceMessageId(options.sourceMessageId),
        concepts: [],
    };
}

function rebaseSpeechDevelopment(ledger, speech) {
    return { ...ledger, baselineSpeech: speechText(speech) };
}

function speechDevelopmentForNpc(npc = {}, { seedLegacy = false } = {}) {
    let ledger = normalizeSpeechDevelopment(npc?.speechDevelopment, npc, { seedLegacy });
    if (!ledger) return null;
    const current = speechText(npc?.speech);
    if (mechanics.normalizeName(ledger.baselineSpeech) !== mechanics.normalizeName(current)) {
        ledger = resetSpeechDevelopment(ledger, current);
    }
    return ledger;
}

function observeSpeechDevelopment(ledger, rawUpdate = {}, options = {}) {
    const evidence = speechEvidence(rawUpdate);
    if (!ledger || !evidence.length) return ledger;
    const turn = speechTurn(options.turn);
    const sourceMessageId = speechSourceMessageId(options.sourceMessageId);
    const next = structuredClone(ledger);
    for (const item of evidence) {
        const concept = speechConceptLabel(item);
        if (!concept) continue;
        let record = next.concepts.find(entry => entry.concept === concept);
        if (!record) {
            if (next.concepts.length >= SPEECH_DEVELOPMENT_CONCEPT_LIMIT) next.concepts.shift();
            record = normalizeSpeechConcept({ concept }) || { concept, firstTurn: null, lastTurn: null, observationCount: 0, sourceMessageIds: [], turns: [], latestEvidence: '' };
            next.concepts.push(record);
        }
        const duplicate = sourceMessageId !== null
            ? record.sourceMessageIds.includes(sourceMessageId)
            : (turn !== null ? record.turns.includes(turn) : record.observationCount > 0);
        record.latestEvidence = item;
        if (duplicate) continue;
        record.observationCount = Math.min(9, Number(record.observationCount || 0) + 1);
        if (sourceMessageId !== null) {
            record.sourceMessageIds = [...record.sourceMessageIds, sourceMessageId].slice(-SPEECH_DEVELOPMENT_OBSERVATION_LIMIT);
        }
        if (turn !== null) {
            record.turns = [...new Set([...record.turns, turn])].sort((a, b) => a - b).slice(-SPEECH_DEVELOPMENT_OBSERVATION_LIMIT);
            record.firstTurn = record.firstTurn === null ? turn : Math.min(record.firstTurn, turn);
            record.lastTurn = record.lastTurn === null ? turn : Math.max(record.lastTurn, turn);
        }
    }
    return next;
}

function speechConceptReady(record = {}) {
    if (Number(record.observationCount || 0) < SPEECH_DEVELOPMENT_READY_COUNT) return false;
    const firstTurn = speechTurn(record.firstTurn);
    const lastTurn = speechTurn(record.lastTurn);
    if (firstTurn !== null || lastTurn !== null || (record.turns || []).length) {
        return firstTurn !== null && lastTurn !== null && lastTurn - firstTurn >= SPEECH_DEVELOPMENT_MIN_TURN_SPAN;
    }
    return (record.sourceMessageIds || []).length >= SPEECH_DEVELOPMENT_READY_COUNT;
}

function gradualSpeechDevelopmentReady(ledger, rawUpdate = {}) {
    const concepts = new Set(speechEvidence(rawUpdate).map(speechConceptLabel).filter(Boolean));
    if (!concepts.size) return false;
    return (ledger?.concepts || []).some(record => concepts.has(record.concept) && speechConceptReady(record));
}

function normalizedSpeechUpdate(raw = {}) {
    return continuity.normalizeScanNpc(raw || {});
}

function speechUpdateForNpc(scanResult, npc) {
    const profile = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    for (const raw of [...profile, ...ordinary]) {
        if (!raw || typeof raw !== 'object') continue;
        if (raw.id && String(raw.id) === String(npc?.id)) return raw;
        if (raw.name && mechanics.npcMatchesLabel(npc, raw.name)) return raw;
    }
    return null;
}

function prepareSpeechDevelopmentState(state, scanResult, options = {}) {
    const plans = new Map();
    const npcs = (Array.isArray(state?.npcs) ? state.npcs : []).map(rawNpc => {
        const update = speechUpdateForNpc(scanResult, rawNpc);
        const locked = Array.isArray(rawNpc?.manualProfileFields) && rawNpc.manualProfileFields.includes('speech');
        let ledger = speechDevelopmentForNpc(rawNpc, { seedLegacy: true });
        const hasLabeledEvidence = speechEvidence(update || {}).some(item => speechConceptLabel(item));
        if (!ledger && hasLabeledEvidence && !locked) ledger = emptySpeechDevelopment(rawNpc);
        if (ledger && update && !locked) ledger = observeSpeechDevelopment(ledger, update, options);
        if (ledger) {
            plans.set(String(rawNpc.id || ''), {
                update,
                ledger,
                ready: !locked && gradualSpeechDevelopmentReady(ledger, update || {}),
                locked,
                beforeSpeech: speechText(rawNpc.speech),
            });
            return { ...rawNpc, speechDevelopment: ledger };
        }
        return rawNpc;
    });
    return { state: { ...(state || {}), npcs }, plans };
}

function clearSpeechProfileEvidence(npc) {
    const profileEvidence = npc?.profileEvidence && typeof npc.profileEvidence === 'object' && !Array.isArray(npc.profileEvidence)
        ? npc.profileEvidence
        : {};
    npc.profileEvidence = { ...profileEvidence, speech: [] };
}

function markSpeechProfileApplied(report, npcId) {
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

function finalizeSpeechDevelopment(npc, plan, options = {}, report = null) {
    if (!plan?.ledger) return npc;
    const update = plan.update;
    let ledger = plan.ledger;
    const beforeSpeech = speechText(plan.beforeSpeech);
    let currentSpeech = speechText(npc.speech);
    if (!update) {
        npc.speechDevelopment = rebaseSpeechDevelopment(ledger, currentSpeech);
        return npc;
    }

    const normalized = normalizedSpeechUpdate(update);
    const state = String(normalized.speechState || 'keep');
    const scale = String(normalized.developmentScale || 'gradual');
    const proposedSpeech = speechText(normalized.speech);
    const speechReason = speechText(normalized.speechReason, 500);
    const changedByContinuity = state === 'evolve'
        && mechanics.normalizeName(beforeSpeech) !== mechanics.normalizeName(currentSpeech);

    if (changedByContinuity) {
        clearSpeechProfileEvidence(npc);
        npc.speechDevelopment = resetSpeechDevelopment(ledger, currentSpeech, options);
        return npc;
    }

    if (state === 'evolve' && scale === 'gradual' && plan.ready && !plan.locked && speechReason && proposedSpeech
        && mechanics.normalizeName(proposedSpeech) !== mechanics.normalizeName(currentSpeech)) {
        npc.speech = proposedSpeech;
        currentSpeech = proposedSpeech;
        clearSpeechProfileEvidence(npc);
        npc.speechDevelopment = resetSpeechDevelopment(ledger, currentSpeech, options);
        npc.updatedAt = Date.now();
        markSpeechProfileApplied(report, npc.id);
        return npc;
    }

    if (mechanics.normalizeName(beforeSpeech) !== mechanics.normalizeName(currentSpeech)) {
        ledger = rebaseSpeechDevelopment(ledger, currentSpeech);
    }
    npc.speechDevelopment = ledger;
    return npc;
}

function calendarPromptOptions(options = {}) {
    const next = { ...options };
    const calendar = getActiveCalendarConfig();
    const reference = calendarReference(options, calendar);
    const referenceDate = reference.date;
    if (Array.isArray(options.existingNpcs)) next.existingNpcs = options.existingNpcs.map(npc => calendarNpcProjection(npc, referenceDate, reference.fallback));
    if (options.existingNpc) next.existingNpc = calendarNpcProjection(options.existingNpc, referenceDate, reference.fallback);
    if (options.targetNpc) next.targetNpc = calendarNpcProjection(options.targetNpc, referenceDate, reference.fallback);
    return next;
}

function appendBirthdayRule(prompt, options = {}) {
    if (!birthdayEvidenceInText(birthdayPromptSource(options))) return String(prompt);
    const calendar = getActiveCalendarConfig();
    const referenceDate = calendarReference(options, calendar).date;
    return `${String(prompt)}${birthdayPromptRule(calendar, referenceDate)}`;
}

export function applyStaleNpcLifecycle(state = {}, options = {}) {
    const beforeNpcs = new Map((Array.isArray(state?.npcs) ? state.npcs : [])
        .filter(npc => npc?.id)
        .map(npc => [String(npc.id), structuredClone(npc)]));
    const result = mechanics.applyStaleNpcLifecycle(state, options);
    const removed = Array.isArray(result?.removed) ? result.removed : [];
    if (!removed.length) return result;

    // Complete stale-removal cleanup at the public mechanics facade while preserving
    // portrait bytes until branch/history pruning proves the NPC is no longer rollback-reachable.
    const next = result.state;
    for (const item of removed) {
        const id = String(item?.id || '');
        if (!id) continue;
        next.socialGraph = removeNpcFromSocialGraph(next.socialGraph, id);
        const removedNpc = beforeNpcs.get(id);
        if (removedNpc) purgeNpcStructuredReferences(next.npcs, removedNpc);
    }
    if (state?.portraitAssets && typeof state.portraitAssets === 'object') {
        next.portraitAssets = { ...structuredClone(state.portraitAssets), ...(next.portraitAssets || {}) };
    }
    return result;
}

export function normalizeNpcRecord(raw = {}) {
    const npc = withAppearanceDerivedApparentAge(normalizeNpcBirthday(continuity.normalizeNpcRecord(raw)), raw.appearance);
    const speechDevelopment = speechDevelopmentForNpc(npc);
    if (speechDevelopment) npc.speechDevelopment = speechDevelopment;
    return npc;
}

export function normalizeScanNpc(raw = {}, options = {}) {
    return withAppearanceDerivedApparentAge({ ...continuity.normalizeScanNpc(raw, options), ...normalizeScanBirthday(raw) }, raw.appearance);
}

export function setNpcArchived(npc, archived, options = {}) {
    return normalizeNpcBirthday(continuity.setNpcArchived(npc, archived, options));
}

export function applyNpcStateCommand(state, command, options = {}) {
    const result = continuity.applyNpcStateCommand(state, command, options);
    result.state.npcs = (result.state.npcs || []).map(npc => normalizeNpcBirthday(npc));
    return result;
}

export function mergeScanResult(state, scanResult, options = {}) {
    const speechPrepared = prepareSpeechDevelopmentState(state, scanResult, options);
    const sourceState = speechPrepared.state;
    const calendar = getActiveCalendarConfig();
    const reference = calendarReference(options, calendar);
    const referenceDate = reference.date;
    const previous = (sourceState?.npcs || []).map(raw => normalizeNpcBirthday(continuity.normalizeNpcRecord(raw), calendar, referenceDate));
    const result = continuity.mergeScanResult(sourceState, scanResult, options);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];

    result.state.npcs = (result.state.npcs || []).map(rawNpc => {
        const sources = matchingPrevious(rawNpc, previous);
        const ordinaryUpdate = ordinary.find(raw => sameNpc(raw, rawNpc));
        let npc = normalizeNpcBirthday(rawNpc, calendar, referenceDate);
        if (ordinaryUpdate) npc = applyNpcBirthdayUpdate(npc, ordinaryUpdate, { ...options, calendarConfig: calendar, referenceDate });
        const ageState = String(ordinaryUpdate?.ageState ?? ordinaryUpdate?.age_state ?? '').trim().toLowerCase();
        if ((ageState === 'advance' || ageState === 'correct') && npc.birthDateYearSource === 'derived'
            && sources.some(source => String(source.age) !== String(npc.age))) {
            npc = reanchorDerivedBirthYearFromAge(npc, calendar, referenceDate);
        }
        if (sources.length) npc = mergeNpcBirthdayKnowledge(sources, npc, calendar, referenceDate);

        // A grounded full current date turns a full birth date into deterministic chronology.
        // This updates actual age locally; apparentAge remains an unrelated visual field.
        if (!(npc.manualProfileFields || []).includes('age') && !isTerminalNpcDeath(npc)
            && referenceDate && Number.isInteger(npc.calendarAge) && normalizeCalendarDate(npc.birthDate, calendar)?.year !== null
            && !(reference.fallback && /^\d+$/.test(String(npc.age)) && npc.calendarAge < Number(npc.age))) {
            npc.age = String(npc.calendarAge);
        }
        npc = finalizeSpeechDevelopment(npc, speechPrepared.plans.get(String(npc.id || '')), options, result.report);
        return withAppearanceDerivedApparentAge(npc, ordinaryUpdate?.appearance || rawNpc.appearance);
    });
    if (reference.extracted) {
        result.report = {
            ...(result.report || {}),
            calendarReference: {
                source: 'world-state',
                raw: reference.extracted.raw,
                date: structuredClone(reference.extracted.date),
            },
        };
    }
    return result;
}

export function buildNpcPortraitPrompts(rawNpc = {}, options = {}) {
    return continuity.buildNpcPortraitPrompts(calendarNpcProjection(rawNpc), options);
}

export function buildInjection(npcs, text, turn = 0, limit = 3, behaviorCriteria = mechanics.DEFAULT_BEHAVIOR_CRITERIA, budgetTokens = 1800, socialGraph = null) {
    const projected = (Array.isArray(npcs) ? npcs : []).map(npc => calendarNpcProjection(npc));
    return continuity.buildInjection(projected, text, turn, limit, behaviorCriteria, budgetTokens, socialGraph);
}

export function buildScannerPrompt(options = {}) {
    const prompt = strengthenRoutineApparentAgeRule(continuity.buildScannerPrompt(calendarPromptOptions(options)));
    return appendBirthdayRule(prompt, options);
}
export function buildBackfillPrompt(options = {}) {
    return appendBirthdayRule(continuity.buildBackfillPrompt(calendarPromptOptions(options)), options);
}
export function buildDossierImportPrompt(options = {}) {
    return appendBirthdayRule(continuity.buildDossierImportPrompt(calendarPromptOptions(options)), options);
}
export function buildProfileRefreshPrompt(options = {}) {
    return appendBirthdayRule(continuity.buildProfileRefreshPrompt(calendarPromptOptions(options)), options);
}

// NPC State Delta application version. Persisted bundle, branch, and data schemas are versioned independently.
export const NPC_STATE_VERSION = '1.0.12';
