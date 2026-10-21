// Ops (SPEC §2.3): the changes a committed command made, as a subset of JSON Patch (`add`, `replace`,
// `remove`) with JSON Pointer paths into the State. Story Block's commit step makes them with `diff`
// from what a handler drafted; replay rebuilds a state with `apply`; `checkOps` holds every op to the
// generic rules of §2.5 before anything is saved. Pure.
//
// How `diff` writes changes, so the same pair of states always gives the same ops:
// * Objects are compared key by key in sorted order: a key only in `before` is a `remove`, a key only
//   in `after` an `add`, a key in both is compared again one level down.
// * Arrays are compared whole. Unchanged: nothing. `after` is `before` with items added at the end: one
//   `add` per new item at its index. Anything else (an item changed, removed or moved): one `replace` of
//   the whole array. Lists in v2 state are short (records are keyed by ID, never by position), so this
//   stays small and never has to reason about index shifts.
// * Any other change (a number, a string, a type change) is a `replace` of that value.
// Values in ops are copies, never shared with the states they came from.

import { isId } from './check.js';

const OPS = new Set(['add', 'replace', 'remove']);
const INDEX = /^(?:0|[1-9]\d*)$/;

/** A JSON Pointer segment for an object key: `~` → `~0`, `/` → `~1`. */
export function escapeKey(key) {
    return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** The keys of a JSON Pointer ('' is the whole document); throws on a malformed pointer. */
export function parsePath(path) {
    if (typeof path !== 'string') throw new Error('A change path must be text.');
    if (path === '') return [];
    if (path[0] !== '/') throw new Error(`The change path "${path}" must start with "/".`);
    return path.slice(1).split('/').map(part => {
        if (/~(?![01])/.test(part)) throw new Error(`The change path "${path}" has a "~" that is not ~0 or ~1.`);
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        if (key === '__proto__') throw new Error(`The change path "${path}" names __proto__.`);
        return key;
    });
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** True for plain JSON: null, booleans, strings, finite numbers, arrays and plain objects of those. */
export function isJson(value) {
    return jsonProblem(value, '') === '';
}

function jsonProblem(value, path) {
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

function setKey(target, key, value) {
    if (key === '__proto__') Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    else target[key] = value;
}

/**
 * A deep copy of plain JSON (other values are kept as they are, for checkOps to report). An object
 * without a prototype (a change line's labels) stays one, so a key it lacks is never an inherited one.
 */
export function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (isPlainObject(value)) {
        const out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
        for (const key of Object.keys(value)) setKey(out, key, clone(value[key]));
        return out;
    }
    return value;
}

/** Deep equality for plain JSON. */
export function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => equal(item, b[i]));
    if (isPlainObject(a) && isPlainObject(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
    }
    return false;
}

/** Freezes a value and everything in it; returns it. */
export function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

/** diff(before, after, basePath = '') → Op[]: the minimal changes as described at the top. */
export function diff(before, after, basePath = '') {
    const ops = [];
    walkDiff(before, after, basePath, ops);
    return ops;
}

function walkDiff(a, b, path, ops) {
    if (a === b) return;
    if (isPlainObject(a) && isPlainObject(b)) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        for (const key of keys) {
            const at = `${path}/${escapeKey(key)}`;
            const inA = Object.hasOwn(a, key);
            const inB = Object.hasOwn(b, key);
            if (!inB) ops.push({ op: 'remove', path: at });
            else if (!inA) ops.push({ op: 'add', path: at, value: clone(b[key]) });
            else walkDiff(a[key], b[key], at, ops);
        }
        return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (equal(a, b)) return;
        if (b.length > a.length && a.every((item, i) => equal(item, b[i]))) {
            for (let i = a.length; i < b.length; i++) ops.push({ op: 'add', path: `${path}/${i}`, value: clone(b[i]) });
        } else {
            ops.push({ op: 'replace', path, value: clone(b) });
        }
        return;
    }
    if (equal(a, b)) return;
    ops.push({ op: 'replace', path, value: clone(b) });
}

/**
 * apply(state, ops) → State: a new state with the ops applied in order; `state` is never changed
 * (unchanged branches are shared with it). Throws on a bad op or a path that does not fit the state.
 */
export function apply(state, ops) {
    if (!Array.isArray(ops)) throw new Error('The changes must be a list.');
    const fresh = new WeakSet();   // containers this call copied, safe to change in place
    let root = state;
    for (const op of ops) root = applyOne(root, op, fresh);
    return root;
}

