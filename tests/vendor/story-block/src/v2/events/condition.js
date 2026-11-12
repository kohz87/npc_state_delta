// The condition language of pack events (SPEC §9, MODULES §E).
//
// A pack is data from somewhere else, so its conditions are never run as JavaScript: no `eval`, no
// `Function`, no property walk the source did not spell out. A condition is read by a small tokenizer
// and a recursive-descent parser into a plain AST, then walked by an evaluator that knows only these:
//
//   literals     12  3.5  'text'  "text"  true  false  null  { key: value }  (records only as call args)
//   operators    !  -(number)  <  <=  >  >=  ==  !=  &&  ||  ( … )   (a record or list == only null)
//   reads        .name  [index]   on what a call returned
//   calls        query(name, args?)  quest(key)  has(itemName, qty?)  time()  actor(name)  count(list)  region(name, …)
//
// Precedence, loosest first: `||`, `&&`, `== !=`, `< <= > >=`, `! -`, then `.x [n] (…)`. Comparisons
// do not chain (`1 < x < 3` is refused, write `1 < x && x < 3`). There is no truthiness: `&&`, `||`
// and `!` take true or false, `==` never converts (`1 == '1'` is false), `<` compares two numbers or two
// words. The whole condition must come out true or false.
//
// Other users of the language (SPEC §13.2 template expressions) may pass parse options for extra calls
// and bare names read from a scope; events never do, so a pack event sees exactly the list above.
//
// Errors are values. Nothing here throws at the caller: `parse` and `evaluate` return
// `{ ok: false, error: { code, message, at } }`, and `evaluateCondition` reports a condition that
// errors as not met, with the reason, so the Events debug section can say why an event waits.
// The errors, tokenizer and parser live in the adjacent condition-* files; this file keeps the evaluator and entry points.

import { CALLS, runCall } from './calls.js';
import { LIMITS, FORBIDDEN, fail, errorValue } from './condition-errors.js';
import { parse } from './condition-parser.js';

export { CALLS };
export { LIMITS } from './condition-errors.js';
export { tokenize } from './condition-tokenizer.js';
export { parse };

// ---------------------------------------------------------------- evaluator

/** A value's kind in the reader's words, for error messages. */
export function kindOf(value) {
    if (value === null || value === undefined) return 'nothing (null)';
    if (Array.isArray(value)) return 'a list';
    if (typeof value === 'number') return 'a number';
    if (typeof value === 'string') return 'a word';
    if (typeof value === 'boolean') return 'true/false';
    if (typeof value === 'object') return 'a record';
    return 'something that is not data';
}

const isPrimitive = value => value === null || ['number', 'string', 'boolean'].includes(typeof value);

/** What a read or a call gave, as data: undefined is null, anything that is not JSON-like is refused. */
function asData(value, at, what) {
    if (value === undefined) return null;
    if (isPrimitive(value)) {
        if (typeof value === 'number' && !Number.isFinite(value)) fail('TYPE', `${what} is not a finite number.`, at);
        return value;
    }
    if (typeof value === 'object') return value;
    fail('TYPE', `${what} is not data.`, at);
}

function read(object, key, at) {
    if (object === null || object === undefined) return null;   // reading through nothing gives nothing
    if (typeof key === 'string' && FORBIDDEN.has(key)) fail('NOT_ALLOWED', `A condition can't read "${key}".`, at);
    if (Array.isArray(object)) {
        if (typeof key === 'number') {
            if (!Number.isInteger(key) || key < 0) fail('TYPE', `A list is read at a whole number from 0, not ${key}.`, at);
            return key < object.length ? asData(object[key], at, `Item ${key}`) : null;
        }
        if (key === 'length') return object.length;
        fail('TYPE', `A list has no "${key}": read it at a number, or count() it.`, at);
    }
    if (typeof object === 'object') {
        if (typeof key !== 'string' && typeof key !== 'number') fail('TYPE', `A record is read at a name, not ${kindOf(key)}.`, at);
        const name = String(key);
        return Object.prototype.hasOwnProperty.call(object, name) ? asData(object[name], at, `"${name}"`) : null;
    }
    fail('TYPE', `Can't read "${key}" of ${kindOf(object)}.`, at);
}

function compare(op, left, right, at) {
    if (op === '==' || op === '!=') {
        // A record or list compares only with null ("is there one?"), never with another value.
        const equal = left === null || right === null ? left === right : null;
        if (equal !== null) return op === '==' ? equal : !equal;
        if (!isPrimitive(left) || !isPrimitive(right)) fail('TYPE', `${op} compares numbers, words, true/false and null, not ${kindOf(isPrimitive(left) ? right : left)}.`, at);
        return op === '==' ? left === right : left !== right;
    }
    const numbers = typeof left === 'number' && typeof right === 'number';
    const words = typeof left === 'string' && typeof right === 'string';
    if (!numbers && !words) fail('TYPE', `${op} needs two numbers or two words, not ${kindOf(left)} and ${kindOf(right)}.`, at);
    if (op === '<') return left < right;
    if (op === '<=') return left <= right;
    if (op === '>') return left > right;
    return left >= right;
}

