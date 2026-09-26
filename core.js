export * from './core-mechanics.js';
export * from './appearance.js';
export * from './terminal-lifecycle.js';
export * from './calendar.js';
import * as continuity from './continuity-core.js';
import * as mechanics from './core-mechanics.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
import { resolveNpcAppearance } from './appearance.js';
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

const ROUTINE_APPARENT_AGE_RULE = '11. Age/ApparentAge separate: age=chronology only; apparentAge=visual cue, compact ~N, never prose; species literal; no species-aging inference. gender=male|female only if explicit/unambiguous; never guess; change=>genderState:"correct"+reason. Birthday/exact elapsed=>ageState:"advance"+reason; correction=>ageState:"correct"+reason; visual aging/growth/rejuvenation=>apparentAgeState:"evolve"+reason. Appearance must not repeat explicit age. Vague time skip insufficient.';
const ROUTINE_APPARENT_AGE_RULE_FIXED = '11. Age/ApparentAge separate: age=chronology only; apparentAge=visual cue ~N; cue=>MUST return apparentAge when age unknown; species literal; no species-aging inference. Birthday/elapsed=>ageState:"advance"+reason; correction=>ageState:"correct"+reason; visual=>apparentAgeState:"evolve"+reason. Appearance:no age; vague time skip insufficient. gender=male|female only if explicit; never infer; change=>genderState:"correct"+reason.';
const PROFILE_DEVELOPMENT_VERSION = 2;
const PROFILE_DEVELOPMENT_CONCEPT_LIMIT = 4;
const PROFILE_DEVELOPMENT_OBSERVATION_LIMIT = 4;
const PROFILE_DEVELOPMENT_READY_COUNT = 3;
const PROFILE_DEVELOPMENT_MIN_SPAN = 2;
const PROFILE_DEVELOPMENT_FIELDS = Object.freeze({
    personality: Object.freeze({ ledgerKey: 'personalityDevelopment', baselineKey: 'baselinePersonality' }),
    speech: Object.freeze({ ledgerKey: 'speechDevelopment', baselineKey: 'baselineSpeech' }),
});

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

const BIRTHDAY_UPDATE_KEYS = ['birthDate', 'birth_date', 'birthday', 'birthDateState', 'birth_date_state', 'birthDateReason', 'birth_date_reason'];
function hasBirthdayUpdate(row) {
    return Boolean(row && typeof row === 'object' && (row.birthDate ?? row.birth_date ?? row.birthday));
}

// The scanner is told to put grounded durable facts in profileUpdates, so a narrated birthday for an
// existing NPC can arrive there instead of in its npcs delta. Accept it from either channel; the
// ordinary delta wins when both carry one, and the same establish/correct gate applies.
function birthdayUpdateRow(ordinaryRow, profileRow) {
    if (hasBirthdayUpdate(ordinaryRow) || !hasBirthdayUpdate(profileRow)) return ordinaryRow;
    const birthday = Object.fromEntries(BIRTHDAY_UPDATE_KEYS.filter(key => key in profileRow).map(key => [key, profileRow[key]]));
    return { ...(ordinaryRow || {}), ...birthday };
}

// Deterministic per-field "last changed at turn" markers for the dossier. They are presentation
// metadata on the canonical record (rolled back with it), never scanner input or prompt content.
const CHANGE_TRACKED_FIELDS = Object.freeze([
    'mood', 'location', 'goal', 'status', 'homeBase', 'age', 'apparentAge', 'lifeState',
    'personality', 'speech', 'behaviorProfile', 'mannerisms', 'appearance',
    'relationship', 'relationshipSummary', 'background', 'keyRelationships', 'memories', 'birthDate',
]);

export function normalizeFieldChanges(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const field of CHANGE_TRACKED_FIELDS) {
        const turn = Number(source[field]);
        if (Number.isInteger(turn) && turn >= 0) out[field] = turn;
    }
    return out;
}

function trackedFieldValue(npc, field) {
    if (field === 'appearance') return resolveNpcAppearance(npc);
    if (field === 'relationship') {
        const rel = npc?.relationship || {};
        return ['trust', 'affection', 'desire', 'tension'].map(axis => Math.round(Number(rel[axis]) || 0));
    }
    return npc?.[field] ?? '';
}

function stampFieldChanges(before, after, turn) {
    const changes = normalizeFieldChanges(after?.fieldChanges ?? before?.fieldChanges);
    if (!before || !Number.isInteger(turn) || turn < 0) return { ...after, fieldChanges: changes };
    for (const field of CHANGE_TRACKED_FIELDS) {
        if (JSON.stringify(trackedFieldValue(before, field)) !== JSON.stringify(trackedFieldValue(after, field))) changes[field] = turn;
    }
    return { ...after, fieldChanges: changes };
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

function exactStoredAge(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,3}$/.test(text) ? Number(text) : null;
}

