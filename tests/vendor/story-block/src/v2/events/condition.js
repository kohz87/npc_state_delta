// The condition language of pack events (SPEC §9, MODULES §E).
//
// A pack is data from somewhere else, so its conditions are never run as JavaScript: no `eval`, no
// `Function`, no property walk the source did not spell out. A condition is read by a small tokenizer
// and a recursive-descent parser into a plain AST, then walked by an evaluator that knows only these:
//
//   literals     12  3.5  'text'  "text"  true  false  null  { key: value }  (records only as call args)
//   operators    !  -(number)  <  <=  >  >=  ==  !=  &&  ||  ( … )   (a record or list == only null)
//   reads        .name  [index]   on what a call returned
//   calls        query(name, args?)  quest(key)  has(itemName, qty?)  time()  actor(name)  count(list)
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

import { CALLS, ARITY, runCall } from './calls.js';

export { CALLS };

/** Size limits: a condition is a line, not a program. */
export const LIMITS = Object.freeze({
    source: 1000,  // characters of one condition
    tokens: 200,   // tokens of one condition
    depth: 24,     // nesting: each ( … ), call argument, [ … ], record value and ! or - is one level
    string: 200,   // characters of one quoted word
    name: 64,      // characters of one name
    keys: 8,       // entries of one { … } record
    calls: 32,     // calls made while evaluating one condition
});

/** Keys a read may never name, even when the data happens to hold them. */
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

const CODES = Object.freeze(['SYNTAX', 'LIMIT', 'NOT_ALLOWED', 'TYPE', 'CALL']);

class ConditionError extends Error {
    constructor(code, message, at = 0) {
        super(message);
        this.code = code;
        this.at = at;
    }
}

const fail = (code, message, at) => { throw new ConditionError(code, message, at); };

/** Error values carry a known code; anything unexpected becomes a CALL error, never a throw. */
function errorValue(error) {
    if (error instanceof ConditionError && CODES.includes(error.code)) return { code: error.code, message: error.message, at: error.at };
    if (error instanceof RangeError) return { code: 'LIMIT', message: 'The condition is nested too deeply to check.', at: 0 };
    return { code: 'CALL', message: `The condition could not be checked: ${error?.message ?? String(error)}`, at: 0 };
}

// ---------------------------------------------------------------- tokenizer

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '-'];
const PUNCTUATION = new Set(['(', ')', '[', ']', '.', ',', '{', '}', ':']);
const ESCAPES = { '\\': '\\', '\'': '\'', '"': '"', n: '\n', t: '\t' };
const isDigit = char => char >= '0' && char <= '9';
const isNameStart = char => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
const isNameChar = char => isNameStart(char) || isDigit(char);
const isSpace = char => char === ' ' || char === '\t' || char === '\n' || char === '\r';

