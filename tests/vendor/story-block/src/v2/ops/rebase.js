// Rebase and scratch fitting for ops: move counter changes onto the values replay found, fit per-reply
// bookkeeping, and apply the replay rules (c)-(e). Pure.

import { OPS } from './constants.js';
import { escapeKey, parsePath, valueAt } from './paths.js';
import { clone, equal, isPlainObject } from './json.js';
import { apply } from './apply.js';

// ---------- per-reply scratch ----------
//
// A domain may name top-level fields that hold per-reply bookkeeping (`scratch`, the inventory's
// `perReply`): each reply adds its own entry under its record ID and drops the others. On replay, after
// an earlier reply was deleted (or one of this reply's own blocks was skipped), what an op inside such a
// field expects may not be there: a `remove` of something not there is passed over, missing objects on
// the way are made ({}), and a `replace` of something not there becomes an `add`. Bookkeeping only
// counts what did happen, so fitting it never makes anything. Nothing outside scratch fields changes.

/** The pointer of the scratch field `path` (/domains/<name>/<field>/…) lies in (`scratchOf(name)` lists it), or null. */
export function scratchRoot(path, scratchOf) {
    if (typeof scratchOf !== 'function') return null;
    let keys;
    try { keys = parsePath(path); } catch { return null; }
    if (keys[0] !== 'domains' || keys.length < 3) return null;
    const fields = scratchOf(keys[1]);
    return Array.isArray(fields) && fields.includes(keys[2]) ? `/domains/${escapeKey(keys[1])}/${escapeKey(keys[2])}` : null;
}

function scratchOps(state, ops, scratchOf) {
    // What each scratch field holds as the block goes (a copy; the ops are what is returned).
    const shadow = new Map();
    const out = [];
    for (const op of ops) {
        const root = op && typeof op.path === 'string' ? scratchRoot(op.path, scratchOf) : null;
        // An op marked `within` a thing (ctx.ifThere, rule d) is not fitted: it is passed over when the thing is not there.
        if (!root || !OPS.has(op.op) || typeof op.within === 'string') {
            out.push(op);
            continue;
        }
        if (!shadow.has(root)) shadow.set(root, { value: clone(valueAt(state, root)) });
        const held = shadow.get(root);
        const keys = parsePath(op.path).slice(3);
        // A list inside a scratch field is not fitted (fix-fuzz150): an append (`/-`) or a position in it
        // applies as written, as anywhere else. Fitted, the list was made an object and the append a key
        // named "-", and a remove of a list item was dropped, live as well as on replay.
        if (keys.length && throughList(held.value, keys)) {
            try { held.value = apply({ v: held.value }, [{ ...op, path: `/v${op.path.slice(root.length)}` }]).v; } catch { /* its block fails as written */ }
            out.push(op);
            continue;
        }
        if (!keys.length) {
            if (op.op === 'remove') {
                if (held.value === undefined) continue;
                held.value = undefined;
            } else held.value = clone(op.value);
            out.push(op);
            continue;
        }
        if (op.op === 'remove') {
            const parent = keys.slice(0, -1).reduce((node, key) => (isPlainObject(node) && Object.hasOwn(node, key) ? node[key] : undefined), held.value);
            if (!isPlainObject(parent) || !Object.hasOwn(parent, keys.at(-1))) continue;
            delete parent[keys.at(-1)];
            out.push(op);
            continue;
        }
        if (!isPlainObject(held.value)) {
            held.value = {};
            out.push({ op: 'add', path: root, value: {} });
        }
        let node = held.value;
        let at = root;
        for (const key of keys.slice(0, -1)) {
            at = `${at}/${escapeKey(key)}`;
            if (!isPlainObject(node[key])) {
                node[key] = {};
                out.push({ op: 'add', path: at, value: {} });
            }
            node = node[key];
        }
        const last = keys.at(-1);
        out.push(op.op === 'replace' && !Object.hasOwn(node, last) ? { op: 'add', path: op.path, value: op.value } : op);
        node[last] = clone(op.value);
    }
    return out;
}

// True when the path `keys` (inside a scratch field holding `value`) ends in an append (`-`) or goes
// into a list that is there.
function throughList(value, keys) {
    if (keys.at(-1) === '-') return true;
    let node = value;
    for (const key of keys) {
        if (Array.isArray(node)) return true;
        if (!isPlainObject(node) || !Object.hasOwn(node, key)) return false;
        node = node[key];
    }
    return false;
}

// The list rule (e) also covers for ops stored without the mark (see heldAlready).
const UNIQUE_BEFORE_MARK = '/domains/scene/present';

/**
 * `ops` with each counter op (`replace` with a numeric `was`) moved onto the value `state` holds
 * there, and each `remove` of a thing holding a counter (`was`, `count`) that now holds another
 * number turned into taking `was` from it: { ops, rebased: Set of domain names whose counts moved }.
 * With `scratch` (a domain name → its scratch fields), ops inside those fields are fitted as above.
 * With `replayed` (stored ops replayed, never a live command), a `remove` of an object key that is not
 * there (the reply that added it was deleted) is passed over; one that carries a counted `was` (a take
 * of a stack) is not, so a take of something gone still fails its block. And (rule c) a `replace` of an
 * object key inside a domain that is not there, in an object that is, becomes an `add`: only a deleted reply had added
 * the key, and the value is the one this later reply set. Counted ops (`was`) keep the counter rules
 * above. And (rule d) an op marked `within` a thing (ctx.ifThere) is passed over when that thing is not
 * there. And (rule e) an append marked `unique` (ctx.unique) of an item the list holds already is passed over. Ops are not changed in place.
 */
