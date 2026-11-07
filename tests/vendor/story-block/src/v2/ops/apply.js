// apply for ops (SPEC §2.3): a new state with JSON Patch ops applied in order, sharing unchanged
// branches. Pure.

import { INDEX, OPS } from './constants.js';
import { parsePath } from './paths.js';
import { clone, setKey } from './json.js';

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
