// Binding text: value-to-text, {{ }} interpolation, `name: expr` pair lists and loop-name checks.

import { compileExpr, evalExpr } from './expressions.js';
import { IDENT, RESERVED } from './paths.js';

/** How a bound value reads as text: strings as they are, numbers and booleans as written, else ''. */
export function toText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.filter(item => ['string', 'number'].includes(typeof item)).map(toText).join(', ');
    return '';
}

/**
 * Split `{{ }}` interpolation into parts: strings and compiled expressions. Returns null when the text has
 * no complete `{{ … }}` (it is static).
 */
export function parseInterpolation(text) {
    const source = String(text ?? '');
    if (!source.includes('{{')) return null;
    const parts = [];
    let at = 0;
    for (;;) {
        const open = source.indexOf('{{', at);
        const close = open < 0 ? -1 : source.indexOf('}}', open + 2);
        if (open < 0 || close < 0) {
            if (at < source.length) parts.push(source.slice(at));
            break;
        }
        if (open > at) parts.push(source.slice(at, open));
        parts.push(compileExpr(source.slice(open + 2, close)));
        at = close + 2;
    }
    return parts.some(part => typeof part !== 'string') ? parts : null;
}

/** Interpolated text: every expression part read as text. */
export function interpolate(parts, scope, evaluate = null, onWarn = null) {
    return parts.map(part => (typeof part === 'string' ? part : toText(evalExpr(part, scope, evaluate, onWarn)))).join('');
}

/**
 * `name: expr; name: expr` lists (data-bind-attr, data-bind-var, data-class). Splits at `;` and the first
 * `:` outside quotes and brackets. Returns `[[name, exprText]]`.
 */
export function splitPairs(source) {
    const pairs = [];
    for (const part of splitTop(String(source ?? ''), ';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const name = part.slice(0, colon).trim();
        const expr = part.slice(colon + 1).trim();
        if (name && expr) pairs.push([name, expr]);
    }
    return pairs;
}

function splitTop(source, separator) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (const char of source) {
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === '\'') quote = char;
        else if (char === '(' || char === '[') depth += 1;
        else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
        else if (char === separator && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current);
    return parts;
}

/** True for a name a loop may give its items. */
export const isLoopName = name => IDENT.test(name) && !RESERVED.has(name);