function tokens(source) {
    if (typeof source !== 'string') fail('SYNTAX', 'A condition must be written as text.', 0);
    if (source.length > LIMITS.source) fail('LIMIT', `The condition is longer than ${LIMITS.source} characters.`, LIMITS.source);
    const out = [];
    let i = 0;
    const push = (type, value, at) => {
        if (out.length >= LIMITS.tokens) fail('LIMIT', `The condition has more than ${LIMITS.tokens} parts.`, at);
        out.push({ type, value, at });
    };
    while (i < source.length) {
        const char = source[i];
        if (isSpace(char)) { i += 1; continue; }
        const at = i;
        if (isDigit(char)) {
            while (isDigit(source[i])) i += 1;
            if (source[i] === '.' && isDigit(source[i + 1])) {
                i += 1;
                while (isDigit(source[i])) i += 1;
            }
            if (isNameChar(source[i] ?? '')) fail('SYNTAX', `A number runs into a name at character ${i + 1}.`, i);
            const value = Number(source.slice(at, i));
            if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail('LIMIT', `The number ${source.slice(at, i)} is too large.`, at);
            push('num', value, at);
            continue;
        }
        if (char === '\'' || char === '"') {
            let text = '';
            i += 1;
            for (;;) {
                if (i >= source.length || source[i] === '\n' || source[i] === '\r') fail('SYNTAX', `A quoted word opened at character ${at + 1} is never closed.`, at);
                const next = source[i];
                if (next === char) { i += 1; break; }
                if (next === '\\') {
                    const escaped = ESCAPES[source[i + 1]];
                    if (escaped === undefined) fail('SYNTAX', `Unknown escape \\${source[i + 1] ?? ''} at character ${i + 1}.`, i);
                    text += escaped;
                    i += 2;
                } else {
                    text += next;
                    i += 1;
                }
                if (text.length > LIMITS.string) fail('LIMIT', `A quoted word is longer than ${LIMITS.string} characters.`, at);
            }
            push('str', text, at);
            continue;
        }
        if (isNameStart(char)) {
            while (i < source.length && isNameChar(source[i])) i += 1;
            const name = source.slice(at, i);
            if (name.length > LIMITS.name) fail('LIMIT', `A name is longer than ${LIMITS.name} characters.`, at);
            push('name', name, at);
            continue;
        }
        const operator = OPERATORS.find(op => source.startsWith(op, i));
        if (operator) {
            push('op', operator, at);
            i += operator.length;
            continue;
        }
        if (PUNCTUATION.has(char)) {
            push('punc', char, at);
            i += 1;
            continue;
        }
        if (char === '=') fail('SYNTAX', `A single = at character ${at + 1}: use == to compare.`, at);
        if (char === '&' || char === '|') fail('SYNTAX', `A single ${char} at character ${at + 1}: use ${char}${char}.`, at);
        fail('SYNTAX', `Unexpected character ${JSON.stringify(char)} at character ${at + 1}.`, at);
    }
    out.push({ type: 'end', value: null, at: source.length });
    return out;
}

/** `{ ok, tokens }` or `{ ok: false, error }`. */
export function tokenize(source) {
    try {
        return { ok: true, tokens: tokens(source) };
    } catch (error) {
        return { ok: false, error: errorValue(error) };
    }
}

// ---------------------------------------------------------------- parser

const EQUALITY = new Set(['==', '!=']);
const COMPARISON = new Set(['<', '<=', '>', '>=']);
const LITERAL_NAMES = { true: true, false: false, null: null };

function describeToken(token) {
    if (token.type === 'end') return 'the end of the condition';
    if (token.type === 'str') return `the word ${JSON.stringify(token.value)}`;
    return `${JSON.stringify(String(token.value))} at character ${token.at + 1}`;
}

/** Parse options (SPEC §13.2 reuse): extra call names with their arity, and bare names from a scope. */
function readOptions(options) {
    const extra = {};
    const given = options?.calls;
    if (given !== undefined && given !== null) {
        if (typeof given !== 'object' || Array.isArray(given)) fail('SYNTAX', 'Extra calls are given as { name: [fewest, most] }.', 0);
        for (const [name, arity] of Object.entries(given)) {
            const parts = name.split('.');
            if (!parts.every(part => part && isNameStart(part[0]) && [...part].every(isNameChar)) || parts.some(part => FORBIDDEN.has(part))) fail('SYNTAX', `"${name}" can't be a call name.`, 0);
            if (CALLS.includes(name)) fail('SYNTAX', `"${name}" is already a call of the language.`, 0);
            if (!Array.isArray(arity) || !Number.isInteger(arity[0]) || !Number.isInteger(arity[1]) || arity[0] < 0 || arity[1] < arity[0] || arity[1] > 8) fail('SYNTAX', `The extra call "${name}" needs its arity as [fewest, most].`, 0);
            extra[name] = [arity[0], arity[1]];
        }
    }
    return { extra, names: options?.names === true };
}

