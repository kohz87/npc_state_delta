export * from './core-mechanics.js';
export * from './appearance.js';
export * from './terminal-lifecycle.js';
export * from './calendar.js';
import * as continuity from './continuity-core.js';
import * as mechanics from './core-mechanics.js';
import { isTerminalNpcDeath } from './terminal-lifecycle.js';
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
    return { ...npc, age: staleFallback ? acceptedAge : computedAge };
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

export function normalizeNpcRecord(raw = {}) {
    return normalizeNpcBirthday(continuity.normalizeNpcRecord(raw));
}

export function normalizeScanNpc(raw = {}, options = {}) {
    return { ...continuity.normalizeScanNpc(raw, options), ...normalizeScanBirthday(raw) };
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
    const calendar = getActiveCalendarConfig();
    const reference = calendarReference(options, calendar);
    const referenceDate = reference.date;
    const previous = (state?.npcs || []).map(raw => normalizeNpcBirthday(continuity.normalizeNpcRecord(raw), calendar, referenceDate));
    const result = continuity.mergeScanResult(state, scanResult, options);
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
        return npc;
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
    return appendBirthdayRule(continuity.buildScannerPrompt(calendarPromptOptions(options)), options);
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
export const NPC_STATE_VERSION = '1.0.0';
