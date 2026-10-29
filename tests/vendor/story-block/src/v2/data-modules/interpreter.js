// Interpreter 1. No host calls, randomness or mutable caches: the caller supplies a checked,
// frozen definition and a disposable instance. Reads refer to the original prefix, even when
// a preceding effect in this root has changed the draft.
import { DM_LIMITS as L, dmInt, dmObject, dmOwn } from './schema.js';
import { hashJson } from '../replay.js';

export const copy = value => structuredClone(value);
export const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
export class DataModuleError extends Error {
    constructor(code, path, message) { super(message); this.code = code; this.path = path; }
}
export const refuse = (code, path, message) => { throw new DataModuleError(code, path, message); };
export const atPath = (value, path) => path.reduce((next, key) => dmOwn(next, key) ? next[key] : null, value);

export function scalarHolds(schema, value) {
    if (!schema) return false;
    if (schema.type === 'int') return dmInt(value, schema.min, schema.max);
    if (schema.type === 'bool') return typeof value === 'boolean';
    if (schema.type === 'enum') return schema.values.includes(value);
    if (schema.type === 'text') return typeof value === 'string' && value.length <= schema.max;
    return schema.type === 'map' && dmObject(value) && Object.keys(value).length === schema.keys.length
        && schema.keys.every(key => dmOwn(value, key) && scalarHolds(schema.values, value[key]));
}

