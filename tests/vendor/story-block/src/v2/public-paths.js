// Public paths from modules (docs/v2/PUBLIC-API.md "Paths from modules"): a module that keeps values of its own (NPC State Delta's meters) offers
// them under ONE prefix through `sdk.registerPublicPaths({ owner, prefix, paths(), get(path), hidden(path) })`. The public API (`api.get`,
// `api.paths`, `{{sb::…}}`, the `story:changed` lists) then includes them. This file only keeps the registrations and guards what comes back:
// a value is a frozen plain copy of JSON data, a hidden path reads as `undefined` and is not listed, a module that throws is read as having nothing.
const PREFIX = /^[a-z][a-z0-9_-]{0,31}$/;
/** The roots Story Block's own paths use; a module's prefix may not be one of them. */
export const OWN_ROOTS = Object.freeze(['scene', 'money', 'items', 'party', 'blocks']);
/** The most paths one module is read for (a runaway list is cut here). */
export const MAX_MODULE_PATHS = 5000;

const fold = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const plainData = value => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(plainData);
    if (typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        return (proto === Object.prototype || proto === null) && Object.values(value).every(plainData);
    }
    return false;
};

/** createPublicPaths() → the registrations: { register, prefixes(), owns(path), get(path), paths(), leaves(), onChange(fn) }. */
export function createPublicPaths({ log = console.warn } = {}) {
    const byPrefix = new Map();   // folded prefix → { owner, prefix, def }
    const listeners = new Set();
    const tell = (what, error) => { try { log(`[Story Block API] a module's public paths ${what}`, error); } catch { /* nothing to tell it to */ } };
    const changed = kind => { for (const fn of [...listeners]) { try { fn(kind); } catch (error) { tell('listener failed', error); } } };

    function register(options) {
        if (!options || typeof options !== 'object') throw new Error('registerPublicPaths needs { owner, prefix, paths, get, hidden }.');
        const owner = typeof options.owner === 'string' ? options.owner.trim() : '';
        if (!owner) throw new Error('registerPublicPaths: "owner" must be the module id.');
        const prefix = typeof options.prefix === 'string' ? options.prefix.trim() : '';
        if (!PREFIX.test(prefix)) throw new Error('registerPublicPaths: "prefix" must be one lowercase word (letters, digits, - and _), with no dots.');
        if (OWN_ROOTS.includes(prefix)) throw new Error(`registerPublicPaths: "${prefix}" is one of Story Block's own paths (${OWN_ROOTS.join(', ')}).`);
        if (typeof options.paths !== 'function' || typeof options.get !== 'function') throw new Error('registerPublicPaths: "paths" and "get" must be functions.');
        if (options.hidden !== undefined && typeof options.hidden !== 'function') throw new Error('registerPublicPaths: "hidden" must be a function.');
        const held = byPrefix.get(prefix);
        if (held && held.owner !== owner) throw new Error(`registerPublicPaths: the prefix "${prefix}" belongs to "${held.owner}".`);
        if (options.values !== undefined && typeof options.values !== 'function') throw new Error('registerPublicPaths: "values" must be a function.');
        const entry = { owner, prefix, def: { paths: options.paths, get: options.get, hidden: options.hidden ?? (() => false), values: options.values } };
        byPrefix.set(prefix, entry);
        changed('registry');
        let done = false;
        const unregister = () => {
            if (done) return;
            done = true;
            if (byPrefix.get(prefix) === entry) { byPrefix.delete(prefix); changed('registry'); }
        };
        // `changed()`: the module says its values moved (a scan finished); the API compares and tells `story:changed` for the new values.
        Object.defineProperty(unregister, 'changed', { value: () => { if (!done && byPrefix.get(prefix) === entry) changed('values'); } });
        return Object.freeze(unregister);
    }

    const hiddenPath = (entry, path) => { try { return entry.def.hidden(path) === true; } catch { return true; } };
    const entryOf = path => {
        if (typeof path !== 'string') return null;
        const root = fold(path).split('.')[0];
        return byPrefix.get(root) ?? null;
    };
    function get(path) {
        const entry = entryOf(path);
        if (!entry || hiddenPath(entry, path)) return undefined;
        try {
            const value = entry.def.get(path);
            return plainData(value) ? structuredClone(value) : undefined;
        } catch (error) { tell('could not be read', error); return undefined; }
    }
    function pathsOf(entry) {
        let list;
        try { list = entry.def.paths(); } catch (error) { tell('could not be listed', error); return []; }
        if (!Array.isArray(list)) return [];
        const seen = new Set();
        const out = [];
        for (const path of list) {
            if (typeof path !== 'string' || !path || fold(path).split('.')[0] !== entry.prefix || hiddenPath(entry, path)) continue;
            const key = fold(path);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(path);
            if (out.length >= MAX_MODULE_PATHS) break;
        }
        return out;
    }
    return {
        register,
        prefixes: () => [...byPrefix.keys()],
        owns: path => entryOf(path) !== null,
        get,
        paths: () => [...byPrefix.values()].flatMap(pathsOf),
        /** path → value of every listed path, for the diff (a module's optional values() gives them all in one call). */
        leaves() {
            const out = new Map();
            for (const entry of byPrefix.values()) {
                // `values()` (optional): every path's value in one call, for a module whose get() is dear; else paths() and get().
                if (typeof entry.def.values === 'function') {
                    try {
                        const all = entry.def.values();
                        if (all && typeof all === 'object') {
                            for (const [path, value] of Object.entries(all)) {
                                if (fold(path).split('.')[0] === entry.prefix && !hiddenPath(entry, path) && plainData(value)) out.set(path, structuredClone(value));
                            }
                            continue;
                        }
                    } catch (error) { tell('could not be read', error); }
                }
                for (const path of pathsOf(entry)) {
                    const value = get(path);
                    if (value !== undefined) out.set(path, value);
                }
            }
            return out;
        },
        /** fn('registry') when a prefix comes or goes, fn('values') when a module says its values moved. */
        onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    };
}
