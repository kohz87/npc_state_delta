/* NPC State Delta deterministic fantasy-calendar primitives. */

export const MAX_CALENDAR_MONTHS = 64;
export const MAX_CALENDAR_DAYS_PER_MONTH = 999;
export const LEGACY_NUMERIC_CALENDAR_ID = 'legacy-numeric-v1';

let activeCalendarConfig = null;

function cleanText(value, max = 120) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeMonthKey(value) {
    return cleanText(value, 80).normalize('NFKC').toLocaleLowerCase();
}

function parseInteger(value) {
    const text = String(value ?? '').trim();
    if (!/^-?\d{1,7}$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && Math.abs(number) <= 999999 ? number : null;
}

function normalizedMonthsFromArray(value) {
    if (!Array.isArray(value)) return { months: [], errors: [] };
    const errors = [];
    const months = [];
    const seen = new Set();
    for (const raw of value.slice(0, MAX_CALENDAR_MONTHS + 1)) {
        const name = cleanText(raw?.name ?? raw?.month, 80);
        const days = Number(raw?.days ?? raw?.endDay ?? raw?.end_day);
        const key = normalizeMonthKey(name);
        if (!name) { errors.push('Month name cannot be blank.'); continue; }
        if (!Number.isInteger(days) || days < 1 || days > MAX_CALENDAR_DAYS_PER_MONTH) {
            errors.push(`${name}: days must be an integer from 1 to ${MAX_CALENDAR_DAYS_PER_MONTH}.`);
            continue;
        }
        if (seen.has(key)) { errors.push(`Duplicate month name: ${name}.`); continue; }
        seen.add(key);
        months.push({ name, days });
    }
    if (value.length > MAX_CALENDAR_MONTHS) errors.push(`Calendar supports at most ${MAX_CALENDAR_MONTHS} months.`);
    return { months, errors };
}

export function parseMonthDefinitions(value) {
    if (Array.isArray(value)) return normalizedMonthsFromArray(value);
    const text = String(value ?? '').replace(/\r/g, '');
    if (!text.trim()) return { months: [], errors: ['At least one month is required.'] };
    const rows = text.split('\n').map(row => row.trim()).filter(Boolean);
    const parsed = [];
    const errors = [];
    for (const row of rows.slice(0, MAX_CALENDAR_MONTHS + 1)) {
        const match = row.match(/^([^:]+?)\s*:\s*(\d{1,4})$/);
        if (!match) {
            errors.push(`Invalid month row: ${row}. Use Month name:days.`);
            continue;
        }
        parsed.push({ name: match[1].trim(), days: Number(match[2]) });
    }
    if (rows.length > MAX_CALENDAR_MONTHS) errors.push(`Calendar supports at most ${MAX_CALENDAR_MONTHS} months.`);
    const normalized = normalizedMonthsFromArray(parsed);
    return { months: normalized.months, errors: [...errors, ...normalized.errors] };
}

export function monthDefinitionsText(months = []) {
    return normalizedMonthsFromArray(months).months.map(month => `${month.name}:${month.days}`).join('\n');
}

export function calendarFingerprint(config = null) {
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (!normalized.calendarValid) return LEGACY_NUMERIC_CALENDAR_ID;
    return [`era:${normalizeMonthKey(normalized.config.era)}`, ...normalized.config.months
        .map(month => `${normalizeMonthKey(month.name)}:${month.days}`)]
        .join('|');
}

export function calendarYearLength(config = null) {
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (!normalized.calendarValid) return 365;
    return normalized.config.months.reduce((total, month) => total + month.days, 0);
}

export function normalizeCalendarConfig(raw = {}, { requireCurrentDate = false } = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const monthSource = source.months ?? source.monthDefinitions ?? source.month_definitions ?? source.monthsText ?? source.months_text;
    const parsed = parseMonthDefinitions(monthSource);
    const errors = [...parsed.errors];
    const calendarValid = parsed.months.length > 0 && parsed.errors.length === 0;

    const era = cleanText(source.era, 40);
    const yearRaw = source.currentYear ?? source.current_year ?? source.year;
    const monthRaw = source.currentMonth ?? source.current_month ?? source.month;
    const dayRaw = source.currentDay ?? source.current_day ?? source.day;
    const yearProvided = yearRaw !== null && yearRaw !== undefined && String(yearRaw).trim() !== '';
    const requestedMonth = cleanText(monthRaw, 80);
    const monthProvided = Boolean(requestedMonth);
    const dayProvided = dayRaw !== null && dayRaw !== undefined && String(dayRaw).trim() !== '';
    const anyCurrentDatePart = yearProvided || monthProvided || dayProvided;

    const currentYear = yearProvided ? parseInteger(yearRaw) : null;
    const requestedMonthKey = normalizeMonthKey(requestedMonth);
    const currentMonthRecord = parsed.months.find(month => normalizeMonthKey(month.name) === requestedMonthKey) || null;
    const currentDayRaw = dayProvided ? Number(dayRaw) : null;
    const currentDay = Number.isInteger(currentDayRaw) ? currentDayRaw : null;

    if (requireCurrentDate || anyCurrentDatePart) {
        if (!yearProvided) errors.push('Current year is required when a manual current date is set.');
        else if (currentYear === null) errors.push('Current year must be an integer.');
        if (!requestedMonth) errors.push('Current month is required when a manual current date is set.');
        else if (calendarValid && !currentMonthRecord) errors.push(`Current month is not in the configured month list: ${requestedMonth}.`);
        if (!dayProvided) errors.push('Current day is required when a manual current date is set.');
        else if (currentDay === null) errors.push('Current day must be an integer.');
        else if (currentMonthRecord && (currentDay < 1 || currentDay > currentMonthRecord.days)) {
            errors.push(`${currentMonthRecord.name} has days 1-${currentMonthRecord.days}; ${currentDay} is invalid.`);
        }
    }

    const currentDateValid = calendarValid
        && currentYear !== null
        && Boolean(currentMonthRecord)
        && currentDay !== null
        && currentDay >= 1
        && currentDay <= currentMonthRecord.days;

    return {
        valid: calendarValid && errors.length === 0 && (!requireCurrentDate || currentDateValid),
        calendarValid,
        currentDateValid,
        currentDateConfigured: anyCurrentDatePart,
        errors,
        config: {
            era,
            currentYear,
            currentMonth: currentMonthRecord?.name || requestedMonth,
            currentDay,
            months: parsed.months,
        },
    };
}

export function setActiveCalendarConfig(raw = null) {
    if (!raw) {
        activeCalendarConfig = null;
        return null;
    }
    const normalized = normalizeCalendarConfig(raw, { requireCurrentDate: false });
    activeCalendarConfig = normalized.valid ? Object.freeze({
        ...normalized.config,
        months: Object.freeze(normalized.config.months.map(month => Object.freeze({ ...month }))),
    }) : null;
    return activeCalendarConfig;
}

export function getActiveCalendarConfig() {
    return activeCalendarConfig;
}

function legacyLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function legacyMonthDays(month, year = null) {
    const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month === 2 && year !== null && legacyLeapYear(year)) return 29;
    if (month === 2 && year === null) return 29;
    return days[month - 1] || 0;
}

