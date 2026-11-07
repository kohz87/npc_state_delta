// Plain-JSON helpers for ops: the object test, the JSON check, defensive copies and deep equality.
// Objects without a prototype stay that way, and "__proto__" is written as an own key. Pure.

import { escapeKey } from './paths.js';

export function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** True for plain JSON: null, booleans, strings, finite numbers, arrays and plain objects of those. */
export function isJson(value) {
    return jsonProblem(value, '') === '';
}

export function jsonProblem(value, path) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? '' : `${path || '/'} is ${value}, not a finite number.`;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const problem = jsonProblem(value[i], `${path}/${i}`);
            if (problem) return problem;
        }
        return '';
    }
    if (isPlainObject(value)) {
        for (const key of Object.keys(value)) {
            const problem = jsonProblem(value[key], `${path}/${escapeKey(key)}`);
            if (problem) return problem;
        }
        return '';
    }
    const what = value === undefined ? 'undefined' : typeof value === 'object' ? 'not a plain object' : `a ${typeof value}`;
    return `${path || '/'} is ${what}; state holds plain JSON only.`;
}

export function setKey(target, key, value) {
    if (key === '__proto__') Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    else target[key] = value;
}

/**
 * A deep copy of plain JSON (other values are kept as they are, for checkOps to report). An object
 * without a prototype (a change line's labels) stays one, so a key it lacks is never an inherited one.
 */
export function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(clone);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = proto === null ? Object.create(null) : {};
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const item = value[key];
        setKey(out, key, item === null || typeof item !== 'object' ? item : clone(item));
    }
    return out;
}

/** Deep equality for plain JSON. */
export function equal(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
    if (isPlainObject(a) && isPlainObject(b)) {
        const keys = Object.keys(a);
        if (keys.length !== Object.keys(b).length) return false;
        for (const key of keys) if (!Object.hasOwn(b, key) || !equal(a[key], b[key])) return false;
        return true;
    }
    return false;
}
