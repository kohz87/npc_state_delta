/* NPC State Delta deterministic birthday continuity policy. */
import {
    calendarFingerprint,
    calendarPromptContext,
    currentCalendarDate,
    deriveAgeFromBirthDate,
    deriveBirthDateFromAgeParts,
    deterministicCalendarBirthday,
    formatCalendarDate,
    getActiveCalendarConfig,
    normalizeCalendarConfig,
    normalizeCalendarDate,
} from './calendar.js';

const BIRTH_DATE_SOURCES = Object.freeze(['generated', 'established']);
const BIRTH_YEAR_SOURCES = Object.freeze(['', 'derived', 'established']);

function activeOrProvided(config = undefined) {
    return config === undefined ? getActiveCalendarConfig() : config;
}

function normalizedIdentity(value) {
    return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function birthdaySeed(npc = {}) {
    const id = String(npc?.id || '').trim();
    return id || normalizedIdentity(npc?.name || '');
}

function sameDate(a, b, config = null) {
    const left = normalizeCalendarDate(a, config);
    const right = normalizeCalendarDate(b, config);
    if (!left || !right) return false;
    return String(left.era || '') === String(right.era || '')
        && left.year === right.year
        && normalizedIdentity(left.month) === normalizedIdentity(right.month)
        && left.day === right.day;
}

function sameMonthDay(a, b, config = null) {
    const left = normalizeCalendarDate(a, config);
    const right = normalizeCalendarDate(b, config);
    if (!left || !right) return false;
    return normalizedIdentity(left.month) === normalizedIdentity(right.month) && left.day === right.day;
}

function exactAge(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,3}$/.test(text) ? Number(text) : null;
}

export function normalizeBirthDate(value, config = undefined) {
    return normalizeCalendarDate(value, activeOrProvided(config));
}

function normalizeStoredBirthDate(value, config = undefined) {
    const calendar = activeOrProvided(config);
    return normalizeCalendarDate(value, calendar) || normalizeCalendarDate(value, null);
}

export function formatBirthDate(value, config = undefined) {
    const calendar = activeOrProvided(config);
    const normalized = normalizeCalendarDate(value, calendar) || normalizeCalendarDate(value, null);
    if (!normalized) return '';
    return formatCalendarDate(normalized, normalizeCalendarDate(value, calendar) ? calendar : null);
}

export function birthDatePrecision(value, config = undefined) {
    const normalized = normalizeBirthDate(value, config);
    return normalized ? (normalized.year === null ? 'month-day' : 'full') : '';
}

export function deterministicBirthday(seed, config = undefined) {
    return deterministicCalendarBirthday(seed, activeOrProvided(config));
}

export function deriveBirthDateFromAge(birthDate, age, referenceDate = null, config = undefined) {
    return deriveBirthDateFromAgeParts(birthDate, age, referenceDate, activeOrProvided(config));
}

export function normalizeBirthDateState(raw = {}) {
    const value = String(raw?.birthDateState ?? raw?.birth_date_state ?? '').trim().toLowerCase();
    if (value === 'correct' || value === 'correction') return 'correct';
    if (['establish', 'set', 'update', 'refine'].includes(value)) return 'establish';
    return 'keep';
}

export function normalizeScanBirthday(raw = {}, config = undefined) {
    return {
        birthDate: normalizeBirthDate(raw?.birthDate ?? raw?.birth_date ?? raw?.birthday, config),
        birthDateState: normalizeBirthDateState(raw),
        birthDateReason: String(raw?.birthDateReason ?? raw?.birth_date_reason ?? '').trim().slice(0, 500),
    };
}

function generatedBirthdayFor(npc = {}, config = undefined) {
    const calendar = activeOrProvided(config);
    const generated = deterministicBirthday(birthdaySeed(npc), calendar);
    return {
        birthDate: generated,
        birthDateSource: generated ? 'generated' : '',
        birthDatePrecision: generated ? 'month-day' : '',
        birthDateYearSource: '',
        birthDateCalendarFingerprint: generated ? calendarFingerprint(calendar) : '',
        birthDateReason: '',
        birthDateSourceMessageId: null,
    };
}

function calculateCalendarAge(npc = {}, config = undefined) {
    const calendar = activeOrProvided(config);
    const age = deriveAgeFromBirthDate(npc.birthDate, currentCalendarDate(calendar), calendar);
    return Number.isInteger(age) ? age : null;
}