function compactApparentAgeNumber(value) {
    const match = String(value ?? '').trim().match(/^~?(\d{1,3})$/);
    return match ? Number(match[1]) : null;
}

function sameCalendarBirthday(a, b, calendar) {
    const left = normalizeCalendarDate(a, calendar);
    const right = normalizeCalendarDate(b, calendar);
    if (!left || !right) return false;
    if (left.era && right.era && mechanics.normalizeName(left.era) !== mechanics.normalizeName(right.era)) return false;
    return mechanics.normalizeName(left.month) === mechanics.normalizeName(right.month) && left.day === right.day;
}

function applyDeterministicBirthdayRollover(npc, previousRaw, ordinaryUpdate, options, calendar, referenceDate) {
    if (!npc || !previousRaw || !referenceDate || isTerminalNpcDeath(npc)) return npc;
    const manualFields = Array.isArray(npc.manualProfileFields) ? npc.manualProfileFields : [];
    if (manualFields.includes('age')) return npc;
    if (!sameCalendarBirthday(npc.birthDate, referenceDate, calendar)) return npc;

    const previousAge = exactStoredAge(previousRaw.age);
    if (previousAge === null) return npc;
    const currentAge = exactStoredAge(npc.age);
    const calendarAge = Number.isInteger(npc.calendarAge) ? npc.calendarAge : null;
    let targetAge = calendarAge !== null && calendarAge > previousAge ? calendarAge : currentAge;

    const previousBirthDate = normalizeCalendarDate(
        previousRaw.birthDate ?? previousRaw.birth_date ?? previousRaw.birthday,
        calendar,
    );
    const previousHadYear = previousBirthDate?.year !== null && previousBirthDate?.year !== undefined;
    const incomingBirthday = ordinaryUpdate?.birthDate ?? ordinaryUpdate?.birth_date ?? ordinaryUpdate?.birthday;
    const birthdayEstablishedNow = Boolean(incomingBirthday)
        && ['establish', 'set', 'update', 'refine', 'correct', 'correction']
            .includes(String(ordinaryUpdate?.birthDateState ?? ordinaryUpdate?.birth_date_state ?? '').trim().toLowerCase());
    const ageState = String(ordinaryUpdate?.ageState ?? ordinaryUpdate?.age_state ?? '').trim().toLowerCase();
    const correctedAge = ageState === 'correct' || ageState === 'correction';
    const narratedBirthday = birthdayEvidenceInText(birthdayPromptSource(options));

    // Compatibility recovery for an existing yearless birthday: if the story has reached that
    // exact stored birthday and explicitly presents it as a birthday/nameday, the accepted age
    // is the pre-birthday baseline. Advance once, then anchor the derived year so repeated scans
    // on the same day are idempotent. A birthday first established in this same scan is excluded.
    if (!previousHadYear && !birthdayEstablishedNow && !correctedAge && narratedBirthday
        && (targetAge === null || targetAge <= previousAge)) {
        targetAge = previousAge + 1;
    }

    if (targetAge === null || targetAge <= previousAge) return npc;
    const delta = targetAge - previousAge;
    let next = { ...npc, age: String(targetAge), updatedAt: Date.now() };
    if (next.birthDateYearSource === 'derived'
        && (!Number.isInteger(next.calendarAge) || next.calendarAge < targetAge)) {
        next = reanchorDerivedBirthYearFromAge(next, calendar, referenceDate);
        next.age = String(targetAge);
    }

    const apparentState = String(ordinaryUpdate?.apparentAgeState ?? ordinaryUpdate?.apparent_age_state ?? '').trim().toLowerCase();
    if (!manualFields.includes('apparentAge') && apparentState !== 'evolve') {
        const apparent = compactApparentAgeNumber(previousRaw.apparentAge ?? npc.apparentAge);
        if (apparent !== null) next.apparentAge = `~${Math.max(0, apparent + delta)}`;
    }
    return normalizeNpcBirthday(next, calendar, referenceDate);
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

function profileDevelopmentText(field, value, maxChars = null) {
    const limit = Math.max(1, Number(maxChars) || mechanics.DURABLE_PROFILE_LIMITS[field] || mechanics.DURABLE_PROFILE_LIMITS.evidence);
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function profileDevelopmentTurn(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function profileDevelopmentSourceMessageId(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

function profileDevelopmentEvidence(field, raw = {}) {
    const evidence = raw?.evidence ?? raw?.profileEvidence ?? raw?.profile_evidence ?? raw?.observations ?? {};
    const values = Array.isArray(evidence?.[field]) ? evidence[field] : [];
    return values.map(item => profileDevelopmentText(field, item, mechanics.DURABLE_PROFILE_LIMITS.evidence)).filter(Boolean).slice(0, 8);
}

function parseProfileDevelopmentEvidence(field, value) {
    let text = profileDevelopmentText(field, value, mechanics.DURABLE_PROFILE_LIMITS.evidence);
    if (!text) return null;
    const marker = text.match(/^\[m(\d+)\]\s*/i);
    const sourceMessageId = marker ? profileDevelopmentSourceMessageId(marker[1]) : null;
    if (marker) text = text.slice(marker[0].length).trim();
    if (!text) return null;
    const labeled = text.match(/^([\p{L}\p{N}][\p{L}\p{N} _\-/]{1,48})\s*:\s*(.+)$/u);
    const explicitConcept = labeled ? mechanics.normalizeName(labeled[1]).slice(0, 60) : '';
    const body = profileDevelopmentText(field, labeled ? labeled[2] : text, mechanics.DURABLE_PROFILE_LIMITS.evidence);
    const concept = explicitConcept || mechanics.normalizeName(body).slice(0, 60);
    return body && concept ? { concept, explicitConcept, body, sourceMessageId } : null;
}

function normalizeProfileDevelopmentConcept(raw = {}) {
    const concept = mechanics.normalizeName(raw?.concept).slice(0, 60);
    if (!concept) return null;
    const sourceMessageIds = [...new Set((Array.isArray(raw?.sourceMessageIds) ? raw.sourceMessageIds : [])
        .map(profileDevelopmentSourceMessageId).filter(value => value !== null))]
        .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
    const turns = [...new Set((Array.isArray(raw?.turns) ? raw.turns : [])
        .map(profileDevelopmentTurn).filter(value => value !== null))]
        .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
    const firstTurn = profileDevelopmentTurn(raw?.firstTurn);
    const lastTurn = profileDevelopmentTurn(raw?.lastTurn);
    const observationCount = Math.max(
        0,
        Math.min(9, Math.round(Number(raw?.observationCount) || 0)),
        sourceMessageIds.length,
        turns.length,
    );
    const evidenceSamples = [...new Set((Array.isArray(raw?.evidenceSamples) ? raw.evidenceSamples : [])
        .map(item => profileDevelopmentText('speech', item, mechanics.DURABLE_PROFILE_LIMITS.evidence)).filter(Boolean))]
        .slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
    const latestEvidence = profileDevelopmentText('speech', raw?.latestEvidence, mechanics.DURABLE_PROFILE_LIMITS.evidence)
        || evidenceSamples.at(-1) || '';
    // v1 records had only latestEvidence. Seed one bounded sample during normalization, but once
    // v2 samples exist do not let a replayed source manufacture another historical observation.
    if (!evidenceSamples.length && latestEvidence) evidenceSamples.push(latestEvidence);
    return {
        concept,
        firstTurn: firstTurn ?? (turns.length ? Math.min(...turns) : null),
        lastTurn: lastTurn ?? (turns.length ? Math.max(...turns) : null),
        observationCount,
        sourceMessageIds,
        turns,
        evidenceSamples,
        latestEvidence,
    };
}

function legacyProfileDevelopmentConcepts(field, npc = {}) {
    const concepts = [];
    for (const evidence of profileDevelopmentEvidence(field, { evidence: npc?.profileEvidence || {} })) {
        const parsed = parseProfileDevelopmentEvidence(field, evidence);
        if (!parsed) continue;
        const duplicate = concepts.some(record => mechanics.durableProfileEvidenceRelated(record.latestEvidence, parsed.body));
        if (duplicate) continue;
        concepts.push({
            concept: parsed.concept,
            firstTurn: null,
            lastTurn: null,
            observationCount: 1,
            sourceMessageIds: [],
            turns: [],
            evidenceSamples: [parsed.body],
            latestEvidence: parsed.body,
        });
        if (concepts.length >= PROFILE_DEVELOPMENT_CONCEPT_LIMIT) break;
    }
    return concepts;
}

function emptyProfileDevelopment(field, npc = {}, concepts = []) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    if (!config) return null;
    return {
        version: PROFILE_DEVELOPMENT_VERSION,
        epoch: 0,
        [config.baselineKey]: profileDevelopmentText(field, npc?.[field]),
        baselineTurn: null,
        baselineSourceMessageId: null,
        concepts: concepts.map(normalizeProfileDevelopmentConcept).filter(Boolean).slice(-PROFILE_DEVELOPMENT_CONCEPT_LIMIT),
    };
}

function normalizeProfileDevelopment(field, raw, npc = {}, { seedLegacy = false } = {}) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    if (!config) return null;
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!source) {
        const seeded = seedLegacy ? legacyProfileDevelopmentConcepts(field, npc) : [];
        return seeded.length ? emptyProfileDevelopment(field, npc, seeded) : null;
    }
    const concepts = [];
    const byConcept = new Map();
    for (const item of Array.isArray(source.concepts) ? source.concepts : []) {
        const normalized = normalizeProfileDevelopmentConcept(item);
        if (!normalized) continue;
        if (byConcept.has(normalized.concept)) concepts[byConcept.get(normalized.concept)] = normalized;
        else {
            byConcept.set(normalized.concept, concepts.length);
            concepts.push(normalized);
        }
    }
    return {
        version: PROFILE_DEVELOPMENT_VERSION,
        epoch: Math.max(0, Math.round(Number(source.epoch) || 0)),
        [config.baselineKey]: profileDevelopmentText(field, source[config.baselineKey] ?? npc?.[field]),
        baselineTurn: profileDevelopmentTurn(source.baselineTurn),
        baselineSourceMessageId: profileDevelopmentSourceMessageId(source.baselineSourceMessageId),
        concepts: concepts.slice(-PROFILE_DEVELOPMENT_CONCEPT_LIMIT),
    };
}

function resetProfileDevelopment(field, ledger, value, options = {}) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    return {
        version: PROFILE_DEVELOPMENT_VERSION,
        epoch: Math.max(0, Math.round(Number(ledger?.epoch) || 0)) + 1,
        [config.baselineKey]: profileDevelopmentText(field, value),
        baselineTurn: profileDevelopmentTurn(options.turn),
        baselineSourceMessageId: profileDevelopmentSourceMessageId(options.sourceMessageId),
        concepts: [],
    };
}

