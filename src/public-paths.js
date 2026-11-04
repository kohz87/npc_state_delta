/*
 * NPC State Delta public paths (Story Block 2.22.0 sdk.registerPublicPaths; docs/PUBLIC-API.md in Story Block).
 *
 * Offers `npc.<name>.<meter>` for every tracked NPC's shown meters (trust, affection, desire, tension and the custom ones, by meter id), plus
 * `npc.<name>.mood` and `npc.<name>.present`, to Story Block's public API (`StoryBlock.api.get`, `paths()`, `{{sb::npc.Mira.trust}}`, `story:changed`).
 *
 * Never offered: a meter the reader hides (the "Bar: Hide" choice), hidden notes (not a path at all), anything of an archived person.
 * Names are matched the way Story Block matches names (NFKC, lower case, spaces folded), never split at dots: "npc.Mr. Fox.trust" is the person
 * "Mr. Fox" and the meter "trust" (a meter id has no dot, so the last dot ends the name). An older Story Block has no registerPublicPaths and nothing happens.
 */
export const PUBLIC_PATHS_OWNER = 'npc-state-delta';
export const PUBLIC_PATHS_PREFIX = 'npc';

const fold = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The definition handed to sdk.registerPublicPaths.
 *   people()   [{ name, meters: { id: number }, hiddenMeters?: [id], present?: boolean, mood?: string }], archived people left out
 *   version()  optional, a cheap string that changes whenever people() would give something else
 * Reading is one pass over people() (the host asks for all values at once when it compares for `story:changed`).
 */
export function createPublicPathsDefinition({ people, version = null }) {
    // The host asks hidden(path) and get(path) once per path in one synchronous pass; the table is built once for that pass. It is kept only
    // while `version()` (a cheap token of what the table is made from) stays the same, and dropped on the next microtask in any case, so a
    // read after a scan, an edit or a chat switch sees the live values. Without a version it is kept for the microtask only.
    let memo = null;
    const token = () => {
        if (typeof version !== 'function') return '';
        try { return String(version()); } catch { return null; }
    };
    function table() {
        const now = token();
        if (memo && now !== null && memo.token === now) return memo.table;
        const built = build();
        memo = { token: now, table: built };
        try { queueMicrotask(() => { memo = null; }); } catch { memo = null; }
        return built;
    }
    function build() {
        const shown = new Map();    // folded path → { path, value }
        const hidden = new Set();   // folded paths of hidden meters
        let list = [];
        try { list = people(); } catch { list = []; }
        const seen = new Set();
        for (const person of Array.isArray(list) ? list : []) {
            const name = typeof person?.name === 'string' ? person.name.replace(/\s+/g, ' ').trim() : '';
            const who = fold(name);
            if (!name || seen.has(who)) continue;
            seen.add(who);
            const base = `${PUBLIC_PATHS_PREFIX}.${name}`;
            for (const id of Array.isArray(person.hiddenMeters) ? person.hiddenMeters : []) hidden.add(fold(`${base}.${id}`));
            for (const [id, value] of Object.entries(person.meters && typeof person.meters === 'object' ? person.meters : {})) {
                const path = `${base}.${id}`;
                if (hidden.has(fold(path)) || !Number.isFinite(value)) continue;
                shown.set(fold(path), { path, value });
            }
            // A meter of the same name wins over mood and present.
            if (typeof person.mood === 'string' && person.mood.trim() && !shown.has(fold(`${base}.mood`)) && !hidden.has(fold(`${base}.mood`))) {
                shown.set(fold(`${base}.mood`), { path: `${base}.mood`, value: person.mood.replace(/\s+/g, ' ').trim() });
            }
            if (typeof person.present === 'boolean' && !shown.has(fold(`${base}.present`)) && !hidden.has(fold(`${base}.present`))) {
                shown.set(fold(`${base}.present`), { path: `${base}.present`, value: person.present });
            }
        }
        return { shown, hidden };
    }
    return {
        owner: PUBLIC_PATHS_OWNER,
        prefix: PUBLIC_PATHS_PREFIX,
        paths: () => [...table().shown.values()].map(entry => entry.path),
        get: path => (typeof path === 'string' ? table().shown.get(fold(path))?.value : undefined),
        hidden: path => (typeof path === 'string' ? table().hidden.has(fold(path)) : false),
        values: () => Object.fromEntries([...table().shown.values()].map(entry => [entry.path, entry.value])),
    };
}
