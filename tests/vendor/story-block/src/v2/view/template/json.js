// JSON with `{{ }}` holes (data-payload, data-props). A hole inside a JSON string is filled with the value's
// text, escaped for JSON, so a bound value can never end the string or add keys; a hole outside a string
// is filled with the value as JSON (a number, true/false, null, a list or record). The result is parsed
// with JSON.parse; anything that does not parse to a record is refused.

import { compileExpr, evalExpr, toText } from '../bind.js';

// How deep records and lists may nest in data-props or data-payload (B-b5b-robust-r2-3): deeper JSON
// is refused before it is parsed, so it never reaches code that walks it (and runs out of stack).
export const MAX_JSON_DEPTH = 16;

/** How deep `{` and `[` nest in JSON text, counted outside strings in one pass (no recursion). */
export function jsonDepth(text) {
    const source = String(text ?? '');
    let depth = 0;
    let deepest = 0;
    let inString = false;
    for (let i = 0; i < source.length; i += 1) {
        const char = source[i];
        if (inString) {
            if (char === '\\') i += 1;
            else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === '{' || char === '[') deepest = Math.max(deepest, depth += 1);
        else if (char === '}' || char === ']') depth -= 1;
    }
    return deepest;
}

/**
 * Compile JSON text with holes. Returns `{ parts }` (strings and `{ expr, inString }`), or `{ value }` for
 * plain JSON, or null (with a warning) when plain JSON does not parse.
 */
export function compileJson(text, warnings = [], where = 'JSON') {
    const source = String(text ?? '');
    const parts = [];
    let inString = false;
    let buffer = '';
    for (let i = 0; i < source.length; i += 1) {
        if (source.startsWith('{{', i)) {
            const close = source.indexOf('}}', i + 2);
            if (close >= 0) {
                parts.push(buffer, { expr: source.slice(i + 2, close), inString });
                buffer = '';
                i = close + 1;
                continue;
            }
        }
        const char = source[i];
        if (inString && char === '\\') {
            buffer += char + (source[i + 1] ?? '');
            i += 1;
            continue;
        }
        if (char === '"') inString = !inString;
        buffer += char;
    }
    parts.push(buffer);
    if (jsonDepth(parts.filter(part => typeof part === 'string').join('')) > MAX_JSON_DEPTH) {
        warnings.push(`${where} nests records or lists more than ${MAX_JSON_DEPTH} deep.`);
        return null;
    }
    if (parts.length === 1) {
        const parsed = parseRecord(source);
        if (!parsed.ok) {
            warnings.push(`${where} is not a JSON record: ${parsed.error}`);
            return null;
        }
        return { value: parsed.value };
    }
    return { parts: parts.map(part => (typeof part === 'string' ? part : { expr: compileExpr(part.expr), inString: part.inString })) };
}

/** Fill and parse: `{ ok: true, value }` or `{ ok: false, error }`. A fresh object every call. */
export function fillJson(compiled, scope, evaluate = null, onWarn = null) {
    if (!compiled) return { ok: false, error: 'The JSON could not be read.' };
    if (!compiled.parts) return { ok: true, value: structuredClone(compiled.value) };
    const text = compiled.parts.map(part => {
        if (typeof part === 'string') return part;
        const value = evalExpr(part.expr, scope, evaluate, onWarn);
        if (part.inString) return JSON.stringify(toText(value)).slice(1, -1);
        return jsonValue(value);
    }).join('');
    if (jsonDepth(text) > MAX_JSON_DEPTH) return { ok: false, error: `it nests records or lists more than ${MAX_JSON_DEPTH} deep.` };
    return parseRecord(text);
}

function jsonValue(value) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    try {
        return JSON.stringify(value) ?? 'null';
    } catch {
        return 'null';
    }
}

function parseRecord(text) {
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'it must be a record ({ … }).' };
        return { ok: true, value };
    } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
    }
}
