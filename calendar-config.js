/* NPC State Delta calendar configuration: month parsing, normalization, the active calendar and the
   Story Suite external/cached calendar source. Split from calendar.js as a line-for-line part; the
   original keeps the public exports. */

export const MAX_CALENDAR_MONTHS = 64;
export const MAX_CALENDAR_DAYS_PER_MONTH = 999;
export const LEGACY_NUMERIC_CALENDAR_ID = 'legacy-numeric-v1';

let activeCalendarConfig = null;

export function cleanText(value, max = 120) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeMonthKey(value) {
    return cleanText(value, 80).normalize('NFKC').toLocaleLowerCase();
}

export function parseInteger(value) {
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

// While another extension owns the calendar (Story Suite), its months and era replace Delta's
// own; Delta's manual fallback clock is kept when it fits them. A missing, throwing or invalid
// source leaves Delta's own calendar in effect. Without a source nothing here runs.
let externalCalendarSource = null;
let externalCalendarCache = { key: '', local: null, config: null };

export function setExternalCalendarSource(source = null) {
    externalCalendarSource = typeof source === 'function' ? source : null;
    externalCalendarCache = { key: '', local: null, config: null };
}

function externalCalendarConfig() {
    if (!externalCalendarSource) return null;
    let raw = null;
    let key = '';
    try {
        raw = externalCalendarSource();
        if (!raw || typeof raw !== 'object') return null;
        key = JSON.stringify({ era: raw.era ?? '', months: raw.months ?? null });
    } catch {
        return null;
    }
    if (key === externalCalendarCache.key && externalCalendarCache.local === activeCalendarConfig) return externalCalendarCache.config;
    const local = activeCalendarConfig;
    const shared = { era: raw.era ?? '', months: raw.months };
    const withClock = normalizeCalendarConfig({ ...shared, currentYear: local?.currentYear, currentMonth: local?.currentMonth, currentDay: local?.currentDay });
    const normalized = withClock.valid ? withClock : normalizeCalendarConfig(shared);
    const config = normalized.valid ? Object.freeze({
        ...normalized.config,
        months: Object.freeze(normalized.config.months.map(month => Object.freeze({ ...month }))),
    }) : null;
    externalCalendarCache = { key, local, config };
    return config;
}

export function getActiveCalendarConfig() {
    return externalCalendarConfig() || activeCalendarConfig;
}