function copyOf(node, fresh) {
    if (fresh.has(node)) return node;
    // Spread defines keys as data (an own "__proto__" key stays a key, never a prototype).
    const copy = Array.isArray(node) ? node.slice() : { ...node };
    fresh.add(copy);
    return copy;
}

function applyOne(root, op, fresh) {
    if (!op || typeof op !== 'object' || !OPS.has(op.op)) throw new Error(`"${op?.op}" is not a change Story Block knows (add, replace, remove).`);
    const keys = parsePath(op.path);
    if ((op.op === 'add' || op.op === 'replace') && !Object.hasOwn(op, 'value')) throw new Error(`The ${op.op} at "${op.path}" has no value.`);
    if (!keys.length) {
        if (op.op === 'remove') throw new Error('A change cannot remove the whole state.');
        return clone(op.value);
    }
    const step = (node, depth) => {
        if (node === null || typeof node !== 'object') throw new Error(`The change path "${op.path}" goes through something that is not an object or a list.`);
        const key = keys[depth];
        const last = depth === keys.length - 1;
        const copy = copyOf(node, fresh);
        if (Array.isArray(node)) {
            if (last && op.op === 'add') {
                const index = key === '-' ? node.length : INDEX.test(key) ? Number(key) : NaN;
                if (!(index >= 0 && index <= node.length)) throw new Error(`The change path "${op.path}" has no list position ${key}.`);
                copy.splice(index, 0, clone(op.value));
                return copy;
            }
            if (!INDEX.test(key) || Number(key) >= node.length) throw new Error(`The change path "${op.path}" has no list position ${key}.`);
            const index = Number(key);
            if (!last) copy[index] = step(node[index], depth + 1);
            else if (op.op === 'replace') copy[index] = clone(op.value);
            else copy.splice(index, 1);
            return copy;
        }
        const has = Object.hasOwn(node, key);
        if (!last) {
            if (!has) throw new Error(`The change path "${op.path}" does not exist (no "${key}").`);
            setKey(copy, key, step(node[key], depth + 1));
            return copy;
        }
        if (op.op !== 'add' && !has) throw new Error(`The change path "${op.path}" does not exist (no "${key}").`);
        if (op.op === 'remove') delete copy[key];
        else setKey(copy, key, clone(op.value));
        return copy;
    };
    return step(root, 0);
}

// ---------- counters (B3-8) ----------
//
// A domain may name number fields that are counts kept by adding and taking away (`counters`, paths
// relative to the domain with `*` for any one key: the inventory's `wallets/*/coin`, `stacks/*/qty`).
// A `replace` of such a number keeps the value it replaced (`was`). On replay, when the value found is
// not `was` (an earlier reply was deleted, so the count stands elsewhere), the op adds its own change
// (`value - was`) to what is there instead of writing its number (`rebaseOps`); the store then runs the
// domain's validator on the result. Ops without `was` (older records, other fields) apply as written.
// A `remove` of a thing that holds a counter (a stack a reply emptied) keeps that counter's number then
// (`was`) and where it is inside the thing (`count`, '/qty'). On replay, when the thing holds another
// number (an earlier reply was deleted), it is taken from instead: `was` comes off and the rest stays;
// holding less than `was` goes below zero, which the validator refuses (that block is skipped). Holding
// `was` exactly, it goes, as written.

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

/**
 * `ops` with each counter op (`replace` with a numeric `was`) moved onto the value `state` holds
 * there, and each `remove` of a thing holding a counter (`was`, `count`) that now holds another
 * number turned into taking `was` from it: { ops, rebased: Set of domain names whose counts moved }.
 * Ops are not changed in place.
 */
export function rebaseOps(state, ops) {
    const rebased = new Set();
    const moved = path => {
        const keys = parsePath(path);
        if (keys[0] === 'domains' && keys[1]) rebased.add(keys[1]);
    };
    const out = ops.map(op => {
        if (op?.op === 'remove' && typeof op.was === 'number' && typeof op.count === 'string' && op.count.startsWith('/')) {
            const at = `${op.path}${op.count}`;
            const now = valueAt(state, at);
            if (typeof now !== 'number' || now === op.was) return op;
            // Take `was` from what is there: the rest stays; less than `was` there is below zero, which
            // the domain's validator refuses (the block is skipped), as a take of more than is held is.
            moved(op.path);
            return { op: 'replace', path: at, value: now - op.was, was: now };
        }
        if (op?.op !== 'replace' || typeof op.was !== 'number' || typeof op.value !== 'number') return op;
        const now = valueAt(state, op.path);
        if (typeof now !== 'number' || now === op.was) return op;
        moved(op.path);
        return { ...op, value: now + (op.value - op.was), was: now };
    });
    return { ops: out, rebased };
}

