// Counter detection for ops (B3-8): whether a pointer names a domain counter, and the pointer inside a
// thing that holds one. Pure.

import { escapeKey, parsePath } from './paths.js';

/** True when `path` (/domains/<name>/…) is one of the domain's `counters` patterns. */
export function isCounterPath(path, patterns) {
    if (!Array.isArray(patterns) || !patterns.length) return false;
    let keys;
    try { keys = parsePath(path); } catch { return false; }
    if (keys[0] !== 'domains' || keys.length < 3) return false;
    const rest = keys.slice(2);
    return patterns.some(pattern => {
        const parts = String(pattern).split('/').filter(Boolean);
        return parts.length === rest.length && parts.every((part, i) => part === '*' || part === rest[i]);
    });
}

/**
 * The pointer, inside the thing at `path`, of the one counter it holds ('/qty' for a stack, with
 * the inventory's stack pattern), or null when no `patterns` entry reaches past `path` to a fixed key.
 */
export function counterInside(path, patterns) {
    if (!Array.isArray(patterns) || !patterns.length) return null;
    let keys;
    try { keys = parsePath(path); } catch { return null; }
    if (keys[0] !== 'domains' || keys.length < 3) return null;
    const rest = keys.slice(2);
    for (const pattern of patterns) {
        const parts = String(pattern).split('/').filter(Boolean);
        if (parts.length <= rest.length || !rest.every((key, i) => parts[i] === '*' || parts[i] === key)) continue;
        const inside = parts.slice(rest.length);
        if (inside.includes('*')) continue;
        return inside.map(key => `/${escapeKey(key)}`).join('');
    }
    return null;
}
