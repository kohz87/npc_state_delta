// The condition language's tokenizer: one condition's text becomes literal, operator, name and punctuation parts.

import { LIMITS, fail, errorValue } from './condition-errors.js';

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '-'];
const PUNCTUATION = new Set(['(', ')', '[', ']', '.', ',', '{', '}', ':']);
const ESCAPES = { '\\': '\\', '\'': '\'', '"': '"', n: '\n', t: '\t' };
const isDigit = char => char >= '0' && char <= '9';
export const isNameStart = char => (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
export const isNameChar = char => isNameStart(char) || isDigit(char);
const isSpace = char => char === ' ' || char === '\t' || char === '\n' || char === '\r';

export function tokens(source) {
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
