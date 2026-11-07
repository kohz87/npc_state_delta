// JSON Pointer paths for ops (SPEC §2.3): an object key as a pointer segment, a pointer as its keys,
// and a read at a pointer. Pure.

/** A JSON Pointer segment for an object key: `~` → `~0`, `/` → `~1`. */
export function escapeKey(key) {
    const text = String(key);
    if (!text.includes('~') && !text.includes('/')) return text;
    return text.replace(/~/g, '~0').replace(/\//g, '~1');
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