function anchorMissingBirthYear(npc = {}, config = undefined) {
    const calendar = activeOrProvided(config);
    const current = currentCalendarDate(calendar);
    const age = exactAge(npc.age);
    const date = normalizeBirthDate(npc.birthDate, calendar);
    if (!current || age === null || !date || date.year !== null) return npc;
    const derived = deriveBirthDateFromAge(date, String(age), current, calendar);
    if (!derived) return npc;
    return {
        ...npc,
        birthDate: derived,
        birthDatePrecision: 'full',
        birthDateYearSource: 'derived',
    };
}

export function normalizeNpcBirthday(npc = {}, config = undefined) {
    const calendar = activeOrProvided(config);
    const rawDate = normalizeStoredBirthDate(npc?.birthDate ?? npc?.birth_date ?? npc?.birthday, calendar);
    const rawSource = String(npc?.birthDateSource ?? npc?.birth_date_source ?? '').trim().toLowerCase();
    const source = BIRTH_DATE_SOURCES.includes(rawSource) ? rawSource : (rawDate ? 'established' : '');
    const storedFingerprint = String(npc?.birthDateCalendarFingerprint ?? npc?.birth_date_calendar_fingerprint ?? '').trim();
    const activeFingerprint = calendarFingerprint(calendar);

    let next;
    if (!rawDate) {
        next = { ...npc, ...generatedBirthdayFor(npc, calendar) };
    } else if (source === 'generated' && storedFingerprint && storedFingerprint !== activeFingerprint) {
        // Generated dates belong to the configured calendar. A deliberate calendar change
        // deterministically remaps them; established story dates are never remapped this way.
        next = { ...npc, ...generatedBirthdayFor(npc, calendar) };
    } else {
        const rawYearSource = String(npc?.birthDateYearSource ?? npc?.birth_date_year_source ?? '').trim().toLowerCase();
        let yearSource = BIRTH_YEAR_SOURCES.includes(rawYearSource) ? rawYearSource : '';
        if (rawDate.year !== null && !yearSource) yearSource = source === 'established' ? 'established' : 'derived';
        const rawSourceMessageId = npc?.birthDateSourceMessageId ?? npc?.birth_date_source_message_id;
        next = {
            ...npc,
            birthDate: rawDate,
            birthDateSource: source || 'established',
            birthDatePrecision: rawDate.year === null ? 'month-day' : 'full',
            birthDateYearSource: yearSource,
            birthDateCalendarFingerprint: storedFingerprint || activeFingerprint,
            birthDateReason: String(npc?.birthDateReason ?? npc?.birth_date_reason ?? '').trim().slice(0, 500),
            birthDateSourceMessageId: Number.isInteger(rawSourceMessageId) ? rawSourceMessageId : null,
        };
    }

    next = anchorMissingBirthYear(next, calendar);
    const calendarAge = calculateCalendarAge(next, calendar);
    next.calendarAge = calendarAge;
    next.birthDateDisplay = formatBirthDate(next.birthDate, calendar);
    return next;
}

export function effectiveChronologicalAge(npc = {}, config = undefined) {
    const normalized = normalizeNpcBirthday(npc, config);
    return Number.isInteger(normalized.calendarAge) ? String(normalized.calendarAge) : String(normalized.age ?? '').trim();
}

export function reanchorDerivedBirthYearFromAge(npc = {}, config = undefined) {
    const calendar = activeOrProvided(config);
    const next = normalizeNpcBirthday(npc, calendar);
    if (next.birthDateYearSource !== 'derived' || exactAge(next.age) === null || !currentCalendarDate(calendar)) return next;
    const partial = { ...next.birthDate, year: null };
    const derived = deriveBirthDateFromAge(partial, next.age, currentCalendarDate(calendar), calendar);
    if (!derived) return next;
    return normalizeNpcBirthday({
        ...next,
        birthDate: derived,
        birthDatePrecision: 'full',
        birthDateYearSource: 'derived',
    }, calendar);
}

