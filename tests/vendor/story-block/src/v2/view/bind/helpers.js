// Binding helpers: ratio, percentage, length, contains, sum and the default money/time formatters. Pure;
// makeScope puts them on every scope and the condition language receives them as extra calls.

import { valueAtKeys } from './paths.js';

function finite(value) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

/** a / b clamped to 0…1 (4 decimals); 0 when b is not a positive number. */
export function ratio(a, b) {
    const top = finite(a);
    const bottom = finite(b);
    if (top === null || bottom === null || bottom <= 0) return 0;
    return Math.round(Math.min(1, Math.max(0, top / bottom)) * 10000) / 10000;
}

/** a / b as a whole percentage, 0…100. */
export const pct = (a, b) => Math.round(ratio(a, b) * 100);

/** Items in a list, keys in a record, characters in a string; 0 otherwise. */
export function len(value) {
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return 0;
}

/**
 * contains(a, b): does text `a` hold text `b`, ignoring case (a filter box: `contains(name, draft.find)`)?
 * An empty or missing `b` is held by everything; a list holds `b` when one of its items does.
 */
export function contains(a, b) {
    const needle = typeof b === 'string' || typeof b === 'number' ? String(b).trim().toLocaleLowerCase() : '';
    if (!needle) return true;
    if (Array.isArray(a)) return a.some(item => contains(item, needle));
    if (typeof a !== 'string' && typeof a !== 'number') return false;
    return String(a).toLocaleLowerCase().includes(needle);
}

/**
 * sum(list, field?): the numbers in a list or the values of a record added up (a points-buy total:
 * `sum(draft.points)`); with `field`, each item's field (`sum(q.rows, 'base')`, or a dotted path
 * `sum(state.party.actors, 'hp.cur')`). Anything that is not a finite number counts as 0. Own
 * properties only: a field naming `__proto__`, `constructor` or `prototype` reads nothing.
 */
export function sum(list, field) {
    const items = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : [];
    const keys = typeof field === 'string' && field !== '' ? field.split('.') : null;
    if (field !== undefined && field !== null && !keys) return 0;
    let total = 0;
    for (const item of items) {
        const value = keys ? valueAtKeys(item, keys) : item;
        if (typeof value === 'number' && Number.isFinite(value)) total += value;
    }
    // 0.1 + 0.2 reads as 0.3; whole numbers are already exact.
    return Number.isInteger(total) ? total : Math.round(total * 1e9) / 1e9;
}

/** Plain fallbacks; the host injects the real ones (the rules' coin names, the Director's calendar). */
export const defaultFormatters = {
    money: n => (Number.isInteger(n) ? String(n) : ''),
    time: minutes => {
        if (!Number.isInteger(minutes) || minutes < 0) return '';
        const day = Math.floor(minutes / 1440) + 1;
        const hour = Math.floor((minutes % 1440) / 60);
        const minute = minutes % 60;
        return `Day ${day}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    },
};
