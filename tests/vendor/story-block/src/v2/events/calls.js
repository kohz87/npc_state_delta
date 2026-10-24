// The only functions a condition can call. Each reads the beforeGenerate view (`{ state, query }`,
// SPEC §6) and returns plain data; none writes, waits or reaches outside the view.
//
// `quest`, `has`, `time` and `actor` read the head state's domains directly (layouts in SPEC §7 and
// MODULES B1/C1), so they work the same whether or not the owning module registered a query for it,
// and give null / false when that module is not installed. `query` is the open door to every other
// module's read-only queries, except this part's own (`events.*`), which would read itself.

import { aliasKey } from '../domains/names.js';

/** The allow-list, in the order error messages name it. */
export const CALLS = Object.freeze(['query', 'quest', 'has', 'time', 'actor', 'count']);

/** [fewest, most] values each call takes. */
export const ARITY = Object.freeze({
    query: [1, 2], quest: [1, 1], has: [1, 2], time: [0, 0], actor: [1, 1], count: [1, 1],
});

const MAX_QUERY_NAME = 80;
const lower = value => String(value).trim().toLowerCase();
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => isRecord(object) && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
const domain = (env, name) => own(own(env?.state, 'domains'), name);

function word(value, fail, what) {
    if (typeof value !== 'string' || !value.trim()) fail('TYPE', `${what} needs a name in quotes, not ${typeof value === 'string' ? 'an empty word' : describe(value)}.`);
    return value;
}

function describe(value) {
    if (value === null || value === undefined) return 'nothing (null)';
    if (Array.isArray(value)) return 'a list';
    return typeof value === 'object' ? 'a record' : `a ${typeof value === 'string' ? 'word' : typeof value}`;
}

/** Record ids in a fixed order: the order list given first, then the rest sorted. */
function orderedIds(records, order) {
    const ids = Object.keys(records).sort();
    const first = Array.isArray(order) ? order.filter(id => typeof id === 'string' && Object.hasOwn(records, id)) : [];
    return [...new Set([...first, ...ids])];
}

const FUNCTIONS = {
    /** query(name, args?): any registered read-only query but this part's own. */
    query(env, [name, args], fail) {
        word(name, fail, 'query()');
        if (name.length > MAX_QUERY_NAME) fail('LIMIT', `The query name is longer than ${MAX_QUERY_NAME} characters.`);
        if (name.startsWith('events.')) fail('NOT_ALLOWED', `A condition can't ask the events engine about itself ("${name}").`);
        if (typeof env?.query !== 'function') fail('CALL', `query("${name}") has nothing to ask: no queries are available here.`);
        let result;
        try {
            result = env.query(name, args);
        } catch (error) {
            fail('CALL', `query("${name}") failed: ${error?.message ?? String(error)}`);
        }
        if (result && typeof result.then === 'function') fail('CALL', `query("${name}") answers later; a condition needs its answer now.`);
        return result;
    },

    /** quest(key): the Director thread with this key or alias (any kind), or null. */
    quest(env, [key], fail) {
        word(key, fail, 'quest()');
        const director = domain(env, 'director');
        const threads = own(director, 'threads');
        if (!isRecord(threads)) return null;
        const wanted = lower(key);
        const id = own(own(director, 'keys'), wanted);
        if (typeof id === 'string' && isRecord(own(threads, id))) return threads[id];
        for (const threadId of orderedIds(threads)) {
            const thread = threads[threadId];
            if (isRecord(thread) && typeof thread.key === 'string' && lower(thread.key) === wanted) return thread;
        }
        return null;
    },

    /** has(itemName, qty = 1): does the party (any owner) hold at least qty of the item? */
    has(env, [name, qty = 1], fail) {
        word(name, fail, 'has()');
        if (!Number.isInteger(qty) || qty < 1) fail('TYPE', `has() counts in whole numbers from 1, not ${typeof qty === 'number' ? qty : describe(qty)}.`);
        const inventory = domain(env, 'inventory');
        const defs = own(inventory, 'defs');
        const stacks = own(inventory, 'stacks');
        if (!isRecord(stacks)) return false;
        // The inventory's own alias key ("The Rope" → "rope"), exact: no plural guessing in a condition.
        const wanted = aliasKey(name);
        const ids = new Set();
        const alias = own(own(inventory, 'aliases'), wanted);
        if (typeof alias === 'string') ids.add(alias);
        if (isRecord(defs)) {
            for (const [id, def] of Object.entries(defs)) {
                if (id === name || (isRecord(def) && typeof def.name === 'string' && aliasKey(def.name) === wanted)) ids.add(id);
            }
        }
        let total = 0;
        for (const stack of Object.values(stacks)) {
            if (isRecord(stack) && ids.has(stack.def) && Number.isInteger(stack.qty) && stack.qty > 0) total += stack.qty;
        }
        return total >= qty;
    },

    /** time(): the Director's story minutes, or null when there is no clock. */
    time(env) {
        const minutes = own(own(domain(env, 'director'), 'time'), 'minutes');
        return Number.isInteger(minutes) ? minutes : null;
    },

    /** actor(name): the party member with this id or name, or null. */
    actor(env, [name], fail) {
        word(name, fail, 'actor()');
        const party = domain(env, 'party');
        const actors = own(party, 'actors');
        if (!isRecord(actors)) return null;
        if (isRecord(own(actors, name))) return actors[name];
        const wanted = lower(name);
        for (const id of orderedIds(actors, own(party, 'order'))) {
            const actor = actors[id];
            if (isRecord(actor) && typeof actor.name === 'string' && lower(actor.name) === wanted) return actor;
        }
        return null;
    },

    /** count(list): items of a list, keys of a record, 0 for nothing. */
    count(env, [list], fail) {
        if (list === null || list === undefined) return 0;
        if (Array.isArray(list)) return list.length;
        if (isRecord(list)) return Object.keys(list).length;
        fail('TYPE', `count() counts a list or a record, not ${describe(list)}.`);
    },
};

/** Run one allow-listed call. `fail(code, message)` throws the evaluator's error. */
export function runCall(name, args, env, fail) {
    if (!CALLS.includes(name)) fail('NOT_ALLOWED', `"${name}" is not something a condition can call; it can call ${CALLS.join(', ')}.`);
    const [min, max] = ARITY[name];
    if (args.length < min || args.length > max) fail('SYNTAX', `${name}() takes ${min === max ? min : `${min} to ${max}`} values, not ${args.length}.`);
    return FUNCTIONS[name](env, args, fail);
}