export function applyNpcBirthdayUpdate(npc = {}, rawUpdate = null, options = {}) {
    const calendar = options.calendarConfig ?? getActiveCalendarConfig();
    const next = normalizeNpcBirthday(npc, calendar);
    if (!rawUpdate || typeof rawUpdate !== 'object') return next;
    let incoming = normalizeBirthDate(rawUpdate.birthDate ?? rawUpdate.birth_date ?? rawUpdate.birthday, calendar);
    if (!incoming) return next;

    const state = normalizeBirthDateState(rawUpdate);
    if (state !== 'establish' && state !== 'correct') return next;
    const reason = String(rawUpdate.birthDateReason ?? rawUpdate.birth_date_reason ?? '').trim().slice(0, 500);
    const currentEstablished = next.birthDateSource === 'established';

    let incomingYearSource = incoming.year === null ? '' : 'established';
    if (incoming.year === null && currentCalendarDate(calendar) && exactAge(npc.age) !== null) {
        const derived = deriveBirthDateFromAge(incoming, npc.age, currentCalendarDate(calendar), calendar);
        if (derived) {
            incoming = derived;
            incomingYearSource = 'derived';
        }
    }

    const exactMatch = sameDate(incoming, next.birthDate, calendar);
    const sameDay = sameMonthDay(incoming, next.birthDate, calendar);
    const existingHasYear = normalizeBirthDate(next.birthDate, calendar)?.year !== null;
    const incomingHasYear = incoming.year !== null;
    const authorityUpgrade = sameDay
        && incomingHasYear
        && (!existingHasYear || next.birthDateYearSource === 'derived')
        && incomingYearSource === 'established';

    const mayEstablish = state === 'establish'
        && (!currentEstablished || !next.birthDate || authorityUpgrade || exactMatch);
    const mayCorrect = state === 'correct';
    if (!mayCorrect && !mayEstablish) return next;

    return normalizeNpcBirthday({
        ...next,
        birthDate: incoming,
        birthDateSource: 'established',
        birthDatePrecision: incoming.year === null ? 'month-day' : 'full',
        birthDateYearSource: incomingYearSource,
        birthDateCalendarFingerprint: calendarFingerprint(calendar),
        birthDateReason: reason || (exactMatch ? next.birthDateReason : ''),
        birthDateSourceMessageId: Number.isInteger(options.sourceMessageId)
            ? options.sourceMessageId
            : next.birthDateSourceMessageId,
    }, calendar);
}

export function mergeNpcBirthdayKnowledge(sources = [], current = {}, config = undefined) {
    const calendar = activeOrProvided(config);
    const next = normalizeNpcBirthday(current, calendar);
    if (next.birthDateSource === 'established') return next;
    const established = (Array.isArray(sources) ? sources : [])
        .map(source => normalizeNpcBirthday(source, calendar))
        .find(source => source.birthDateSource === 'established' && source.birthDate);
    if (!established) return next;
    return normalizeNpcBirthday({
        ...next,
        birthDate: established.birthDate,
        birthDateSource: 'established',
        birthDatePrecision: established.birthDatePrecision,
        birthDateYearSource: established.birthDateYearSource,
        birthDateCalendarFingerprint: established.birthDateCalendarFingerprint,
        birthDateReason: established.birthDateReason,
        birthDateSourceMessageId: established.birthDateSourceMessageId,
    }, calendar);
}

export function birthdayEvidenceInText(value) {
    return /\b(birth(?:day|date)?|born|hatched|turn(?:s|ed|ing)?\s+\d{1,3}|date\s+of\s+birth)\b/i.test(String(value || ''));
}

export function birthdayPromptRule(config = undefined) {
    const calendar = activeOrProvided(config);
    const context = calendarPromptContext(calendar);
    if (!context) {
        return `\nBIRTHDAY: Only grounded birthday/birth-date evidence may return birthDate:"MM-DD|YYYY-MM-DD" with birthDateState:"establish|correct" and a brief birthDateReason; omit otherwise. Never derive from apparentAge, species, or lifespan and never invent a random date; Delta generates the fallback locally.`;
    }
    return `\nBIRTHDAY: ${context} Preserve configured era/month names exactly. Only grounded birthday/birth-date evidence may return birthDate:{"era":"${normalizeCalendarConfig(calendar).config.era || ''}","year":number|null,"month":"configured month name","day":number} with birthDateState:"establish|correct" and a brief birthDateReason; omit otherwise. Bind words such as today to the configured current date, but do not invent missing birthday evidence. Never derive chronology from apparentAge, species, or lifespan; Delta performs calendar arithmetic locally.`;
}

export const BIRTHDAY_PROMPT_RULE = birthdayPromptRule(null);