function normalizeDateObject(value, config = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const era = cleanText(value.era, 40);
    const yearRaw = value.year;
    const year = yearRaw === null || yearRaw === undefined || yearRaw === '' ? null : parseInteger(yearRaw);
    const month = cleanText(value.month, 80);
    const day = Number(value.day);
    if (!month || !Number.isInteger(day) || day < 1 || day > MAX_CALENDAR_DAYS_PER_MONTH) return null;
    if (yearRaw !== null && yearRaw !== undefined && yearRaw !== '' && year === null) return null;

    const normalizedConfig = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (normalizedConfig.calendarValid) {
        const monthRecord = normalizedConfig.config.months.find(item => normalizeMonthKey(item.name) === normalizeMonthKey(month));
        if (!monthRecord || day > monthRecord.days) return null;
        return { era, year, month: monthRecord.name, day };
    }

    if (/^\d{1,2}$/.test(month)) {
        const monthNumber = Number(month);
        if (monthNumber < 1 || monthNumber > 12 || day > legacyMonthDays(monthNumber, year)) return null;
        return { era, year, month: String(monthNumber).padStart(2, '0'), day };
    }
    return { era, year, month, day };
}

function parseConfiguredMonthDay(text, config) {
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (!normalized.calendarValid) return null;
    const sorted = [...normalized.config.months].sort((a, b) => b.name.length - a.name.length);
    const lower = text.toLocaleLowerCase();
    for (const month of sorted) {
        const name = month.name.toLocaleLowerCase();
        if (!lower.startsWith(name)) continue;
        const rest = text.slice(month.name.length).trim().replace(/^[:\-/]\s*/, '');
        if (!/^\d{1,4}$/.test(rest)) continue;
        const day = Number(rest);
        if (day < 1 || day > month.days) return null;
        return { month: month.name, day };
    }
    return null;
}

