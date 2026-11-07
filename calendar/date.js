/* NPC State Delta calendar date parsing and arithmetic: Gregorian/custom date normalization,
   ordinals, absolute day numbers, legacy story-day migration and the current calendar date.
   Split from calendar.js as a line-for-line part; the original keeps the public exports. */

import { calendarYearLength, cleanText, getActiveCalendarConfig, MAX_CALENDAR_DAYS_PER_MONTH, normalizeCalendarConfig, normalizeMonthKey, parseInteger } from './config.js';

export function legacyLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function legacyMonthDays(month, year = null) {
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

export function escapeRegex(value) {
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

export function dateOrdinal(value, config = null) {
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
    for (let month = 1; month < monthNumber; month += 1) ordinal += legacyMonthDays(month, null);
    return ordinal + date.day - 1;
}

// Numeric fallback dates are Gregorian: real leap days are counted, so consecutive dates (Dec 31 to
// Jan 1, non-leap Feb 28 to Mar 1) are exactly one day apart.
function gregorianDayNumber(year, monthNumber, day) {
    const prior = year - 1;
    let days = 365 * year + Math.floor(prior / 4) - Math.floor(prior / 100) + Math.floor(prior / 400);
    for (let month = 1; month < monthNumber; month += 1) days += legacyMonthDays(month, year);
    return days + day - 1;
}

// Stored story days carry STORY_DAY_SCHEME once written by the Gregorian numeric arithmetic. Before
// it, numeric fallback days were year*365 plus a 366-day ordinal; such an unmarked value is converted
// (to within the old formula's own one-day collisions) so spans never mix the two numberings. A
// configured calendar's numbering is unchanged and passes through.
export const STORY_DAY_SCHEME = 2;

export function migrateLegacyStoryDay(value, config = getActiveCalendarConfig()) {
    const day = Number(value);
    if (!Number.isInteger(day)) return null;
    if (normalizeCalendarConfig(config, { requireCurrentDate: false }).calendarValid) return day;
    const year = Math.floor(day / 365);
    let ordinal = day - year * 365;
    let month = 1;
    while (month < 12 && ordinal >= legacyMonthDays(month, null)) {
        ordinal -= legacyMonthDays(month, null);
        month += 1;
    }
    // The old ordinal always reserved Feb 29; in a common year that slot is Mar 1's predecessor.
    if (month === 2 && ordinal === 28 && !legacyLeapYear(year)) return gregorianDayNumber(year, 3, 1) - 1;
    return gregorianDayNumber(year, month, ordinal + 1);
}

// Absolute day count for a dated calendar value, so two story dates can be compared as elapsed
// days. Undated or yearless values return null; the caller then falls back to turns.
export function calendarDayNumber(value, config = null) {
    const date = normalizeCalendarDate(value, config);
    if (!date || date.year === null) return null;
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    if (!normalized.calendarValid) {
        if (!/^\d{2}$/.test(date.month)) return null;
        return gregorianDayNumber(Number(date.year), Number(date.month), date.day);
    }
    const ordinal = dateOrdinal(date, config);
    if (ordinal === null) return null;
    const yearLength = calendarYearLength(config);
    return yearLength > 0 ? date.year * yearLength + ordinal : null;
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
