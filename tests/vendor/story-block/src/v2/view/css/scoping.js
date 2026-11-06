// The screen stylesheet scoper: limits, keyframe collection and recursive at-rule scoping. It uses the CSS
// syntax, value and selector checks, and returns the scoped CSS with plain-words warnings.

import {
    DROPPED, GROUPS, MAX_AT_DEPTH, MAX_CSS_BYTES, atName, bytes, groupItems, readItems, splitTop, stripComments,
} from './parse.js';
import { keyframePrefix, screenSelector, templateIdPrefix } from './names.js';
import { filterDeclarations, valueProblem } from './values.js';
import { scopeSelectorList, selectorEscape } from './selectors.js';

/**
 * Scope a screen's stylesheet. Returns `{ css, warnings }`; `css` is '' when nothing is usable or the
 * sheet is over 64 KB.
 */
export function scopeCss(source, screenId) {
    const warnings = [];
    const text = String(source ?? '');
    if (bytes(text) > MAX_CSS_BYTES) {
        return { css: '', warnings: [`The stylesheet is ${Math.ceil(bytes(text) / 1024)} KB; screens allow 64 KB. It was not used.`] };
    }
    const scope = screenSelector(screenId);
    const prefix = keyframePrefix(screenId);
    const clean = stripComments(text);
    if (/<\/?style|<\/?script/i.test(clean)) warnings.push('Markup inside the stylesheet was ignored.');
    const keyframes = new Map();
    const items = readItems(clean);
    collectKeyframes(items, prefix, keyframes);
    const css = scopeItems(items, { scope, keyframes, warnings, idPrefix: templateIdPrefix(screenId), depth: 0 }).join('\n');
    return { css, warnings };
}

function collectKeyframes(items, prefix, keyframes, depth = 0) {
    for (const item of items) {
        if (item.type !== 'rule' || item.prelude[0] !== '@') continue;
        const at = /^@(-webkit-|-moz-)?keyframes\s+(-?[A-Za-z_][\w-]*)/i.exec(item.prelude);
        if (at) keyframes.set(at[2], `${prefix}${at[2]}`);
        else if (GROUPS.has(atName(item.prelude)) && depth < MAX_AT_DEPTH) collectKeyframes(groupItems(item), prefix, keyframes, depth + 1);
    }
}

const indent = block => block.split('\n').map(line => `  ${line}`).join('\n');

function scopeItems(items, context) {
    const { scope, keyframes, warnings, idPrefix } = context;
    const out = [];
    for (const item of items) {
        if (item.prelude[0] === '@') {
            const name = atName(item.prelude);
            const vendor = /^@(-webkit-|-moz-)?/.exec(item.prelude)[1] ?? '';
            if (DROPPED.has(name)) {
                warnings.push(`Dropped @${name}: screens load nothing from outside and keep one page setup.`);
                continue;
            }
            if (item.type === 'statement') {
                if (name === 'layer') out.push(`${item.prelude};`);
                else warnings.push(`Dropped "${item.prelude.slice(0, 60)}".`);
                continue;
            }
            if (name === 'keyframes') {
                const original = /^@(?:-webkit-|-moz-)?keyframes\s+(-?[A-Za-z_][\w-]*)/i.exec(item.prelude)?.[1];
                if (!original) {
                    warnings.push(`Dropped "${item.prelude.slice(0, 60)}": keyframes need a plain name.`);
                    continue;
                }
                const frames = readItems(item.body).filter(frame => frame.type === 'rule').map(frame => {
                    const filtered = filterDeclarations(frame.body, { where: `@keyframes ${original}` });
                    warnings.push(...filtered.warnings);
                    return `  ${frame.prelude} { ${filtered.text} }`;
                });
                out.push(`@${vendor}keyframes ${keyframes.get(original)} {\n${frames.join('\n')}\n}`);
                continue;
            }
            if (name === 'font-face') {
                const filtered = filterDeclarations(item.body, { where: '@font-face' });
                warnings.push(...filtered.warnings);
                if (filtered.text) out.push(`@font-face { ${filtered.text} }`);
                continue;
            }
            if (GROUPS.has(name)) {
                if (context.depth >= MAX_AT_DEPTH) {
                    warnings.push(`Dropped @${name}: at-rules nest at most ${MAX_AT_DEPTH} deep in a screen.`);
                    continue;
                }
                const condition = item.prelude.slice(1 + vendor.length + name.length).trim();
                if (valueProblem(condition)) {
                    warnings.push(`Dropped @${name} ${condition.slice(0, 60)}: it names a URL.`);
                    continue;
                }
                // Each level indents what is inside it again: bounded, as the levels are (MAX_AT_DEPTH).
                const inner = scopeItems(groupItems(item), { ...context, depth: context.depth + 1 });
                if (inner.length) out.push(`@${vendor}${name}${condition ? ` ${condition}` : ''} {\n${inner.map(indent).join('\n')}\n}`);
                continue;
            }
            warnings.push(`Dropped @${name}: not allowed in a screen.`);
            continue;
        }
        if (item.type !== 'rule') {
            warnings.push(`Dropped "${item.prelude.slice(0, 60)}": not a rule.`);
            continue;
        }
        if (/[<>]\s*\/?\s*(?:style|script)/i.test(item.prelude) || valueProblem(item.prelude)) {
            warnings.push(`Dropped the rule "${item.prelude.slice(0, 60)}".`);
            continue;
        }
        // A selector that reaches past the screen's root is dropped; the rest of its list stays.
        const kept = splitTop(item.prelude, ',').filter(part => {
            const why = selectorEscape(part);
            if (why) warnings.push(`Dropped "${part.trim().slice(0, 60)}": it ${why}.`);
            return !why;
        }).join(',');
        const selector = scopeSelectorList(kept, scope, idPrefix);
        const filtered = filterDeclarations(item.body, { keyframes, where: item.prelude.slice(0, 60) });
        warnings.push(...filtered.warnings);
        if (selector && filtered.text) out.push(`${selector} { ${filtered.text} }`);
    }
    return out;
}
