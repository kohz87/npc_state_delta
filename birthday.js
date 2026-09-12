/* NPC State Delta deterministic birthday continuity policy. */

const BIRTH_DATE_SOURCES = Object.freeze(['generated', 'established']);
const MONTH_LENGTHS_WITH_LEAP_DAY = Object.freeze([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
const GENERATED_BIRTHDAY_YEAR = 2001;

function leapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function birthDateParts(value) {
    const text = String(value ?? '').trim();
    let match = text.match(/^(\d{1,6})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), full: true };
    match = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (match) return { year: null, month: Number(match[1]), day: Number(match[2]), full: false };
    return null;
}

function validBirthDateParts(parts) {
    if (!parts || !Number.isInteger(parts.month) || !Number.isInteger(parts.day)) return false;
    if (parts.month < 1 || parts.month > 12) return false;
    if (parts.day < 1 || parts.day > MONTH_LENGTHS_WITH_LEAP_DAY[parts.month - 1]) return false;
    if (parts.full && (!Number.isInteger(parts.year) || parts.year < 1 || parts.year > 999999)) return false;
    if (parts.full && parts.month === 2 && parts.day === 29 && !leapYear(parts.year)) return false;
    return true;
}

export function normalizeBirthDate(value) {
    const parts = birthDateParts(value);
    if (!validBirthDateParts(parts)) return '';
    const month = String(parts.month).padStart(2, '0');
    const day = String(parts.day).padStart(2, '0');
    if (!parts.full) return `${month}-${day}`;
    return `${String(parts.year).padStart(4, '0')}-${month}-${day}`;
}

export function birthDatePrecision(value) {
    const normalized = normalizeBirthDate(value);
    return normalized.length > 5 ? 'full' : (normalized ? 'month-day' : '');
}

function birthdayMonthDay(value) {
    const normalized = normalizeBirthDate(value);
    return normalized ? normalized.slice(-5) : '';
}

function stableBirthdayHash(value) {
    const text = String(value || '').normalize('NFKC').toLocaleLowerCase();
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

export function deterministicBirthday(seed) {
    const key = String(seed || '').trim();
    if (!key) return '';
    const offset = stableBirthdayHash(`npc-state-delta:birthday:v1:${key}`) % 365;
    const date = new Date(Date.UTC(GENERATED_BIRTHDAY_YEAR, 0, offset + 1));
    return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function normalizedIdentity(value) {
    return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function birthdaySeed(npc = {}) {
    const id = String(npc?.id || '').trim();
    return id || normalizedIdentity(npc?.name || '');
}

export function deriveBirthDateFromAge(birthDate, age, referenceDate) {
    const monthDay = birthdayMonthDay(birthDate);
    const ageText = String(age ?? '').trim();
    const reference = normalizeBirthDate(referenceDate);
    if (!monthDay || !/^\d{1,3}$/.test(ageText) || reference.length <= 5) return '';
    const exactAge = Number(ageText);
    const referenceParts = birthDateParts(reference);
    if (!referenceParts?.full || exactAge < 0) return '';
    const referenceMonthDay = `${String(referenceParts.month).padStart(2, '0')}-${String(referenceParts.day).padStart(2, '0')}`;
    const birthYear = referenceParts.year - exactAge - (referenceMonthDay < monthDay ? 1 : 0);
    return birthYear >= 1 ? normalizeBirthDate(`${birthYear}-${monthDay}`) : '';
}

export function normalizeBirthDateState(raw = {}) {
    const value = String(raw?.birthDateState ?? raw?.birth_date_state ?? '').trim().toLowerCase();
    if (value === 'correct' || value === 'correction') return 'correct';
    if (['establish', 'set', 'update', 'refine'].includes(value)) return 'establish';
    return 'keep';
}

export function normalizeScanBirthday(raw = {}) {
    return {
        birthDate: normalizeBirthDate(raw?.birthDate ?? raw?.birth_date ?? raw?.birthday),
        birthDateState: normalizeBirthDateState(raw),
        birthDateReason: String(raw?.birthDateReason ?? raw?.birth_date_reason ?? '').trim().slice(0, 500),
    };
}

export function normalizeNpcBirthday(npc = {}) {
    const explicit = normalizeBirthDate(npc?.birthDate ?? npc?.birth_date ?? npc?.birthday);
    if (!explicit) {
        const generated = deterministicBirthday(birthdaySeed(npc));
        return {
            ...npc,
            birthDate: generated,
            birthDateSource: generated ? 'generated' : '',
            birthDatePrecision: generated ? 'month-day' : '',
            birthDateReason: '',
            birthDateSourceMessageId: null,
        };
    }

    const rawSource = String(npc?.birthDateSource ?? npc?.birth_date_source ?? '').trim().toLowerCase();
    const source = BIRTH_DATE_SOURCES.includes(rawSource) ? rawSource : 'established';
    const rawSourceMessageId = npc?.birthDateSourceMessageId ?? npc?.birth_date_source_message_id;
    return {
        ...npc,
        birthDate: explicit,
        birthDateSource: source,
        birthDatePrecision: birthDatePrecision(explicit),
        birthDateReason: String(npc?.birthDateReason ?? npc?.birth_date_reason ?? '').trim().slice(0, 500),
        birthDateSourceMessageId: Number.isInteger(rawSourceMessageId) ? rawSourceMessageId : null,
    };
}

export function applyNpcBirthdayUpdate(npc = {}, rawUpdate = null, options = {}) {
    const next = normalizeNpcBirthday(npc);
    if (!rawUpdate || typeof rawUpdate !== 'object') return next;
    let incoming = normalizeBirthDate(rawUpdate.birthDate ?? rawUpdate.birth_date ?? rawUpdate.birthday);
    if (!incoming) return next;

    const state = normalizeBirthDateState(rawUpdate);
    const reason = String(rawUpdate.birthDateReason ?? rawUpdate.birth_date_reason ?? '').trim().slice(0, 500);
    const currentEstablished = next.birthDateSource === 'established';

    // Full-year deduction is deterministic only when a caller supplies a grounded in-world
    // reference date. The host/real-world clock is deliberately never substituted here.
    if (incoming.length === 5 && options.referenceDate) {
        incoming = deriveBirthDateFromAge(incoming, npc.age, options.referenceDate) || incoming;
    }

    const sameExactDate = normalizeBirthDate(incoming) === normalizeBirthDate(next.birthDate);
    const sameDay = birthdayMonthDay(next.birthDate) === birthdayMonthDay(incoming);
    const precisionUpgrade = sameDay && birthDatePrecision(next.birthDate) === 'month-day' && birthDatePrecision(incoming) === 'full';
    if (currentEstablished && state === 'keep' && sameExactDate) return next;

    const mayEstablish = state === 'establish'
        && (!currentEstablished || !next.birthDate || precisionUpgrade || sameExactDate);
    const mayCorrect = state === 'correct';
    if (!mayCorrect && !mayEstablish) return next;

    return {
        ...next,
        birthDate: incoming,
        birthDateSource: 'established',
        birthDatePrecision: birthDatePrecision(incoming),
        birthDateReason: reason || (sameExactDate ? next.birthDateReason : ''),
        birthDateSourceMessageId: Number.isInteger(options.sourceMessageId)
            ? options.sourceMessageId
            : next.birthDateSourceMessageId,
    };
}

export function mergeNpcBirthdayKnowledge(sources = [], current = {}) {
    const next = normalizeNpcBirthday(current);
    if (next.birthDateSource === 'established') return next;
    const established = (Array.isArray(sources) ? sources : [])
        .map(normalizeNpcBirthday)
        .find(source => source.birthDateSource === 'established' && source.birthDate);
    if (!established) return next;
    return {
        ...next,
        birthDate: established.birthDate,
        birthDateSource: 'established',
        birthDatePrecision: established.birthDatePrecision,
        birthDateReason: established.birthDateReason,
        birthDateSourceMessageId: established.birthDateSourceMessageId,
    };
}

export function birthdayEvidenceInText(value) {
    return /\b(birth(?:day|date)?|born|hatched|turn(?:s|ed|ing)?\s+\d{1,3}|date\s+of\s+birth)\b/i.test(String(value || ''));
}

export const BIRTHDAY_PROMPT_RULE = `\nBIRTHDAY: Only grounded birthday/birth-date evidence may return birthDate:"MM-DD|YYYY-MM-DD" with birthDateState:"establish|correct" and a brief birthDateReason; omit otherwise. A full year may be derived only from grounded chronological age plus a grounded current story date. Never derive from apparentAge, species, or lifespan and never invent a random date; Delta generates the fallback locally.`;