function rebaseProfileDevelopment(field, ledger, value) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    return { ...ledger, [config.baselineKey]: profileDevelopmentText(field, value) };
}

function profileDevelopmentForNpc(field, npc = {}, { seedLegacy = false } = {}) {
    const config = PROFILE_DEVELOPMENT_FIELDS[field];
    if (!config) return null;
    let ledger = normalizeProfileDevelopment(field, npc?.[config.ledgerKey], npc, { seedLegacy });
    if (!ledger) return null;
    const current = profileDevelopmentText(field, npc?.[field]);
    if (mechanics.normalizeName(ledger[config.baselineKey]) !== mechanics.normalizeName(current)) {
        ledger = resetProfileDevelopment(field, ledger, current);
    }
    return ledger;
}

function developmentRecordMatches(record, parsed) {
    if (!record || !parsed) return false;
    if (parsed.explicitConcept && record.concept === parsed.explicitConcept) return true;
    const samples = [...(Array.isArray(record.evidenceSamples) ? record.evidenceSamples : []), record.latestEvidence]
        .filter(Boolean);
    if (samples.some(sample => mechanics.durableProfileEvidenceRelated(sample, parsed.body))) return true;
    if (!parsed.explicitConcept || !record.concept) return false;
    return samples.some(sample => mechanics.durableProfileEvidenceRelated(
        `${record.concept}: ${sample}`,
        `${parsed.explicitConcept}: ${parsed.body}`,
    ));
}