/** The value at a JSON Pointer, or undefined when the path does not exist. Never throws. */
export function valueAt(state, path) {
    let keys;
    try { keys = parsePath(path); } catch { return undefined; }
    let node = state;
    for (const key of keys) {
        if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined;
        node = node[key];
    }
    return node;
}

// Keys whose values must be IDs: `id`, and names ending in `Id` or `_id` (`stackId`, `owner_id`).
const ID_KEY = /^(?:id|.+Id|.+_id)$/;
// Keys no value in the state may hold: copied with Object.assign or a for-in loop they would change
// an object's prototype, and code reading them would get the language's own (QA #70).
export const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * checkOps(ops, before?) → string[]: the generic rules of SPEC §2.5, as plain sentences (empty when
 * fine). Every op: a known op, a well-formed path below the root, a plain-JSON value (no NaN, no
 * Infinity, no undefined, no key named __proto__, constructor or prototype inside a value). Anywhere
 * in a value or at the end of a path:
 * * `qty` is a whole number, 0 or more;
 * * `/meta/rev` is a whole number, 0 or more;
 * * a key named `id` holds a well-formed ID (`it_k3f9a2qz` or `story/moonveil-trout`); a key ending
 *   in `Id` or `_id` holds one too, or null.
 * With `before` (the state the ops apply to), a number that replaces a whole number must be whole too,
 * at that path and anywhere inside the replaced value ("integers stay integers").
 */
export function checkOps(ops, before = undefined) {
    if (!Array.isArray(ops)) return ['The changes are not a list.'];
    const errors = [];
    ops.forEach((op, n) => {
        if (!op || typeof op !== 'object' || !OPS.has(op.op)) {
            errors.push(`Change ${n + 1} is not an add, replace or remove.`);
            return;
        }
        let keys;
        try {
            keys = parsePath(op.path);
        } catch (error) {
            errors.push(error.message);
            return;
        }
        if (!keys.length) {
            errors.push(`Change ${n + 1} would ${op.op} the whole state.`);
            return;
        }
        if (op.op === 'remove') return;
        if (!Object.hasOwn(op, 'value')) {
            errors.push(`The ${op.op} at ${op.path} has no value.`);
            return;
        }
        const problem = jsonProblem(op.value, op.path);
        if (problem) {
            errors.push(problem);
            return;
        }
        checkValue(op.value, keys[keys.length - 1], op.path, errors);
        if (op.path === '/meta/rev' && (!Number.isInteger(op.value) || op.value < 0)) errors.push(`/meta/rev must be a whole number, 0 or more (got ${JSON.stringify(op.value)}).`);
        if (before !== undefined) stayWhole(valueAt(before, op.path), op.value, op.path, errors);
    });
    return errors;
}

function checkValue(value, key, path, errors) {
    if (key === 'qty' && !(Number.isInteger(value) && value >= 0)) {
        errors.push(`${path}: qty must be a whole number, 0 or more (got ${JSON.stringify(value)}).`);
    }
    if (ID_KEY.test(key)) {
        const ok = key === 'id' ? isId(value) : value === null || isId(value);
        if (!ok) errors.push(`${path}: ${key} must be an ID like it_k3f9a2qz or story/moonveil-trout (got ${JSON.stringify(value)}).`);
    }
    if (Array.isArray(value)) value.forEach((item, i) => checkValue(item, String(i), `${path}/${i}`, errors));
    else if (value !== null && typeof value === 'object') {
        for (const child of Object.keys(value)) {
            if (FORBIDDEN_KEYS.includes(child)) {
                errors.push(`${path} holds a key named "${child}", which the state may not use.`);
                continue;
            }
            checkValue(value[child], child, `${path}/${escapeKey(child)}`, errors);
        }
    }
}

function stayWhole(old, value, path, errors) {
    if (typeof old === 'number' && Number.isInteger(old)) {
        if (typeof value === 'number' && !Number.isInteger(value)) errors.push(`${path} was a whole number and must stay one (got ${value}).`);
        return;
    }
    if (Array.isArray(old) && Array.isArray(value)) {
        for (let i = 0; i < Math.min(old.length, value.length); i++) stayWhole(old[i], value[i], `${path}/${i}`, errors);
    } else if (isPlainObject(old) && isPlainObject(value)) {
        for (const key of Object.keys(value)) if (Object.hasOwn(old, key)) stayWhole(old[key], value[key], `${path}/${escapeKey(key)}`, errors);
    }
}
