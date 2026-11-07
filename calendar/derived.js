/* NPC State Delta calendar-derived values: deterministic birthdays, structured World State dates,
   age/birth-date derivation and the prompt date context. Split from calendar.js as a line-for-line
   part; the original keeps the public exports. */

import { calendarYearLength, cleanText, normalizeCalendarConfig, normalizeMonthKey } from './config.js';
import { storyCurrentDate } from './clock.js';
import { dateOrdinal, escapeRegex, formatCalendarDate, legacyMonthDays, normalizeCalendarDate } from './date.js';

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

function worldStateBodies(value) {
    const source = String(value || '');
    const bodies = [];
    for (const match of source.matchAll(/<World_State\b[^>]*>([\s\S]*?)<\/World_State>/gi)) bodies.push({ index: match.index, body: String(match[1] || '') });
    for (const details of source.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)) {
        const inner = String(details[1] || '');
        const summary = String(inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/\bworld\s*state\b/i.test(summary)) bodies.push({ index: details.index, body: inner });
    }
    return bodies.sort((a, b) => a.index - b.index).map(item => item.body);
}

function dateCandidatesInWorldStateBody(body, config = null) {
    const normalized = normalizeCalendarConfig(config, { requireCurrentDate: false });
    const text = String(body || '').replace(/<[^>]+>/g, ' ')
        .split(/\b(?:NPCs?\s+Present|Off[ -]Screen|Player\s+(?:Character|State)|Characters?)\s*[:|]/i)[0];
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
    const current = normalizeCalendarDate(referenceDate || storyCurrentDate(config), config);
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
    const current = normalizeCalendarDate(referenceDate || storyCurrentDate(config), config);
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
    const current = normalizeCalendarDate(referenceDate, normalized.config) || storyCurrentDate(normalized.config);
    return current ? `Current grounded world date=${formatCalendarDate(current, normalized.config)}.` : '';
}
