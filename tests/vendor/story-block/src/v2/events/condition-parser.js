// The condition language's recursive-descent parser: tokens become a plain, frozen AST with no code to run.

import { ARITY, CALLS } from './calls.js';
import { FORBIDDEN, LIMITS, fail, errorValue } from './condition-errors.js';
import { isNameChar, isNameStart, tokens } from './condition-tokenizer.js';

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