function parser(list, options) {
    const { extra, names } = options;
    const callable = [...CALLS, ...Object.keys(extra).sort()];
    let index = 0;
    let depth = 0;
    const peek = () => list[index];
    const next = () => list[index++];
    const is = (type, value) => peek().type === type && (value === undefined || peek().value === value);
    const expect = (type, value, what) => {
        if (!is(type, value)) fail('SYNTAX', `Expected ${what}, found ${describeToken(peek())}.`, peek().at);
        return next();
    };
    const nested = (at, fn) => {
        depth += 1;
        if (depth > LIMITS.depth) fail('LIMIT', `The condition is nested more than ${LIMITS.depth} levels deep.`, at);
        try { return fn(); } finally { depth -= 1; }
    };

    function expression() {
        return nested(peek().at, orExpr);
    }
    function orExpr() {
        let left = andExpr();
        while (is('op', '||')) {
            const at = next().at;
            left = { type: 'logic', op: '||', left, right: andExpr(), at };
        }
        return left;
    }
    function andExpr() {
        let left = equality();
        while (is('op', '&&')) {
            const at = next().at;
            left = { type: 'logic', op: '&&', left, right: equality(), at };
        }
        return left;
    }
    function equality() {
        const left = comparison();
        if (!(peek().type === 'op' && EQUALITY.has(peek().value))) return left;
        const { value: op, at } = next();
        const node = { type: 'compare', op, left, right: comparison(), at };
        if (peek().type === 'op' && EQUALITY.has(peek().value)) fail('SYNTAX', `Comparisons do not chain (character ${peek().at + 1}): join them with && instead.`, peek().at);
        return node;
    }
    function comparison() {
        const left = unary();
        if (!(peek().type === 'op' && COMPARISON.has(peek().value))) return left;
        const { value: op, at } = next();
        const node = { type: 'compare', op, left, right: unary(), at };
        if (peek().type === 'op' && COMPARISON.has(peek().value)) fail('SYNTAX', `Comparisons do not chain (character ${peek().at + 1}): write a < b && b < c instead.`, peek().at);
        return node;
    }
    function unary() {
        if (is('op', '!') || is('op', '-')) {
            const { value, at } = next();
            return nested(at, () => ({ type: value === '!' ? 'not' : 'neg', arg: unary(), at }));
        }
        return postfix();
    }
    function postfix() {
        let node = primary();
        for (;;) {
            if (is('punc', '.')) {
                const at = next().at;
                const name = expect('name', undefined, 'a name after "."');
                if (FORBIDDEN.has(name.value)) fail('NOT_ALLOWED', `A condition can't read ".${name.value}".`, name.at);
                node = { type: 'member', object: node, key: name.value, at };
            } else if (is('punc', '[')) {
                const at = next().at;
                const key = expression();
                expect('punc', ']', '"]"');
                node = { type: 'index', object: node, key, at };
            } else if (is('punc', '(')) {
                fail('NOT_ALLOWED', `Only ${callable.join(', ')} can be called (character ${peek().at + 1}).`, peek().at);
            } else return node;
        }
    }
    function primary() {
        const token = peek();
        if (token.type === 'num' || token.type === 'str') {
            next();
            return { type: 'lit', value: token.value, at: token.at };
        }
        if (token.type === 'name') {
            const dotted = dottedCall();
            if (dotted) return dotted;
            next();
            if (is('punc', '(')) return call(token.value, token.at);
            if (Object.hasOwn(LITERAL_NAMES, token.value)) return { type: 'lit', value: LITERAL_NAMES[token.value], at: token.at };
            if (names) {
                if (FORBIDDEN.has(token.value)) fail('NOT_ALLOWED', `A condition can't read "${token.value}".`, token.at);
                return { type: 'name', name: token.value, at: token.at };
            }
            fail('NOT_ALLOWED', `Unknown name "${token.value}" at character ${token.at + 1}: a condition reads the story through ${callable.map(name => `${name}()`).join(', ')}.`, token.at);
        }
        if (is('punc', '(')) {
            next();
            const node = expression();
            expect('punc', ')', '")"');
            return node;
        }
        if (is('punc', '{')) return record();
        fail('SYNTAX', `Expected a value, found ${describeToken(token)}.`, token.at);
    }
    /** An extra call with a dotted name (`fmt.money(…)`), when the options give one. */
    function dottedCall() {
        let end = index;
        let name = list[end].value;
        while (list[end + 1]?.type === 'punc' && list[end + 1].value === '.' && list[end + 2]?.type === 'name') {
            name += `.${list[end + 2].value}`;
            end += 2;
        }
        if (end === index || !Object.hasOwn(extra, name) || !(list[end + 1]?.type === 'punc' && list[end + 1].value === '(')) return null;
        const at = list[index].at;
        index = end + 1;
        return call(name, at);
    }
    function call(name, at) {
        if (!callable.includes(name)) fail('NOT_ALLOWED', `"${name}" is not something a condition can call; it can call ${callable.join(', ')}.`, at);
        expect('punc', '(', '"("');
        const args = [];
        if (!is('punc', ')')) {
            for (;;) {
                args.push(expression());
                if (!is('punc', ',')) break;
                next();
            }
        }
        expect('punc', ')', `"," or ")" in ${name}(…)`);
        const [min, max] = ARITY[name] ?? extra[name];
        if (args.length < min || args.length > max) {
            const wanted = min === max ? `${min}` : `${min} to ${max}`;
            fail('SYNTAX', `${name}() takes ${wanted} value${max === 1 ? '' : 's'}, not ${args.length}.`, at);
        }
        return { type: 'call', name, args, at };
    }
    function record() {
        const at = next().at;
        const entries = [];
        if (!is('punc', '}')) {
            for (;;) {
                const keyToken = peek();
                if (keyToken.type !== 'name' && keyToken.type !== 'str') fail('SYNTAX', `Expected a key in { … }, found ${describeToken(keyToken)}.`, keyToken.at);
                next();
                if (FORBIDDEN.has(keyToken.value)) fail('NOT_ALLOWED', `A record can't have the key "${keyToken.value}".`, keyToken.at);
                if (entries.some(([key]) => key === keyToken.value)) fail('SYNTAX', `The key "${keyToken.value}" is written twice.`, keyToken.at);
                expect('punc', ':', '":" after a key');
                entries.push([keyToken.value, expression()]);
                if (entries.length > LIMITS.keys) fail('LIMIT', `A record has more than ${LIMITS.keys} keys.`, keyToken.at);
                if (!is('punc', ',')) break;
                next();
            }
        }
        expect('punc', '}', '"," or "}"');
        return { type: 'record', entries, at };
    }

    const ast = expression();
    if (!is('end')) fail('SYNTAX', `Unexpected ${describeToken(peek())}.`, peek().at);
    return ast;
}

/**
 * `{ ok, ast }` or `{ ok: false, error }`. The AST is plain, frozen data.
 * Options, for other users of the language (SPEC §13.2 template expressions); events use neither:
 *   calls: { 'fmt.money': [1, 1], ratio: [2, 2] }  extra call names (dotted allowed) with their arity;
 *                                                  `evaluate` finds them in `env.calls[name]`
 *   names: true                                    bare names (`hp.cur`, `q.party`) read `env.scope`
 */
export function parse(source, options = {}) {
    try {
        if (typeof source === 'string' && !source.trim()) fail('SYNTAX', 'The condition is empty.', 0);
        return { ok: true, ast: deepFreeze(parser(tokens(source), readOptions(options))) };
    } catch (error) {
        return { ok: false, error: errorValue(error) };
    }
}

function deepFreeze(node) {
    if (node && typeof node === 'object') {
        for (const value of Object.values(node)) deepFreeze(value);
        Object.freeze(node);
    }
    return node;
}

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