export function rebaseOps(state, ops, { scratch = null, replayed = false } = {}) {
    const rebased = new Set();
    const moved = path => {
        const keys = parsePath(path);
        if (keys[0] === 'domains' && keys[1]) rebased.add(keys[1]);
    };
    // Paths earlier ops in the list put something at: a count under one of them stands as they left it.
    const written = [];
    const writtenAbove = path => written.some(at => path === at || path.startsWith(`${at}/`));
    const out = [];
    for (const op of scratch ? scratchOps(state, ops, scratch) : ops) {
        // Rule (d): an op marked `within` a thing (ctx.ifThere) whose thing is gone is passed over.
        if (replayed && goneHolder(op)) continue;
        // Rule (e): an append marked `unique` of an item the list holds already is passed over.
        if (replayed && heldAlready(op)) continue;
        if (!(replayed && goneKey(op))) out.push(replayed && newKey(op) ? { op: 'add', path: op.path, value: op.value } : fit(op));
        if ((op?.op === 'add' || op?.op === 'replace') && typeof op.path === 'string') written.push(op.path);
    }
    return { ops: out, rebased };

    // Rule (d): an op inside the thing it is marked `within` (ctx.ifThere) when that thing is not there,
    // nor put there earlier in the list: the reply that made it was deleted.
    function goneHolder(op) {
        const within = op?.within;
        if (typeof within !== 'string' || !within.startsWith('/domains/') || typeof op.path !== 'string') return false;
        if (op.path !== within && !op.path.startsWith(`${within}/`)) return false;
        if (op.op === 'add' && op.path === within) return false;   // the thing made here
        return !writtenAbove(within) && valueAt(state, within) === undefined;
    }

    // Rule (e): an append (`add <list>/-`) marked `unique` (ctx.unique) of an item the list already holds,
    // when no earlier op of the block wrote the list: the reply that took it out was deleted. Text is
    // the same name whatever its case, as the scene's validator takes it.
    function heldAlready(op) {
        if (op?.op !== 'add' || typeof op.path !== 'string' || !op.path.endsWith('/-')) return false;
        const at = op.path.slice(0, -2);
        // Ops stored before the mark existed (2.11.1 and earlier wrote `~ place ... | with:` and the reader's
        // set of who is present without it) get the scene's list the same way: that list never holds a name twice.
        if (op.unique !== true && at !== UNIQUE_BEFORE_MARK) return false;
        if (writtenAbove(at)) return false;
        const list = valueAt(state, at);
        if (!Array.isArray(list)) return false;
        const same = typeof op.value === 'string'
            ? item => typeof item === 'string' && item.toLowerCase() === op.value.toLowerCase()
            : item => equal(item, op.value);
        return list.some(same);
    }

    // A `remove` (no counted `was`) of an object key that is not there, nor put there earlier in the list.
    function goneKey(op) {
        if (op?.op !== 'remove' || typeof op.was === 'number' || typeof op.path !== 'string' || writtenAbove(op.path)) return false;
        let keys;
        try { keys = parsePath(op.path); } catch { return false; }
        let node = state;
        for (const key of keys) {
            if (!isPlainObject(node)) return false;   // a list position, or nothing to walk: as written
            if (!Object.hasOwn(node, key)) return true;
            node = node[key];
        }
        return false;
    }

    // Rule (c): a `replace` (no counted `was`) of an object key inside a domain that is not there, nor put
    // there earlier in the list, whose parent is an object that is there.
    function newKey(op) {
        if (op?.op !== 'replace' || typeof op.was === 'number' || typeof op.path !== 'string' || writtenAbove(op.path)) return false;
        let keys;
        try { keys = parsePath(op.path); } catch { return false; }
        // Inside a domain that is there (never a domain of its own, nor /meta).
        if (keys[0] !== 'domains' || keys.length < 3) return false;
        let node = state;
        for (const key of keys.slice(0, -1)) {
            if (!isPlainObject(node) || !Object.hasOwn(node, key)) return false;
            node = node[key];
        }
        return isPlainObject(node) && !Object.hasOwn(node, keys.at(-1));
    }

    function fit(op) {
        // Under something an earlier op in the list put there, the op stands as it was made.
        if (typeof op?.path === 'string' && typeof op.was === 'number' && writtenAbove(op.path)) return op;
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
        if (now === undefined) {
            // The count, or the thing holding it, is not there (the reply that made it was deleted): it
            // counts from 0, as the op's change alone. Its holder is made for it only when a holder is
            // nothing but that count (a wallet { coin }: every other one there is so); a thing with more
            // to it (a stack) is not made up, so the op stays as written and that block is skipped.
            const key = parsePath(op.path).at(-1);
            const parent = op.path.slice(0, op.path.lastIndexOf('/'));
            const holder = valueAt(state, parent);
            const value = op.value - op.was;
            if (isPlainObject(holder)) {
                moved(op.path);
                return { op: 'add', path: op.path, value };
            }
            const above = holder === undefined ? valueAt(state, parent.slice(0, parent.lastIndexOf('/'))) : null;
            const bare = other => isPlainObject(other) && Object.keys(other).every(field => field === key);
            if (isPlainObject(above) && Object.values(above).every(bare)) {
                moved(op.path);
                return { op: 'add', path: parent, value: { [key]: value } };
            }
            return op;
        }
        if (typeof now !== 'number' || now === op.was) return op;
        moved(op.path);
        const value = now + (op.value - op.was);
        // A `qty` brought to exactly 0 removes the thing that holds it, as a live take to 0 does (a stack
        // is never kept at 0, §2.5); below 0 stays a number, which the validator refuses.
        const keys = parsePath(op.path);
        if (value === 0 && keys.length > 3 && keys[keys.length - 1] === 'qty') {
            return { op: 'remove', path: op.path.slice(0, op.path.lastIndexOf('/')) };
        }
        return { ...op, value, was: now };
    }
}