/** "guild, watch or compact" */
export const orList = values => {
    const list = values.map(String);
    return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`;
};
const ruleOf = schema => (schema.type === 'enum' ? `be ${orList(schema.values)}`
    : schema.type === 'int' ? `be a whole number from ${schema.min} to ${schema.max}` : 'be true or false');

// Each label of a line is one declared name with one value of its declared type; anything else is refused with a plain sentence
// ("faction must be guild, watch or compact"), never guessed. `text`: a story line (its values are text); else typed (a reader action).
export function parseLabels(definition, kind, labels, { text = false } = {}) {
    const args = {};
    const allowed = ['kind', ...(definition.scope === 'character' ? ['who'] : []), ...Object.keys(kind.labels)];
    for (const key of Object.keys(labels)) if (!allowed.includes(key)) refuse('DM_LABEL', key, key === 'who' ? 'this module has no characters, so who is not allowed' : `${key} is not a label of this line (${orList(allowed.filter(name => name !== 'kind'))})`);
    for (const [key, schema] of Object.entries(kind.labels)) {
        if (!dmOwn(labels, key)) refuse('DM_LABEL', key, `${key} is missing`);
        let value = labels[key];
        if (text) {
            if (schema.type === 'int' && /^-?\d+$/.test(value)) value = Number(value);
            if (schema.type === 'bool' && ['true', 'false'].includes(value)) value = value === 'true';
            if (schema.type === 'enum') {
                const matches = schema.values.filter(candidate => String(candidate) === value);
                if (matches.length === 1) value = matches[0];
            }
        }
        const valid = schema.type === 'int' ? dmInt(value, schema.min, schema.max)
            : schema.type === 'bool' ? typeof value === 'boolean' : schema.values.includes(value);
        if (!valid) refuse('DM_LABEL', key, `${key} must ${ruleOf(schema)}`);
        args[key] = value;
    }
    return args;
}

export function createEvaluation(definition, instance, { inputs = {}, source, cursor, subject = 'chat', lookup = null } = {}) {
    const original = copy(instance), reads = new Map(), notes = [], decisions = [], conds = [], written = new Set();
    let visits = 0, frame = null;
    const charge = (n = 1) => {
        visits += n;
        if (visits > L.rootVisits) refuse('DM_BUDGET', '', `More than ${L.rootVisits} evaluation visits; nothing applied.`);
    };
    // A read of the prefix. A field this root wrote already holds the root's own value, which the root's other reads decided.
    const read = path => {
        const key = JSON.stringify(path);
        if (!reads.has(key) && !written.has(JSON.stringify(path.slice(1)))) reads.set(key, { path: copy(path), value: copy(atPath(original, path)) });
    };
    const integer = value => {
        if (!dmInt(value, -L.integer, L.integer)) refuse('DM_BOUNDS', '', 'Unsafe arithmetic intermediate.');
        return value;
    };
    const pathOf = (path, env) => path.map(key => Array.isArray(key) ? evaluate(key, env) : key);
    function evaluate(node, env = {}) {
        charge();
        if (!Array.isArray(node)) return node;
        const [op, a, b, c] = node;
        if (op === 'get') {
            const path = pathOf(a, env);
            const key = JSON.stringify(path);
            // A guard asking again: the fields of its prefix, except those the root wrote before this condition (recorded).
            if (lookup) return lookup(path, key);
            const value = atPath(instance.fields, path);
            // In a condition the value is not read for itself: only the answer matters (see `condition`).
            if (frame) { if (written.has(key)) frame.internal[key] = value; return value; }
            read(['fields', ...path]);
            return value;
        }
        if (op === 'arg' || op === 'bind' || op === 'reward' || op === 'timer') {
            const value = env[op]?.[a];
            if (value === undefined) refuse('DM_SCHEMA', op, `Missing ${op} ${a}.`);
            return value;
        }
        if (op === 'input') {
            const value = inputs[a]?.[b];
            if (value === undefined || value === null || typeof value === 'object') refuse('DEPENDENCY_UNAVAILABLE', a, `Waiting for input ${a}.${b}.`);
            return value;
        }
        const x = evaluate(a, env);
        if (op === 'not') return !x;
        if (op === 'and') return x && evaluate(b, env);
        if (op === 'or') return x || evaluate(b, env);
        const y = evaluate(b, env);
        if (['add', 'sub', 'mul', 'min', 'max', 'floorDiv', 'clamp'].includes(op)) {
            integer(x); integer(y);
            if (op === 'add') return integer(x + y);
            if (op === 'sub') return integer(x - y);
            if (op === 'mul') return integer(x * y);
            if (op === 'min') return Math.min(x, y);
            if (op === 'max') return Math.max(x, y);
            if (op === 'floorDiv') {
                if (y <= 0) refuse('DM_BOUNDS', '', 'Division needs a positive divisor.');
                return Math.floor(x / y);
            }
            const z = integer(evaluate(c, env));
            if (y > z) refuse('DM_BOUNDS', '', 'Clamp bounds are reversed.');
            return Math.min(z, Math.max(y, x));
        }
        if (op === 'eq') return x === y;
        if (op === 'ne') return x !== y;
        if (op === 'lt') return x < y;
        if (op === 'le') return x <= y;
        if (op === 'gt') return x > y;
        if (op === 'ge') return x >= y;
        refuse('DM_SCHEMA', '', `Unsupported interpreter operation ${op}.`);
    }
    // A condition (a kind's `when`, a rule's, a reward's) is a question with a yes or no. What it read matters only through that
    // answer, so the answer is recorded with the fields it saw that this root had written itself, and a guard asks the same
    // question again on its prefix: an earlier change that leaves the answer as it was does not make the action stale.
    function condition(ref, expression, env) {
        if (typeof expression === 'boolean') return expression;
        const before = frame;
        frame = { internal: {} };
        let outcome;
        try { outcome = Boolean(evaluate(expression, env)); } finally {
            const done = frame;
            frame = before;
            if (outcome !== undefined) conds.push({ ref, env: copy(env), outcome, internal: done.internal });
        }
        return outcome;
    }
    function field(path) {
        const schema = definition.state[path[0]];
        if (!schema || path.length !== (schema.type === 'map' ? 2 : 1)
            || (schema.type === 'map' && !schema.keys.includes(path[1]))) refuse('DM_SCHEMA', path.join('.'), 'Undeclared field path.');
        return schema.type === 'map' ? schema.values : schema;
    }
    function write(path, value) {
        if (!scalarHolds(field(path), value)) refuse('DM_BOUNDS', path.join('.'), 'Field value is outside its schema.');
        // Saved ops omit no-ops. Witness the ORIGINAL destination even then: later conditions may
        // use this root's internal value, which is valid only while its starting value is unchanged.
        read(['fields', ...path]);
        const parent = path.length === 1 ? instance.fields : instance.fields[path[0]];
        parent[path.at(-1)] = value;
        written.add(JSON.stringify(path));
    }
    function freezeReward(template, bindings, env) {
        const reward = definition.rewards[template];
        if (!reward) refuse('DM_SCHEMA', template, 'Unknown reward template.');
        const bind = Object.fromEntries(Object.entries(bindings).map(([key, node]) => [key, evaluate(node, env)]));
        const values = {}, ranges = {};
        for (const [name, range] of Object.entries(reward.values)) {
            charge();
            const r = range.table ? range.table[String(bind[range.binding])] : range;
            ranges[name] = copy(r);
            values[name] = r.pick === 'min' ? r.min : r.pick === 'max' ? r.max : r.min + Math.floor((r.max - r.min) / 2);
        }
        const decision = { template, templateHash: hashJson(reward), bind, values, ranges, recipient: subject, source: copy(source), cursor: cursor ? { sid: cursor.sid, swipeKey: cursor.swipeKey, block: cursor.block } : null };
        decisions.push(copy(decision));
        return decision;
    }
    function settle(offer) {
        const reward = definition.rewards[offer.template];
        if (offer.templateHash !== hashJson(reward)) refuse('DM_SCHEMA', offer.template, 'The frozen template is damaged.');
        const env = { bind: offer.bind, reward: offer.values };
        if (!condition(['reward', offer.template], reward.when, env)) refuse('DM_CONDITION', offer.template, 'Reward condition is not met.');
        effects(reward.effects, env);
    }
    function effects(list, env = {}) {
        for (const effect of list) {
            charge();
            if (['set', 'add', 'clamp'].includes(effect.op)) {
                const path = pathOf(effect.path, env);
                const schema = field(path);
                let value;
                if (effect.op === 'set') value = evaluate(effect.value, env);
                else {
                    const before = atPath(instance.fields, path);
                    if (effect.op === 'clamp') value = Math.min(evaluate(effect.max, env), Math.max(evaluate(effect.min, env), before));
                    else {
                        const amount = integer(evaluate(effect.value, env));
                        value = integer(before + amount);
                        if (effect.bounds === 'clamp') {
                            const applied = Math.max(schema.min, Math.min(schema.max, value));
                            if (applied !== value) notes.push(`Requested ${amount >= 0 ? '+' : ''}${amount}; applied ${applied - before >= 0 ? '+' : ''}${applied - before} (${applied}/${schema.max}).`);
                            value = applied;
                        }
                    }
                }
                write(path, value);
            } else if (effect.op === 'reward') settle(freezeReward(effect.template, effect.bind, env));
            else if (effect.op === 'offer') {
                read(['offers', effect.key]); read(['settled', effect.key]);
                if (dmOwn(instance.offers, effect.key) || dmOwn(instance.settled, effect.key)) refuse('CLAIMED', effect.key, 'This offer key has already been used.');
                if (Object.keys(instance.offers).length + Object.keys(instance.settled).length >= L.offers) refuse('DM_BUDGET', effect.key, 'Offer keys exhausted.');
                instance.offers[effect.key] = freezeReward(effect.template, effect.bind, env);
            } else if (effect.op === 'award') {
                read(['offers', effect.offer]); read(['settled', effect.offer]);
                const offer = instance.offers[effect.offer];
                if (!offer || dmOwn(instance.settled, effect.offer)) refuse('CLAIMED', effect.offer, 'No outstanding offer with this key.');
                settle(offer);
                instance.settled[effect.offer] = { source: copy(source), offer: hashJson(offer) };
                delete instance.offers[effect.offer];
            } else refuse('DM_SCHEMA', '', 'Unsupported effect.');
        }
    }
    function timers() {
        for (const timer of definition.timers) {
            charge();
            const minute = inputs[timer.clock]?.minutes;
            if (minute === null || minute === undefined) continue;
            if (!dmInt(minute)) refuse('DM_BOUNDS', timer.id, 'Invalid story minute.');
            read(['timers', timer.id]);
            const clock = instance.timers[timer.id];
            if (!clock || clock.lastMinute === null) { instance.timers[timer.id] = { lastMinute: minute, remainder: 0 }; continue; }
            const elapsed = minute - clock.lastMinute;
            if (elapsed <= 0) continue;
            if (elapsed > L.elapsedMinutes) refuse('DM_BUDGET', timer.id, `More than ${L.elapsedMinutes} elapsed minutes; cursor unchanged.`);
            const total = elapsed + clock.remainder, periods = Math.floor(total / timer.every);
            // One aggregate additive change per effect; never a catch-up loop.
            if (periods) effects(timer.effects, { timer: { periods } });
            clock.lastMinute = minute;
            clock.remainder = total % timer.every;
        }
    }
    function rules() {
        for (const rule of definition.rules) { charge(); if (condition(['rule', rule.id], rule.when, {})) effects(rule.then); }
    }
    return { evaluate, condition, effects, timers, rules, charge, read,
        finish() {
            for (const [key, schema] of Object.entries(definition.state)) if (!scalarHolds(schema, instance.fields[key])) refuse('DM_BOUNDS', key, 'Invalid instance field.');
            if (bytes(instance) > L.instanceBytes) refuse('DM_BUDGET', '', 'Instance storage exhausted.');
            return { reads: [...reads.values()], visits, notes, decisions, conds };
        },
    };
}

/**
 * A guard asking a recorded condition again on its prefix: the same expression of the frozen definition, the recorded arguments, the
 * prefix's fields for everything the root had not written itself and the recorded value for what it had. Pure and bounded.
 * → true when the answer is the one recorded. Throws a DataModuleError when the condition cannot be evaluated (the guard then fails closed).
 */
export function conditionHolds(definition, record, prefixFields, inputs = {}) {
    const [kind, name] = Array.isArray(record?.ref) ? record.ref : [];
    const expression = kind === 'kind' ? definition.kinds?.[name]?.when : kind === 'rule' ? definition.rules?.find(rule => rule.id === name)?.when
        : kind === 'reward' ? definition.rewards?.[name]?.when : undefined;
    if (expression === undefined || !dmObject(record.internal) || typeof record.outcome !== 'boolean') refuse('DM_SCHEMA', '', 'A recorded condition is damaged.');
    const evaluation = createEvaluation(definition, { fields: prefixFields, timers: {}, offers: {}, settled: {} }, {
        inputs, lookup: (path, key) => (Object.hasOwn(record.internal, key) ? record.internal[key] : atPath(prefixFields, path)),
    });
    return (typeof expression === 'boolean' ? expression : Boolean(evaluation.evaluate(expression, record.env ?? {}))) === record.outcome;
}
