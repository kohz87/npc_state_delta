// Screen selector handling: scoping each selector list to the screen root, prefixing drawn ids, and checking
// whether a selector reaches past the root. Pure; packs use sheetEscape through the css.js facade.

import {
    GROUPS, MAX_AT_DEPTH, SCOPE_ALIASES, atName, callArgs, groupItems, readItems, splitTop, stripComments,
} from './parse.js';

/** `#name` in a selector becomes `#<prefix>name` (outside strings and `[…]`), matching the drawn ids. */
export function prefixIds(selector, prefix) {
    if (!prefix || !selector.includes('#')) return selector;
    let out = '';
    let quote = null;
    let bracket = 0;
    for (let i = 0; i < selector.length; i += 1) {
        const char = selector[i];
        out += char;
        if (quote) {
            if (char === '\\' && i + 1 < selector.length) out += selector[++i];
            else if (char === quote) quote = null;
        } else if (char === '"' || char === '\'') quote = char;
        else if (char === '\\' && i + 1 < selector.length) out += selector[++i];
        else if (char === '[') bracket += 1;
        else if (char === ']') bracket = Math.max(0, bracket - 1);
        else if (char === '#' && !bracket && /[-\w\\\u0080-\uffff]/.test(selector[i + 1] ?? '')) {
            // `#name` reaches the screen's first copy (`#<prefix>name`) and every other copy drawn at the
            // same time (`<prefix>name--c<n>`, template render.js); a name written with escapes, the first.
            const name = /^[-\w\u0080-\uffff]+/.exec(selector.slice(i + 1))?.[0] ?? '';
            const next = selector[i + 1 + name.length] ?? '';
            if (!name || next === '\\') {
                out += prefix;
                continue;
            }
            out = `${out.slice(0, -1)}:is(#${prefix}${name}, [id^="${prefix}${name}--c"])`;
            i += name.length;
        }
    }
    return out;
}

export function scopeSelector(selector, scope, idPrefix = '') {
    const text = prefixIds(selector.trim(), idPrefix);
    if (!text) return '';
    const alias = SCOPE_ALIASES.exec(text);
    if (alias) return `${scope}${text.slice(alias[0].length)}`;
    return `${scope} ${text}`;
}

export function scopeSelectorList(prelude, scope, idPrefix = '') {
    return splitTop(prelude, ',').map(part => scopeSelector(part, scope, idPrefix)).filter(Boolean).join(', ');
}

/**
 * A complex selector's compounds, each with the combinator before it: '' for the first, ' ' (descendant), '>', '+' or '~'.
 * Brackets, parentheses and strings are kept whole, so `[a="x ~ y"]` and `:is(.a, .b)` are one compound each.
 */
function compoundsOf(selector) {
    const text = String(selector ?? '');
    const out = [];
    let current = '';
    let pending = '';
    let depth = 0;
    let quote = null;
    const flush = () => {
        if (!current) return;
        out.push({ combinator: pending, text: current });
        current = '';
        pending = ' ';
    };
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            current += char;
            if (char === '\\' && i + 1 < text.length) current += text[++i];
            else if (char === quote) quote = null;
        } else if (char === '\\' && i + 1 < text.length) current += char + text[++i];
        else if (char === '"' || char === '\'') {
            quote = char;
            current += char;
        } else if (char === '(' || char === '[') {
            depth += 1;
            current += char;
        } else if (char === ')' || char === ']') {
            depth = Math.max(0, depth - 1);
            current += char;
        } else if (depth === 0 && (char === '>' || char === '+' || char === '~')) {
            flush();
            pending = char;
        } else if (depth === 0 && /\s/.test(char)) {
            flush();
            if (!pending) pending = ' ';
        } else current += char;
    }
    flush();
    return out;
}

/**
 * Why a selector would reach beyond the screen's root, as a phrase after `Dropped "…": it `, or '' when it only styles the
 * root or what is inside it. The screen's scope comes in front with a descendant combinator, so the selector styles inside
 * the root unless (a) it starts with a sibling combinator (`~ *`), (b) a root alias starts it and a combinator follows
 * (`:root ~ *`, `body .hud`: the alias becomes the root and the rest reaches its siblings or the page), or (c) a `:has()`
 * has a leading `+` or `~` (it looks at siblings of the element it is on, the root's own among them).
 */
export function selectorEscape(selector) {
    const text = String(selector ?? '').trim();
    const compounds = compoundsOf(text);
    if (!compounds.length) return '';
    const [first] = compounds;
    if (first.combinator === '+' || first.combinator === '~') return 'starts with a sibling combinator, which would reach the page beside the screen';
    if (SCOPE_ALIASES.test(first.text) && compounds.length > 1) return 'starts at :root, html or body and goes on from there, which would reach past the screen\'s root';
    for (const at of text.matchAll(/:has\(/gi)) {
        const args = callArgs(text, at.index + at[0].length - 1);
        if (splitTop(args, ',').some(part => /^\s*[+~]/.test(part))) return ':has() with a sibling combinator looks at the siblings of the screen\'s root';
    }
    return '';
}

/** The first reach problem in a sheet's selectors (inside its @-rule groups too), or ''. Pure: what packs/validate.js refuses. */
export function sheetEscape(source) {
    return escapeIn(readItems(stripComments(String(source ?? ''))), 0);
}

function escapeIn(items, depth) {
    for (const item of items) {
        if (item.type !== 'rule') continue;
        if (item.prelude[0] === '@') {
            if (GROUPS.has(atName(item.prelude)) && depth < MAX_AT_DEPTH) {
                const inner = escapeIn(groupItems(item), depth + 1);
                if (inner) return inner;
            }
            continue;
        }
        for (const part of splitTop(item.prelude, ',')) {
            const why = selectorEscape(part);
            if (why) return `"${part.trim().slice(0, 60)}" ${why}`;
        }
    }
    return '';
}
