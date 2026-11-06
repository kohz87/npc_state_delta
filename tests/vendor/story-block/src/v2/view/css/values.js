// CSS values for screens: URL and script checks, declaration filtering, theme custom properties and the
// value a data binding may set as a custom property. Every function is pure.

import { callArgs, decodeEscapes, splitTop, stripComments } from './parse.js';

/** True for a URL a screen may load: `https:` or `data:` (control characters and spaces ignored). */
export function isSafeCssUrl(url) {
    const flat = String(url).replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
    return flat.startsWith('https:') || flat.startsWith('data:');
}

// Functions whose arguments the browser loads (url() is read on its own above). Their strings must be
// data:/https: URLs, and they may not take a value from var(), attr() or env(): a custom property can
// hold any URL as a plain string (`--a: "http://…"`), and `image-set(var(--a) 1x)` would load it.
const LOADERS = /(?:^|[^\w-])((?:-webkit-|-moz-)?(?:image-set|image|cross-fade|src|url))\s*\(/gi;
const STRING = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
// A quoted string that names a URL: a scheme with `//`, a protocol-relative `//`, or a scheme that loads
// or runs. Only data: and https: ones are kept, wherever they stand (custom properties included).
const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:javascript|vbscript|livescript|data|blob|file|filesystem):)/i;

/**
 * Why a declaration value is refused, or '' when it is fine. Looks at the decoded value: script URLs,
 * `expression(`, `url()` that is not data:/https:, strings in `image-set()`/`image()`/`cross-fade()`/`src()`
 * that are not either, those functions fed from `var()`/`attr()`/`env()`, and any quoted URL that is not
 * data:/https: (so a custom property cannot carry one to a loader elsewhere).
 */
export function valueProblem(value) {
    const plain = decodeEscapes(String(value));
    const flat = plain.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
    if (flat.includes('javascript:') || flat.includes('vbscript:')) return 'a script URL';
    if (flat.includes('expression(')) return 'expression()';
    if (/[<>]/.test(plain) && /<\/?style|<\/?script/i.test(plain)) return 'markup';
    for (const match of plain.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
        const url = match[1] ?? match[2] ?? match[3] ?? '';
        if (!isSafeCssUrl(url)) return `the URL "${url.trim().slice(0, 60)}"`;
    }
    if (/url\(/i.test(plain) && !/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/i.test(plain)) return 'an unclosed url(';
    for (const match of plain.matchAll(LOADERS)) {
        const name = match[1].toLowerCase();
        const args = callArgs(plain, match.index + match[0].length - 1);
        if (/(?:^|[^\w-])(?:var|attr|env)\s*\(/i.test(args)) return `${name}() fed from var(), attr() or env()`;
        for (const string of args.matchAll(STRING)) {
            const url = string[1] ?? string[2];
            if (!isSafeCssUrl(url)) return `the URL "${url.slice(0, 60)}"`;
        }
    }
    for (const string of plain.matchAll(STRING)) {
        const url = (string[1] ?? string[2]).replace(/[\u0000-\u0020\u007f]+/g, '');
        if (URLISH.test(url) && !isSafeCssUrl(url)) return `the URL "${url.slice(0, 60)}"`;
    }
    return '';
}

/**
 * Filter a declaration list (a rule's body or a `style` attribute). Returns `{ text, warnings }` with
 * the declarations kept, `prop: value` joined by `; `. `keyframes` maps names to their prefixed form.
 */
export function filterDeclarations(body, { keyframes = null, where = 'style' } = {}) {
    const kept = [];
    const warnings = [];
    for (const raw of splitTop(stripComments(String(body ?? '')), ';')) {
        const text = raw.trim();
        if (!text) continue;
        const colon = text.indexOf(':');
        if (colon <= 0) {
            warnings.push(`Dropped "${text.slice(0, 60)}" in ${where}: not a declaration.`);
            continue;
        }
        const prop = text.slice(0, colon).trim();
        let value = text.slice(colon + 1).trim();
        if (!value) continue;
        const name = decodeEscapes(prop).toLowerCase();
        if (!/^-{0,2}[a-z][a-z0-9-]*$/i.test(prop) || /[{}]/.test(value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ''))) {
            warnings.push(`Dropped "${text.slice(0, 60)}" in ${where}: not a declaration.`);
            continue;
        }
        if (name === 'behavior' || name === '-moz-binding') {
            warnings.push(`Dropped ${prop} in ${where}: it can run code.`);
            continue;
        }
        if (name === 'position' && /^fixed\b/i.test(decodeEscapes(value).trim())) {
            warnings.push(`Dropped position: fixed in ${where}: screens stay inside their place.`);
            continue;
        }
        const problem = valueProblem(value);
        if (problem) {
            warnings.push(`Dropped ${prop} in ${where}: ${problem} is not allowed (only data: and https: URLs).`);
            continue;
        }
        if (keyframes?.size && (name === 'animation' || name === 'animation-name')) {
            value = value.replace(/-?[A-Za-z_][\w-]*/g, word => keyframes.get(word) ?? word);
        }
        kept.push(`${prop}: ${value}`);
    }
    return { text: kept.join('; '), warnings };
}

/**
 * A screen's `theme` as custom properties to set on its root: `[[name, value]]`, names `--x` only,
 * values passing the same checks as declarations. Returns `{ vars, warnings }`.
 */
export function themeVars(theme) {
    const vars = [];
    const warnings = [];
    for (const [name, raw] of Object.entries(theme && typeof theme === 'object' ? theme : {})) {
        const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
        if (!/^--[A-Za-z0-9_-]+$/.test(name)) warnings.push(`Theme key "${name}" is not a custom property (--name).`);
        else if (value === null || /[;{}]/.test(value)) warnings.push(`Theme value for ${name} is not a single CSS value.`);
        else {
            const problem = valueProblem(value);
            if (problem) warnings.push(`Theme value for ${name}: ${problem} is not allowed.`);
            else vars.push([name, value]);
        }
    }
    return { vars, warnings };
}

/** A value for a CSS custom property from data (data-bind-var): numbers as written, safe strings, else ''. */
export function cssVarValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (text.length > 2000 || /[;{}<>\\]/.test(text) || valueProblem(text)) return '';
    return text;
}
