// Binding scopes: the flat State view, helper roots, query hook, changed() check, and child scopes for drafts
// and loop items. The pointer and changed symbols stay private to this module pair.

import { changedPointers, touches } from './changes.js';
import { contains, defaultFormatters, len, pct, ratio, sum } from './helpers.js';
import { POINTERS, pointerOf } from './paths.js';

const EMPTY = Object.freeze({});

/** The flat view of a State document the scope's `state` root reads (`{ v, meta, ...domains }`). */
export function stateView(state) {
    if (!state || typeof state !== 'object') return Object.freeze({});
    return Object.freeze({ ...(state.domains ?? {}), v: state.v, meta: state.meta });
}

/**
 * Build a scope. `state` is the State document; `changed` is a Set (or array) of the JSON Pointers this
 * carrier's ops touched (the mounts' `changes`), or pass the carrier's `ops`; `formatters` overrides `fmt.money` / `fmt.time`; `query` (optional) is the host's
 * `query(name, args)`, for expressions such as `query('party.pc').level >= 3`. A missing draft is one
 * shared empty record, so building the scope again does not look like a new draft to the renderer.
 */
export function makeScope({ state = null, q = EMPTY, draft = EMPTY, settings = EMPTY, query = null, changed = null, ops = null, formatters = {} } = {}) {
    const pointers = changed instanceof Set ? changed : changedPointers(ops ?? (Array.isArray(changed) ? changed.map(path => ({ path })) : []));
    const format = { ...defaultFormatters, ...formatters };
    const fmt = Object.freeze({
        money: n => safeFormat(format.money, n),
        time: m => safeFormat(format.time, m),
    });
    const scope = { state: stateView(state), q: q ?? EMPTY, draft: draft ?? EMPTY, settings: settings ?? EMPTY, ratio, pct, len, contains, sum, fmt };
    if (typeof query === 'function') scope.query = query;
    Object.defineProperty(scope, POINTERS, { value: {}, enumerable: true });
    Object.defineProperty(scope, CHANGED, { value: pointers, enumerable: true });
    scope.changed = changedHelper(scope);
    return scope;
}

const CHANGED = Symbol('ss.changed');

/** True for a scope made by makeScope (or derived from one). */
export const isScope = scope => Boolean(scope && typeof scope === 'object' && scope[CHANGED] instanceof Set);

function safeFormat(fn, value) {
    try {
        const text = fn(value);
        return typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
    } catch {
        return '';
    }
}

function changedHelper(scope) {
    return path => {
        if (typeof path !== 'string') return false;
        const text = path.trim();
        const pointer = text === '' || text[0] === '/' ? text : pointerOf(scope, text);
        return touches(scope[CHANGED], pointer);
    };
}

/** The same scope with a new draft (helpers, pointers and loop names kept). */
export function withDraft(scope, draft) {
    const next = { ...scope, draft: draft ?? EMPTY };
    next.changed = changedHelper(next);
    return next;
}

/**
 * A child scope for one loop item: `name` is the item, `indexName` (optional) its index or record key.
 * `pointer` is the item's JSON Pointer into the State, or null.
 */
export function withItem(scope, name, value, pointer = null, indexName = null, index = undefined) {
    const next = { ...scope, [name]: value };
    const pointers = { ...scope[POINTERS] };
    if (typeof pointer === 'string') pointers[name] = pointer;
    else delete pointers[name];
    if (indexName) {
        next[indexName] = index;
        delete pointers[indexName];
    }
    Object.defineProperty(next, POINTERS, { value: pointers, enumerable: true });
    next.changed = changedHelper(next);
    return next;
}
