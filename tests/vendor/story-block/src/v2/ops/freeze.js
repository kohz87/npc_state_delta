// Freezing for ops: deep-freeze a value, remember what is frozen all the way down, and make a frozen
// copy that shares the unchanged branches of a frozen base. The frozen set is only a cache.

import { isPlainObject, setKey } from './json.js';

// Values known to be frozen all the way down, so a state that shares most of its branches with the one
// before it is looked through only where it is new (isDeepFrozen).
const frozenDeep = new WeakSet();
const knownFrozen = value => value === null || typeof value !== 'object' || frozenDeep.has(value);

/** Freezes a value and everything in it; returns it. */
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        let deep = true;
        for (const key of Object.keys(value)) {
            deepFreeze(value[key]);
            if (deep && !knownFrozen(value[key])) deep = false;
        }
        if (deep) frozenDeep.add(value);
    }
    return value;
}

/** True when `value` and everything in it is frozen (plain values are). Remembered per object. */
export function isDeepFrozen(value) {
    if (knownFrozen(value)) return true;
    if (!Object.isFrozen(value)) return false;
    for (const key of Object.keys(value)) if (!isDeepFrozen(value[key])) return false;
    frozenDeep.add(value);
    return true;
}

/**
 * frozenCopy(value, base?) → what `deepFreeze(clone(value))` gives, except that wherever `value` holds
 * the same as `base` (same keys in the same order, equal values), that branch of `base` itself is used,
 * and a part of `value` that is deep-frozen already is used as it is. `base` must be deep-frozen (a
 * branch of a state). A frozen view of a changed copy then costs a walk of it, not a copy of all of it.
 */
export function frozenCopy(value, base) {
    if (value === null || typeof value !== 'object') return value;
    if (value === base || isDeepFrozen(value)) return value;
    if (Array.isArray(value)) {
        const like = Array.isArray(base) && base.length === value.length ? base : null;
        const out = new Array(value.length);
        let same = like !== null;
        for (let i = 0; i < value.length; i++) {
            if (!(i in value)) {   // a hole stays one, as clone keeps it
                same = false;
                continue;
            }
            out[i] = frozenCopy(value[i], like?.[i]);
            if (same && !Object.is(out[i], like[i])) same = false;
        }
        return same ? like : frozenCopyDone(out);
    }
    if (!isPlainObject(value)) return deepFreeze(value);   // clone keeps such a value as it is
    const proto = Object.getPrototypeOf(value);
    const like = isPlainObject(base) && Object.getPrototypeOf(base) === proto ? base : null;
    const keys = Object.keys(value);
    const baseKeys = like === null ? null : Object.keys(like);
    const out = proto === null ? Object.create(null) : {};
    let same = like !== null && baseKeys.length === keys.length;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const child = frozenCopy(value[key], like !== null && Object.hasOwn(like, key) ? like[key] : undefined);
        if (same && (baseKeys[i] !== key || !Object.is(child, like[key]))) same = false;
        setKey(out, key, child);
    }
    return same ? like : frozenCopyDone(out);
}

// Each branch of `out` is deep-frozen already.
function frozenCopyDone(out) {
    Object.freeze(out);
    if (Object.keys(out).every(key => knownFrozen(out[key]))) frozenDeep.add(out);
    return out;
}
