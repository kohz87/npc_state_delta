// Binding change checks: the JSON Pointers a carrier's ops touched and whether a pointer is touched by one
// at it, above it or below it. Pure set operations.

/** The set of JSON Pointers a carrier's ops touched (`ops` from its storySuite record). */
export function changedPointers(ops) {
    const set = new Set();
    for (const op of Array.isArray(ops) ? ops : []) if (typeof op?.path === 'string') set.add(op.path);
    return set;
}

/** True when any pointer in the set is the pointer, below it or above it. */
export function touches(pointers, pointer) {
    if (typeof pointer !== 'string' || !pointers?.size) return false;
    for (const path of pointers) {
        if (path === pointer || path.startsWith(`${pointer}/`) || pointer.startsWith(`${path}/`) || pointer === '' || path === '') return true;
    }
    return false;
}
