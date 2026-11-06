// Binding path syntax and reads: parse `name.key[0]['key']`, resolve it in a scope, turn it into a State JSON
// Pointer, and read or copy-write values by key. Reads use own properties and reject forbidden keys; writes reject them too.

import { escapeKey } from '../../ops.js';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
export const IDENT = /^[A-Za-z_$][\w$]*$/;
/** Names a loop may not take: they are the scope's own roots and helpers. */
export const RESERVED = new Set(['state', 'q', 'draft', 'settings', 'query', 'ratio', 'pct', 'changed', 'len', 'contains', 'sum', 'fmt', 'true', 'false', 'null']);
export const POINTERS = Symbol('ss.pointers');

/**
 * Parse a path: `name`, then `.key` or `[0]` / `['key']` / `["key"]` / `[other.path]` steps.
 * Returns `{ root, steps, source }` (a step is `{ key }` or `{ path }`) or null when the text is not a path.
 */
export function parsePath(source) {
    const text = String(source ?? '').trim();
    const reader = { text, at: 0 };
    const path = readPath(reader);
    return path && reader.at === text.length ? path : null;
}

export function readPath(reader) {
    const { text } = reader;
    const head = /^[A-Za-z_$][\w$]*/.exec(text.slice(reader.at));
    if (!head) return null;
    const start = reader.at;
    reader.at += head[0].length;
    const steps = [];
    for (;;) {
        const char = text[reader.at];
        if (char === '.') {
            const key = /^\.(\w+)/.exec(text.slice(reader.at));
            if (!key) return null;
            steps.push({ key: key[1] });
            reader.at += key[0].length;
        } else if (char === '[') {
            reader.at += 1;
            skipSpace(reader);
            const rest = text.slice(reader.at);
            const number = /^\d+/.exec(rest);
            const quoted = /^(?:'([^'\\]*)'|"([^"\\]*)")/.exec(rest);
            if (number) {
                steps.push({ key: number[0] });
                reader.at += number[0].length;
            } else if (quoted) {
                steps.push({ key: quoted[1] ?? quoted[2] });
                reader.at += quoted[0].length;
            } else {
                const inner = readPath(reader);
                if (!inner) return null;
                steps.push({ path: inner });
            }
            skipSpace(reader);
            if (text[reader.at] !== ']') return null;
            reader.at += 1;
        } else break;
    }
    return { root: head[0], steps, source: text.slice(start, reader.at) };
}

export function skipSpace(reader) {
    while (/\s/.test(reader.text[reader.at] ?? '')) reader.at += 1;
}

function step(value, key) {
    if (key === undefined || key === null || FORBIDDEN.has(String(key))) return undefined;
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'object' && typeof value !== 'string') return undefined;
    return Object.hasOwn(value, key) ? value[key] : undefined;
}

function stepKey(scope, item) {
    if (item.key !== undefined) return item.key;
    const key = resolvePath(scope, item.path);
    return typeof key === 'string' || (typeof key === 'number' && Number.isInteger(key)) ? String(key) : undefined;
}

/** The value at a parsed path (or path text) in the scope; undefined when any step is missing. */
export function resolvePath(scope, path) {
    const parsed = typeof path === 'string' ? parsePath(path) : path;
    if (!parsed) return undefined;
    let value = step(scope, parsed.root);
    for (const item of parsed.steps) {
        value = step(value, stepKey(scope, item));
        if (value === undefined) return undefined;
    }
    return value;
}

/**
 * The JSON Pointer into the State that a path names, or null when it does not name state (a query
 * result, the draft, settings, a literal). Loop names carry their item's pointer (`withItem`).
 */
export function pointerOf(scope, path) {
    const parsed = typeof path === 'string' ? parsePath(path) : path;
    if (!parsed) return null;
    const keys = [];
    for (const item of parsed.steps) {
        const key = stepKey(scope, item);
        if (key === undefined) return null;
        keys.push(key);
    }
    let base;
    if (parsed.root === 'state') {
        if (!keys.length) return '';
        const first = keys.shift();
        base = first === 'meta' || first === 'v' ? `/${escapeKey(first)}` : `/domains/${escapeKey(first)}`;
    } else {
        base = scope?.[POINTERS]?.[parsed.root];
        if (typeof base !== 'string') return null;
    }
    return base + keys.map(key => `/${escapeKey(key)}`).join('');
}

/**
 * The keys a parsed path walks (`[root, ...steps]`), dynamic `[x.y]` steps read from the scope; null when
 * a dynamic step has no usable key.
 */
export function pathKeys(scope, path) {
    const parsed = typeof path === 'string' ? parsePath(path) : path;
    if (!parsed) return null;
    const keys = [parsed.root];
    for (const item of parsed.steps) {
        const key = stepKey(scope, item);
        if (key === undefined) return null;
        keys.push(key);
    }
    return keys;
}

/** The value under a list of keys (own properties only). */
export function valueAtKeys(target, keys) {
    let value = target;
    for (const key of keys) {
        value = step(value, key);
        if (value === undefined) return undefined;
    }
    return value;
}

/** Set a value under a list of keys inside a plain object, copying each object on the way. */
export function setIn(target, keys, value) {
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || FORBIDDEN.has(key))) {
        throw new Error(`"${Array.isArray(keys) ? keys.join('.') : keys}" cannot be written.`);
    }
    const write = (node, index) => {
        const copy = Array.isArray(node) ? [...node] : node && typeof node === 'object' ? { ...node } : {};
        const key = keys[index];
        copy[key] = index === keys.length - 1 ? value : write(Object.hasOwn(copy, key) ? copy[key] : undefined, index + 1);
        return copy;
    };
    return write(target, 0);
}