function parseYearLabel(value, config = null) {
    const text = cleanText(value, 80);
    if (!text) return { era: '', year: null };
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    const configuredEra = normalized.config.era;
    if (configuredEra && text.toLocaleLowerCase().startsWith(configuredEra.toLocaleLowerCase())) {
        const year = parseInteger(text.slice(configuredEra.length));
        if (year !== null) return { era: configuredEra, year };
    }
    const bare = parseInteger(text);
    if (bare !== null) return { era: configuredEra || '', year: bare };
    const match = text.match(/^(.*?)(-?\d{1,7})$/);
    if (!match) return { era: '', year: null };
    const year = parseInteger(match[2]);
    return year === null ? { era: '', year: null } : { era: cleanText(match[1], 40), year };
}

function escapeRegex(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeCalendarDate(value, config = null) {
    const fromObject = normalizeDateObject(value, config);
    if (fromObject) return fromObject;
    const text = cleanText(value, 180);
    if (!text) return null;

    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (normalized.calendarValid) {
        const comma = text.lastIndexOf(',');
        if (comma >= 0) {
            const datePart = parseConfiguredMonthDay(text.slice(comma + 1).trim(), normalized.config);
            const yearPart = parseYearLabel(text.slice(0, comma).trim(), normalized.config);
            if (datePart && yearPart.year !== null) return { ...yearPart, ...datePart };
        }
        const sorted = [...normalized.config.months].sort((a, b) => b.name.length - a.name.length);
        for (const month of sorted) {
            const match = text.match(new RegExp(`^(.*?)\\s*,?\\s*${escapeRegex(month.name)}\\s+(\\d{1,4})$`, 'iu'));
            if (!match) continue;
            const yearPart = parseYearLabel(match[1].trim(), normalized.config);
            const day = Number(match[2]);
            if (yearPart.year !== null && day >= 1 && day <= month.days) return { ...yearPart, month: month.name, day };
        }
        const datePart = parseConfiguredMonthDay(text, normalized.config);
        if (datePart) return { era: '', year: null, ...datePart };
        return null;
    }

    let match = text.match(/^(-?\d{1,7})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (match) return normalizeDateObject({ year: match[1], month: match[2], day: Number(match[3]) }, null);
    match = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (match) return normalizeDateObject({ year: null, month: match[1], day: Number(match[2]) }, null);
    return normalizeDateObject(value, null);
}

export function formatCalendarDate(value, config = null) {
    const date = normalizeCalendarDate(value, config);
    if (!date) return '';
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (!normalized.calendarValid && /^\d{2}$/.test(date.month)) {
        const md = `${date.month}-${String(date.day).padStart(2, '0')}`;
        return date.year === null ? md : `${String(date.year).padStart(4, '0')}-${md}`;
    }
    const monthDay = `${date.month} ${date.day}`;
    if (date.year === null) return monthDay;
    const era = date.era || normalized.config.era || '';
    return `${era}${date.year}, ${monthDay}`;
}

function dateOrdinal(value, config = null) {
    const date = normalizeCalendarDate(value, config);
    if (!date) return null;
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (normalized.calendarValid) {
        let ordinal = 0;
        for (const month of normalized.config.months) {
            if (normalizeMonthKey(month.name) === normalizeMonthKey(date.month)) return ordinal + date.day - 1;
            ordinal += month.days;
        }
        return null;
    }
    if (!/^\d{2}$/.test(date.month)) return null;
    const monthNumber = Number(date.month);
    let ordinal = 0;
    for (let month = 1; month < monthNumber; month += 1) ordinal += legacyMonthDays(month, date.year);
    return ordinal + date.day - 1;
}

function stableHash(value) {
    const text = String(value || '').normalize('NFKC').toLocaleLowerCase();
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

export function deterministicCalendarBirthday(seed, config = null) {
    const key = String(seed || '').trim();
    if (!key) return null;
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    const hash = stableHash(`npc-state-delta:birthday:v1:${key}`);
    if (!normalized.calendarValid) {
        const offset = hash % 365;
        let remaining = offset;
        for (let month = 1; month <= 12; month += 1) {
            const days = legacyMonthDays(month, 2001);
            if (remaining < days) return { era: '', year: null, month: String(month).padStart(2, '0'), day: remaining + 1 };
            remaining -= days;
        }
        return { era: '', year: null, month: '12', day: 31 };
    }

    let remaining = hash % calendarYearLength(normalized.config);
    for (const month of normalized.config.months) {
        if (remaining < month.days) return { era: '', year: null, month: month.name, day: remaining + 1 };
        remaining -= month.days;
    }
    const last = normalized.config.months.at(-1);
    return last ? { era: '', year: null, month: last.name, day: last.days } : null;
}

export function currentCalendarDate(config = null) {
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (!normalized.valid || !normalized.currentDateValid) return null;
    return {
        era: normalized.config.era,
        year: normalized.config.currentYear,
        month: normalized.config.currentMonth,
        day: normalized.config.currentDay,
    };
}

function worldStateBodies(value) {
    const source = String(value || '');
    const bodies = [];
    for (const match of source.matchAll(/<World_State\b[^>]*>([\s\S]*?)<\/World_State>/gi)) bodies.push(String(match[1] || ''));
    for (const details of source.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)) {
        const inner = String(details[1] || '');
        const summary = String(inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/\bworld\s*state\b/i.test(summary)) bodies.push(inner);
    }
    return bodies;
}

function dateCandidatesInWorldStateBody(body, config = null) {
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    const text = String(body || '').replace(/<[^>]+>/g, ' ');
    const candidates = [];
    if (normalized.calendarValid) {
        const months = [...normalized.config.months].sort((a, b) => b.name.length - a.name.length);
        const monthAlternation = months.map(month => escapeRegex(month.name)).join('|');
        const era = normalized.config.era;
        const yearLabel = era
            ? `${escapeRegex(era)}\\s*-?\\d{1,7}`
            : `(?:[\\p{L}][\\p{L}\\p{N}_-]{0,15})?-?\\d{1,7}`;
        const regex = new RegExp(`(${yearLabel}\\s*,?\\s*(?:${monthAlternation})\\s+\\d{1,4})`, 'giu');
        for (const match of text.matchAll(regex)) candidates.push(match[1]);
    } else {
        for (const match of text.matchAll(/(-?\d{1,7}[-/]\d{1,2}[-/]\d{1,2})/g)) candidates.push(match[1]);
    }
    return candidates;
}

export function extractStructuredWorldDate(value, config = null) {
    let latest = null;
    for (const body of worldStateBodies(value)) {
        for (const raw of dateCandidatesInWorldStateBody(body, config)) {
            const date = normalizeCalendarDate(raw, config);
            if (!date || date.year === null) continue;
            latest = { raw: cleanText(raw, 180), date, source: 'world-state' };
        }
    }
    return latest;
}

export function deriveBirthDateFromAgeParts(birthDate, age, referenceDate = null, config = null) {
    const date = normalizeCalendarDate(birthDate, config);
    const current = normalizeCalendarDate(referenceDate || currentCalendarDate(config), config);
    const ageText = String(age ?? '').trim();
    if (!date || !current || current.year === null || !/^\d{1,3}$/.test(ageText)) return null;
    const exactAge = Number(ageText);
    if (date.era && current.era && normalizeMonthKey(date.era) !== normalizeMonthKey(current.era)) return null;
    const birthdayOrdinal = dateOrdinal(date, config);
    const currentOrdinal = dateOrdinal(current, config);
    if (birthdayOrdinal === null || currentOrdinal === null || exactAge < 0) return null;
    const year = current.year - exactAge - (currentOrdinal < birthdayOrdinal ? 1 : 0);
    return { ...date, era: date.era || current.era || normalizeCalendarConfig(config, { requireCurrentDate: false }).config.era, year };
}

export function deriveAgeFromBirthDate(birthDate, referenceDate = null, config = null) {
    const date = normalizeCalendarDate(birthDate, config);
    const current = normalizeCalendarDate(referenceDate || currentCalendarDate(config), config);
    if (!date || date.year === null || !current || current.year === null) return null;
    if (date.era && current.era && normalizeMonthKey(date.era) !== normalizeMonthKey(current.era)) return null;
    const birthdayOrdinal = dateOrdinal(date, config);
    const currentOrdinal = dateOrdinal(current, config);
    if (birthdayOrdinal === null || currentOrdinal === null) return null;
    const age = current.year - date.year - (currentOrdinal < birthdayOrdinal ? 1 : 0);
    return Number.isInteger(age) && age >= 0 ? age : null;
}

export function calendarPromptContext(config = null, referenceDate = null) {
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (!normalized.calendarValid) return '';
    const current = normalizeCalendarDate(referenceDate, normalized.config) || currentCalendarDate(normalized.config);
    return current ? `Current grounded world date=${formatCalendarDate(current, normalized.config)}.` : '';
}
