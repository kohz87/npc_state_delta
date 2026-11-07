// diff for ops (SPEC §2.3): the minimal JSON Patch changes from one state to another, with sorted
// object keys and whole-array replacements as described in ops.js. Pure.

import { escapeKey } from './paths.js';
import { clone, equal, isPlainObject } from './json.js';

/** diff(before, after, basePath = '') → Op[]: the minimal changes as described at the top. */
export function diff(before, after, basePath = '') {
    const ops = [];
    walkDiff(before, after, basePath, ops);
    return ops;
}

// Only the keys whose values differ are sorted and walked: a key whose values are `equal` writes no op,
// so the ops are the ones a walk over every key in sorted order writes, without that walk's cost for
// what stayed the same.
function walkDiff(a, b, path, ops) {
    if (a === b) return;
    if (isPlainObject(a) && isPlainObject(b)) {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        const changed = [];
        let added = 0;
        for (const key of keysB) {
            if (!Object.hasOwn(a, key)) {
                changed.push(key);
                added++;
            } else if (!equal(a[key], b[key])) {
                changed.push(key);
            }
        }
        // `b` holds every key of `a` exactly when it has no more keys than the ones it added.
        if (keysA.length !== keysB.length - added) for (const key of keysA) if (!Object.hasOwn(b, key)) changed.push(key);
        changed.sort();
        for (const key of changed) {
            const at = `${path}/${escapeKey(key)}`;
            if (!Object.hasOwn(b, key)) ops.push({ op: 'remove', path: at });
            else if (!Object.hasOwn(a, key)) ops.push({ op: 'add', path: at, value: clone(b[key]) });
            else walkDiff(a[key], b[key], at, ops);
        }
        return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (equal(a, b)) return;
        if (b.length > a.length && a.every((item, i) => equal(item, b[i]))) {
            // Appended at the end ("-"), not at a position: replayed after an earlier reply that added to
            // the list was deleted, an append still lands at the end (a position past it would not fit).
            for (let i = a.length; i < b.length; i++) ops.push({ op: 'add', path: `${path}/-`, value: clone(b[i]) });
        } else {
            ops.push({ op: 'replace', path, value: clone(b) });
        }
        return;
    }
    if (equal(a, b)) return;
    ops.push({ op: 'replace', path, value: clone(b) });
}