function findDevelopmentRecordIndex(concepts, parsed) {
    const exact = parsed?.explicitConcept
        ? concepts.findIndex(record => record?.concept === parsed.explicitConcept)
        : -1;
    if (exact >= 0) return exact;
    return concepts.findIndex(record => developmentRecordMatches(record, parsed));
}

function observeProfileDevelopment(field, ledger, rawUpdate = {}, options = {}) {
    const evidence = profileDevelopmentEvidence(field, rawUpdate);
    if (!ledger || !evidence.length) return ledger;
    const fallbackTurn = profileDevelopmentTurn(options.turn);
    const fallbackSourceMessageId = profileDevelopmentSourceMessageId(options.sourceMessageId);
    const allowedSourceMessageIds = Array.isArray(options.developmentSourceMessageIds)
        ? new Set(options.developmentSourceMessageIds.map(profileDevelopmentSourceMessageId).filter(value => value !== null))
        : null;
    const next = structuredClone(ledger);
    for (const item of evidence) {
        const parsed = parseProfileDevelopmentEvidence(field, item);
        if (!parsed) continue;
        const taggedSourceMessageId = parsed.sourceMessageId !== null && allowedSourceMessageIds?.has(parsed.sourceMessageId)
            ? parsed.sourceMessageId
            : null;
        const sourceMessageId = taggedSourceMessageId ?? fallbackSourceMessageId;
        const turn = taggedSourceMessageId !== null ? null : fallbackTurn;
        let index = findDevelopmentRecordIndex(next.concepts, parsed);
        if (index < 0) {
            if (next.concepts.length >= PROFILE_DEVELOPMENT_CONCEPT_LIMIT) next.concepts.shift();
            const fresh = normalizeProfileDevelopmentConcept({ concept: parsed.concept });
            if (!fresh) continue;
            next.concepts.push(fresh);
            index = next.concepts.length - 1;
        }
        const record = next.concepts[index];
        if (parsed.explicitConcept && record.concept !== parsed.explicitConcept
            && mechanics.durableProfileEvidenceRelated(record.latestEvidence, parsed.body)) {
            record.concept = parsed.explicitConcept;
        }
        const duplicate = sourceMessageId !== null
            ? record.sourceMessageIds.includes(sourceMessageId)
            : (turn !== null ? record.turns.includes(turn) : record.observationCount > 0);
        record.latestEvidence = parsed.body;
        if (duplicate) continue;
        record.evidenceSamples = [...(Array.isArray(record.evidenceSamples) ? record.evidenceSamples : [])
            .filter(item => mechanics.normalizeName(item) !== mechanics.normalizeName(parsed.body)), parsed.body]
            .slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
        record.observationCount = Math.min(9, Number(record.observationCount || 0) + 1);
        if (sourceMessageId !== null) {
            record.sourceMessageIds = [...new Set([...record.sourceMessageIds, sourceMessageId])]
                .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
        }
        if (turn !== null) {
            record.turns = [...new Set([...record.turns, turn])]
                .sort((a, b) => a - b).slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT);
            record.firstTurn = record.firstTurn === null ? turn : Math.min(record.firstTurn, turn);
            record.lastTurn = record.lastTurn === null ? turn : Math.max(record.lastTurn, turn);
        }
    }
    return next;
}

