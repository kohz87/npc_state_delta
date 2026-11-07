// Small pure helpers shared by the split branch owners: byte size, JSON equality and record cloning.
// A pure part of branch.js (same owner, moved without change); branch.js re-exports every public name it exported
// before. Never imports branch.js.

export function utf8Bytes(value) {
    try { return new TextEncoder().encode(JSON.stringify(value ?? {})).byteLength; }
    catch { return Number.POSITIVE_INFINITY; }
}
export function jsonEqual(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch { return false; }
}
export function cloneNpcList(npcs) {
    return Array.isArray(npcs) ? structuredClone(npcs) : [];
}
