// Shared CSS limits and tokenizing helpers for the screen stylesheet scoper: comments, items, top-level
// splits, escapes and at-rule names. These are syntax readers only; values and selectors are checked next.

export const MAX_CSS_BYTES = 64 * 1024;
// How deep group at-rules (@media, @supports, …) may nest inside each other.
export const MAX_AT_DEPTH = 8;

export const SCOPE_ALIASES = /^(?::root|html|body|:host|:scope)(?![\w-])/i;
export const GROUPS = new Set(['media', 'supports', 'container', 'layer', 'document']);
export const DROPPED = new Set(['import', 'charset', 'namespace', 'page']);

/** The deepest `{` nesting in a stylesheet (comments and strings skipped): `a { }` is 1. Linear. */
export function cssDepth(source) {
    const text = String(source ?? '');
    let depth = 0;
    let deepest = 0;
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === '\\') i += 1;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === '\'') quote = char;
        else if (char === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 1;
        } else if (char === '{') deepest = Math.max(deepest, ++depth);
        else if (char === '}') depth = Math.max(0, depth - 1);
    }
    return deepest;
}

/** UTF-8 length of a string. */
export function bytes(text) {
    return new TextEncoder().encode(text).length;
}

/** Drop comments, keeping strings intact. */
export function stripComments(text) {
    let out = '';
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            out += char;
            if (char === '\\' && i + 1 < text.length) out += text[++i];
            else if (char === quote) quote = null;
        } else if (char === '"' || char === '\'') {
            quote = char;
            out += char;
        } else if (char === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 1;
            out += ' ';
        } else out += char;
    }
    return out;
}

/**
 * Split a block of CSS into items: `{ type: 'rule', prelude, body }` for `x { … }` and
 * `{ type: 'statement', prelude }` for `x;`. Braces inside strings and parentheses are respected.
 */
export function readItems(text) {
    const items = [];
    let at = 0;
    while (at < text.length) {
        let quote = null;
        let paren = 0;
        let i = at;
        for (; i < text.length; i += 1) {
            const char = text[i];
            if (quote) {
                if (char === '\\') i += 1;
                else if (char === quote) quote = null;
            } else if (char === '"' || char === '\'') quote = char;
            else if (char === '(') paren += 1;
            else if (char === ')') paren = Math.max(0, paren - 1);
            else if (paren === 0 && (char === '{' || char === ';' || char === '}')) break;
        }
        const prelude = text.slice(at, i).trim();
        if (i >= text.length) {
            if (prelude) items.push({ type: 'statement', prelude });
            break;
        }
        if (text[i] === ';' || text[i] === '}') {
            if (prelude) items.push({ type: 'statement', prelude });
            at = i + 1;
            continue;
        }
        // Find the matching close brace.
        let depth = 1;
        let j = i + 1;
        quote = null;
        for (; j < text.length && depth > 0; j += 1) {
            const char = text[j];
            if (quote) {
                if (char === '\\') j += 1;
                else if (char === quote) quote = null;
            } else if (char === '"' || char === '\'') quote = char;
            else if (char === '{') depth += 1;
            else if (char === '}') depth -= 1;
        }
        items.push({ type: 'rule', prelude, body: text.slice(i + 1, depth === 0 ? j - 1 : j) });
        at = j;
    }
    return items;
}

/** Split at a separator outside strings and brackets. */
export function splitTop(text, separator) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === '\\' && i + 1 < text.length) {
                current += char + text[++i];
                continue;
            }
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

/** CSS escapes decoded (`\75 rl(` → `url(`), so checks see what the browser will. */
export function decodeEscapes(text) {
    return text.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([^\n])/g, (_, hex, char) => {
        if (char !== undefined) return char;
        const code = parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    });
}

/** The arguments of the call whose `(` is at `open`, up to its matching `)` (strings respected). */
export function callArgs(text, open) {
    let depth = 0;
    let quote = null;
    for (let i = open; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === '\\') i += 1;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === '\'') quote = char;
        else if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
}

// Each group's items are read once (kept on the item for scopeItems), so a sheet is read once per level.
export const groupItems = item => (item.items ??= readItems(item.body));

export function atName(prelude) {
    return (/^@(-webkit-|-moz-)?([\w-]+)/.exec(prelude)?.[2] ?? '').toLowerCase();
}