function profileDevelopmentConceptReady(record = {}) {
    if (Number(record.observationCount || 0) < PROFILE_DEVELOPMENT_READY_COUNT) return false;
    const firstTurn = profileDevelopmentTurn(record.firstTurn);
    const lastTurn = profileDevelopmentTurn(record.lastTurn);
    const turnReady = firstTurn !== null && lastTurn !== null && lastTurn - firstTurn >= PROFILE_DEVELOPMENT_MIN_SPAN;
    const sourceIds = [...new Set((record.sourceMessageIds || []).map(profileDevelopmentSourceMessageId).filter(value => value !== null))]
        .sort((a, b) => a - b);
    const sourceReady = sourceIds.length >= PROFILE_DEVELOPMENT_READY_COUNT
        && sourceIds[sourceIds.length - 1] - sourceIds[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    return turnReady || sourceReady;
}

function aggregateProfileDevelopmentEvidence(ledger = {}) {
    const groups = new Map();
    const sourceIds = new Set();
    const turns = new Set();
    for (const record of Array.isArray(ledger?.concepts) ? ledger.concepts : []) {
        const samples = Array.isArray(record?.evidenceSamples) && record.evidenceSamples.length
            ? record.evidenceSamples
            : (record?.latestEvidence ? [record.latestEvidence] : []);
        const recordSources = Array.isArray(record?.sourceMessageIds) ? record.sourceMessageIds : [];
        const recordTurns = Array.isArray(record?.turns) ? record.turns : [];
        for (let i = 0; i < samples.length; i += 1) {
            const sample = profileDevelopmentText('speech', samples[i], mechanics.DURABLE_PROFILE_LIMITS.evidence);
            if (!sample) continue;
            const sourceId = profileDevelopmentSourceMessageId(recordSources[i]);
            const turn = profileDevelopmentTurn(recordTurns[i]);
            const key = sourceId !== null ? `m:${sourceId}` : (turn !== null ? `t:${turn}` : '');
            if (!key) continue;
            if (sourceId !== null) sourceIds.add(sourceId);
            if (turn !== null) turns.add(turn);
            const current = groups.get(key) || [];
            if (!current.some(value => mechanics.normalizeName(value) === mechanics.normalizeName(sample))) current.push(sample);
            groups.set(key, current.slice(-PROFILE_DEVELOPMENT_OBSERVATION_LIMIT));
        }
    }
    const orderedSources = [...sourceIds].sort((a, b) => a - b);
    const orderedTurns = [...turns].sort((a, b) => a - b);
    const sourceReady = orderedSources.length >= PROFILE_DEVELOPMENT_READY_COUNT
        && orderedSources.at(-1) - orderedSources[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    const turnReady = orderedTurns.length >= PROFILE_DEVELOPMENT_READY_COUNT
        && orderedTurns.at(-1) - orderedTurns[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    return {
        ready: groups.size >= PROFILE_DEVELOPMENT_READY_COUNT && (sourceReady || turnReady),
        count: groups.size,
        groups: [...groups.values()].map(values => values.join(' ')).filter(Boolean),
        sourceMessageIds: orderedSources,
        turns: orderedTurns,
    };
}

function profileDevelopmentProvenanceReady(aggregate = {}, required = 2) {
    const threshold = Math.max(1, Number(required) || 1);
    const sources = [...new Set((aggregate?.sourceMessageIds || []).map(profileDevelopmentSourceMessageId).filter(value => value !== null))]
        .sort((a, b) => a - b);
    const turns = [...new Set((aggregate?.turns || []).map(profileDevelopmentTurn).filter(value => value !== null))]
        .sort((a, b) => a - b);
    const sourceReady = sources.length >= threshold
        && sources.at(-1) - sources[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    const turnReady = turns.length >= threshold
        && turns.at(-1) - turns[0] >= PROFILE_DEVELOPMENT_MIN_SPAN;
    return sourceReady || turnReady;
}

function readyProfileDevelopmentRecords(field, ledger, rawUpdate = {}) {
    const current = profileDevelopmentEvidence(field, rawUpdate)
        .map(item => parseProfileDevelopmentEvidence(field, item)).filter(Boolean);
    if (!current.length) return [];
    return (ledger?.concepts || []).filter(record => profileDevelopmentConceptReady(record)
        && current.some(parsed => developmentRecordMatches(record, parsed)));
}

function durableUpdateForNpc(scanResult, npc) {
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

function appearanceUpdateForNpc(scanResult, npc) {
    const profile = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    const matches = [...profile, ...ordinary].filter(raw => raw && typeof raw === 'object' && (
        (raw.id && String(raw.id) === String(npc?.id))
        || (raw.name && mechanics.npcMatchesLabel(npc, raw.name))
    ));
    const carriesAppearance = raw => {
        const evidence = raw?.evidence ?? raw?.profileEvidence ?? raw?.profile_evidence ?? {};
        return Object.prototype.hasOwnProperty.call(raw, 'appearance')
            || Object.prototype.hasOwnProperty.call(raw, 'appearanceState')
            || Object.prototype.hasOwnProperty.call(raw, 'appearance_state')
            || Object.prototype.hasOwnProperty.call(raw, 'appearanceReason')
            || Object.prototype.hasOwnProperty.call(raw, 'appearance_reason')
            || Object.prototype.hasOwnProperty.call(raw, 'overallAppearance')
            || Object.prototype.hasOwnProperty.call(raw, 'overall_appearance')
            || Object.prototype.hasOwnProperty.call(raw, 'appearanceForms')
            || Object.prototype.hasOwnProperty.call(raw, 'appearance_forms')
            || Object.prototype.hasOwnProperty.call(raw, 'currentForm')
            || Object.prototype.hasOwnProperty.call(raw, 'current_form')
            || Object.prototype.hasOwnProperty.call(raw, 'currentFormState')
            || Object.prototype.hasOwnProperty.call(raw, 'current_form_state')
            || (Array.isArray(evidence?.appearance) && evidence.appearance.length > 0);
    };
    return matches.find(carriesAppearance) || matches[0] || null;
}

function prepareProfileDevelopmentState(state, scanResult, options = {}) {
    const plans = new Map();
    const profileUpdates = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    const singleTargetUpdate = profileUpdates.length === 1;
    const npcs = (Array.isArray(state?.npcs) ? state.npcs : []).map(rawNpc => {
        const update = durableUpdateForNpc(scanResult, rawNpc);
        const fieldPlans = {};
        let nextNpc = rawNpc;
        for (const field of Object.keys(PROFILE_DEVELOPMENT_FIELDS)) {
            const config = PROFILE_DEVELOPMENT_FIELDS[field];
            const locked = Array.isArray(rawNpc?.manualProfileFields) && rawNpc.manualProfileFields.includes(field);
            const evidence = profileDevelopmentEvidence(field, update || {});
            const candidate = profileDevelopmentText(field, update?.[field]);
            const active = Boolean(evidence.length || candidate);
            let ledger = profileDevelopmentForNpc(field, rawNpc, { seedLegacy: true });
            if (!ledger && evidence.length && !locked) ledger = emptyProfileDevelopment(field, rawNpc);
            if (ledger && update && !locked && evidence.length) ledger = observeProfileDevelopment(field, ledger, update, options);
            if (ledger) {
                if (nextNpc === rawNpc) nextNpc = { ...rawNpc };
                nextNpc[config.ledgerKey] = ledger;
            }
            if (ledger || active) {
                fieldPlans[field] = {
                    update,
                    ledger,
                    locked,
                    active,
                    evidence: evidence.map(item => parseProfileDevelopmentEvidence(field, item)).filter(Boolean),
                    beforeValue: profileDevelopmentText(field, rawNpc?.[field]),
                    readyRecords: ledger && !locked ? readyProfileDevelopmentRecords(field, ledger, update || {}) : [],
                    aggregateEvidence: ledger && !locked ? aggregateProfileDevelopmentEvidence(ledger) : { ready: false, count: 0, groups: [], sourceMessageIds: [], turns: [] },
                    singleTargetUpdate,
                    otherLabels: (Array.isArray(state?.npcs) ? state.npcs : [])
                        .filter(other => String(other?.id || '') !== String(rawNpc?.id || ''))
                        .flatMap(other => [other?.name, ...(Array.isArray(other?.aliases) ? other.aliases : [])])
                        .filter(Boolean).slice(0, 64),
                };
            }
        }
        if (Object.keys(fieldPlans).length) plans.set(String(rawNpc.id || ''), fieldPlans);
        return nextNpc;
    });
    return { state: { ...(state || {}), npcs }, plans };
}

function clearProfileEvidence(npc, field) {
    const profileEvidence = npc?.profileEvidence && typeof npc.profileEvidence === 'object' && !Array.isArray(npc.profileEvidence)
        ? npc.profileEvidence
        : {};
    npc.profileEvidence = { ...profileEvidence, [field]: [] };
}

function markProfileApplied(report, npcId) {
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

function recordProfileDevelopmentDiagnostic(report, npcId, field, outcome, plan = null, details = {}) {
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

function recordAppearanceDiagnostic(report, beforeNpc, afterNpc, rawUpdate, options = {}, allNpcs = []) {
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

function recordSecondaryProfileDiagnostics(report, beforeNpc, afterNpc, rawUpdate, options = {}, allNpcs = []) {
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
        if (!provided) continue;
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

function recordBirthdayDiagnostic(report, beforeNpc, afterNpc, ordinaryUpdate, options, calendar, referenceDate) {
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
            requiredObservations: candidateSupport?.requiredObservations || PROFILE_DEVELOPMENT_READY_COUNT,
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
            requiredObservations: candidateSupport?.requiredObservations || PROFILE_DEVELOPMENT_READY_COUNT,
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
    const modelAuthorized = state === 'evolve' && Boolean(reason);
    const conceptCandidateGrounded = mechanics.durableProfileEvolutionCandidateGrounded(field, currentValue, proposed, groundingEvidence);
    const aggregateCandidateGrounded = aggregateFallback
        ? mechanics.durableProfileAggregateCandidateGrounded(field, currentValue, proposed, plan.aggregateEvidence?.groups || [])
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
            requiredObservations: candidateSupport?.requiredObservations || PROFILE_DEVELOPMENT_READY_COUNT,
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
                : (aggregateFallback ? aggregateCandidateGrounded : (modelAuthorized || conceptCandidateGrounded)),
            aggregateFallback,
            authority: observationalScale ? 'model-observed' : 'observational',
            readinessPath: candidateBridgeReady ? 'speech-candidate-support' : (aggregateFallback ? 'aggregate' : 'concept'),
            changeClass: candidateSupport?.changeClass || null,
            requiredObservations: candidateSupport?.requiredObservations || PROFILE_DEVELOPMENT_READY_COUNT,
            supportingGroups: candidateSupport?.supportingGroups || 0,
        });
    return npc;
}

function finalizeProfileDevelopment(npc, plans, options = {}, report = null) {
    if (!plans) return npc;
    let next = npc;
    for (const field of Object.keys(PROFILE_DEVELOPMENT_FIELDS)) {
        next = finalizeProfileDevelopmentField(next, field, plans[field], options, report);
    }
    return next;
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

function insertRefreshBirthdayRule(prompt, options = {}) {
    if (!birthdayEvidenceInText(birthdayPromptSource(options))) return String(prompt);
    const calendar = getActiveCalendarConfig();
    const referenceDate = calendarReference(options, calendar).date;
    const rule = birthdayPromptRule(calendar, referenceDate);
    const source = String(prompt);
    const anchor = 'Recent story window (EVIDENCE ONLY;';
    const index = source.indexOf(anchor);
    return index >= 0 ? `${source.slice(0, index)}${rule}\n${source.slice(index)}` : `${source}${rule}`;
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
    npc.fieldChanges = normalizeFieldChanges(raw.fieldChanges);
    for (const field of Object.keys(PROFILE_DEVELOPMENT_FIELDS)) {
        const config = PROFILE_DEVELOPMENT_FIELDS[field];
        const development = profileDevelopmentForNpc(field, npc);
        if (development) npc[config.ledgerKey] = development;
    }
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
    const profilePrepared = prepareProfileDevelopmentState(state, scanResult, options);
    const sourceState = profilePrepared.state;
    const calendar = getActiveCalendarConfig();
    const reference = calendarReference(options, calendar);
    const referenceDate = reference.date;
    const previousRaw = Array.isArray(sourceState?.npcs) ? sourceState.npcs : [];
    const previous = previousRaw.map(raw => normalizeNpcBirthday(continuity.normalizeNpcRecord(raw), calendar, referenceDate));
    const profileUpdates = Array.isArray(scanResult?.profileUpdates) ? scanResult.profileUpdates
        : (Array.isArray(scanResult?.profile_updates) ? scanResult.profile_updates : []);
    const continuityOptions = { ...options, developmentSingleTarget: profileUpdates.length === 1 };
    const result = continuity.mergeScanResult(sourceState, scanResult, continuityOptions);
    const ordinary = Array.isArray(scanResult?.npcs) ? scanResult.npcs : [];
    const diagnosticNpcRegistry = (result.state.npcs || []).map(npc => structuredClone(npc));

    result.state.npcs = (result.state.npcs || []).map(rawNpc => {
        const sources = matchingPrevious(rawNpc, previous);
        const rawSources = matchingPrevious(rawNpc, previousRaw);
        const ordinaryUpdate = birthdayUpdateRow(
            ordinary.find(raw => sameNpc(raw, rawNpc)),
            profileUpdates.find(raw => sameNpc(raw, rawNpc)),
        );
        let npc = normalizeNpcBirthday(rawNpc, calendar, referenceDate);
        if (ordinaryUpdate) npc = applyNpcBirthdayUpdate(npc, ordinaryUpdate, { ...options, calendarConfig: calendar, referenceDate });
        const ageState = String(ordinaryUpdate?.ageState ?? ordinaryUpdate?.age_state ?? '').trim().toLowerCase();
        if ((ageState === 'advance' || ageState === 'correct') && npc.birthDateYearSource === 'derived'
            && sources.some(source => String(source.age) !== String(npc.age))) {
            npc = reanchorDerivedBirthYearFromAge(npc, calendar, referenceDate);
        }
        if (sources.length) npc = mergeNpcBirthdayKnowledge(sources, npc, calendar, referenceDate);

        // A grounded full current date turns a full birth date into deterministic chronology.
        // Chronological age is local arithmetic; the birthday rollover below may carry an already-numeric
        // apparent-age estimate by the same proven delta without using it to derive chronology.
        if (!(npc.manualProfileFields || []).includes('age') && !isTerminalNpcDeath(npc)
            && referenceDate && Number.isInteger(npc.calendarAge) && normalizeCalendarDate(npc.birthDate, calendar)?.year !== null
            && !(reference.fallback && /^\d+$/.test(String(npc.age)) && npc.calendarAge < Number(npc.age))) {
            npc.age = String(npc.calendarAge);
        }
        const beforeDiagnosticNpc = rawSources[0] ? normalizeNpcBirthday(continuity.normalizeNpcRecord(rawSources[0]), calendar, referenceDate) : null;
        npc = applyDeterministicBirthdayRollover(
            npc,
            rawSources[0] || null,
            ordinaryUpdate,
            options,
            calendar,
            referenceDate,
        );
        const appearanceUpdate = appearanceUpdateForNpc(scanResult, npc);
        if (beforeDiagnosticNpc) {
            // Appearance is resolved by continuity before Personality/Speech finalization. Record
            // it first so adding observability does not change legacy development-row ordering.
            recordAppearanceDiagnostic(result.report, beforeDiagnosticNpc, npc, appearanceUpdate, continuityOptions, diagnosticNpcRegistry);
        }
        npc = finalizeProfileDevelopment(npc, profilePrepared.plans.get(String(npc.id || '')), continuityOptions, result.report);
        const durableUpdate = durableUpdateForNpc(scanResult, npc);
        if (beforeDiagnosticNpc) {
            recordSecondaryProfileDiagnostics(result.report, beforeDiagnosticNpc, npc, durableUpdate, continuityOptions, diagnosticNpcRegistry);
            recordBirthdayDiagnostic(result.report, beforeDiagnosticNpc, npc, ordinaryUpdate, options, calendar, referenceDate);
        }
        const finalNpc = withAppearanceDerivedApparentAge(npc, ordinaryUpdate?.appearance || rawNpc.appearance);
        const changeBase = rawSources[0] ? normalizeNpcRecord(rawSources[0]) : null;
        return stampFieldChanges(changeBase, finalNpc, Math.trunc(Number(result.state?.turn ?? sourceState?.turn)));
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
    return insertRefreshBirthdayRule(continuity.buildProfileRefreshPrompt(calendarPromptOptions(options)), options);
}

// NPC State Delta application version. Persisted bundle, branch, and data schemas are versioned independently.
export const NPC_STATE_VERSION = '1.0.58';