function boolean(value, at, what) {
    if (typeof value !== 'boolean') fail('TYPE', `${what} needs true or false, not ${kindOf(value)}.`, at);
    return value;
}

function walker(env) {
    let calls = 0;
    function walk(node) {
        switch (node.type) {
            case 'lit': return node.value;
            case 'name': return read(env.scope ?? null, node.name, node.at);
            case 'record': {
                const out = {};
                for (const [key, value] of node.entries) out[key] = walk(value);
                return out;
            }
            case 'not': return !boolean(walk(node.arg), node.at, '!');
            case 'neg': {
                const value = walk(node.arg);
                if (typeof value !== 'number') fail('TYPE', `- needs a number, not ${kindOf(value)}.`, node.at);
                return value === 0 ? 0 : -value;
            }
            case 'logic': {
                const left = boolean(walk(node.left), node.at, `The left side of ${node.op}`);
                if (node.op === '&&' ? !left : left) return left;   // short-circuit: the right side is not read
                return boolean(walk(node.right), node.at, `The right side of ${node.op}`);
            }
            case 'compare': return compare(node.op, walk(node.left), walk(node.right), node.at);
            case 'member': return read(walk(node.object), node.key, node.at);
            case 'index': {
                const key = walk(node.key);
                if (typeof key !== 'number' && typeof key !== 'string') fail('TYPE', `[ … ] needs a number or a word, not ${kindOf(key)}.`, node.at);
                return read(walk(node.object), key, node.at);
            }
            case 'call': {
                calls += 1;
                if (calls > LIMITS.calls) fail('LIMIT', `The condition makes more than ${LIMITS.calls} calls.`, node.at);
                const args = node.args.map(walk);
                const raise = (code, message) => fail(code, message, node.at);
                if (CALLS.includes(node.name)) return asData(runCall(node.name, args, env, raise), node.at, `What ${node.name}() gave`);
                const extra = env.calls && Object.prototype.hasOwnProperty.call(env.calls, node.name) ? env.calls[node.name] : null;
                if (typeof extra !== 'function') raise('CALL', `${node.name}() is not available here.`);
                let result;
                try {
                    result = extra(...args);
                } catch (error) {
                    raise('CALL', `${node.name}() failed: ${error?.message ?? String(error)}`);
                }
                return asData(result, node.at, `What ${node.name}() gave`);
            }
            default: fail('SYNTAX', 'The condition is not a parsed condition.', node?.at ?? 0);
        }
    }
    return walk;
}

/**
 * Evaluate a parsed condition against `env` = `{ state, query }` (the beforeGenerate view).
 * `{ ok, value }` or `{ ok: false, error }`; the value may be any data (see `evaluateCondition`).
 */
export function evaluate(ast, env = {}) {
    try {
        if (!ast || typeof ast !== 'object') fail('SYNTAX', 'The condition is not a parsed condition.', 0);
        return { ok: true, value: walker(env ?? {})(ast) };
    } catch (error) {
        return { ok: false, error: errorValue(error) };
    }
}

const cache = new Map();
const CACHE_SIZE = 500;

/** Parse once per source text and options (conditions repeat every reply). Same result as `parse`. */
export function compile(source, options = {}) {
    let key = null;
    try {
        key = typeof source === 'string' ? JSON.stringify([options?.names === true, options?.calls ?? null, source]) : null;
    } catch {
        key = null;
    }
    if (key !== null && cache.has(key)) return cache.get(key);
    const parsed = parse(source, options);
    if (key !== null) {
        if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
        cache.set(key, parsed);
    }
    return parsed;
}

/**
 * Is this condition met? `{ met, value?, error? }`: met only when it parses, evaluates without error
 * and comes out exactly true. A condition that errors is not met and says why.
 */
export function evaluateCondition(source, env = {}) {
    const parsed = compile(source);
    if (!parsed.ok) return { met: false, error: parsed.error };
    const result = evaluate(parsed.ast, env);
    if (!result.ok) return { met: false, error: result.error };
    if (typeof result.value !== 'boolean') {
        return { met: false, value: result.value, error: { code: 'TYPE', message: `The condition gives ${kindOf(result.value)}, not true or false.`, at: 0 } };
    }
    return { met: result.value, value: result.value };
}
