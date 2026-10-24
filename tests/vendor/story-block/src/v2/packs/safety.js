// The "data only" rule for packs (SPEC §9), checked before anything reads a pack's fields.
//
// A pack comes from a file someone shared or from a card's lorebook, so it is untrusted.
// It may hold only what JSON can hold, and no text that a renderer could turn into code:
// no script-like tags, no on* event attributes, no javascript: style URLs. Layouts and
// tabs still render every string as text; this check is the second wall, not the only one.

import { LIMITS } from './limits.js';

// Tags that run code or pull in other documents when a string reaches innerHTML (the
// SPEC §13.2 list, plus `style`: a screen's CSS goes in its own `css` field). Inline SVG and
// forms are allowed, a form's `action` is not.
const UNSAFE_TAG = /<\s*\/?\s*(?:script|iframe|frame|frameset|object|embed|applet|link|meta|style|base)\b|<\s*form\b[^>]*\saction\s*=/i;
// Event attributes and link targets are found by reading each tag's attributes the way a browser
// does (tagScan below), not with a regex: a quoted value may hold `>` (`<img alt=">" onerror=…>`).
// Schemes that run code or open a document, anywhere in the text. Checked after entities, whitespace
// and control characters are removed, because browsers ignore those inside a scheme
// (`java&#x09;script:`). A data: URL is a document unless it is a raster image (PNG, JPEG, GIF, WebP):
// `data:text/html`, `data:application/xhtml+xml`, `data:text/xml`, `data:image/svg+xml` … are refused.
const RASTER = 'image\\/(?:png|jpeg|gif|webp)[;,]';
const CODE_SCHEME = new RegExp(`(?:java|vb|live)script:|data:(?!${RASTER})(?:text|application|image|audio|video|font|model|multipart|message)\\/|\\]\\(data:(?!${RASTER})`, 'i');
// Attributes whose value the browser loads or follows. Inside a tag their data: URLs must be raster images.
const LINK_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster', 'background', 'lowsrc', 'dynsrc', 'codebase', 'cite', 'longdesc', 'ping', 'srcset', 'usemap', 'manifest', 'to', 'from', 'values', 'by']);
const RASTER_DATA = new RegExp(`^data:${RASTER}`, 'i');
// Keys whose value is a link or an image source: only https and plain image data URLs (§13.2).
const URL_KEYS = new Set(['src', 'href', 'url', 'image', 'img', 'background']);
const SAFE_URL = /^(?:https:\/\/[^\s"'<>]+|data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)$/i;
// Keys that hold a screen's template or CSS, allowed to be longer than other text.
const CODE_KEYS = new Set(['template', 'css']);
// Keys that would change an object's prototype when copied naively.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ENTITIES = { colon: ':', tab: '', newline: '', lpar: '(', rpar: ')', sol: '/', bsol: '\\' };

function decodeEntities(text) {
    return text
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
        .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Math.min(Number(dec), 0x10ffff)))
        .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Why a string is unsafe for a pack, or '' when it is fine. */
export function unsafeText(text) {
    if (UNSAFE_TAG.test(text)) return 'has an HTML tag that can run code (script, iframe, style, form action …)';
    const tags = tagScan(text);
    if (tags) return tags;
    if (CODE_SCHEME.test(squeeze(text))) return 'has a script link (javascript:, data:text/html …)';
    return '';
}

/** Entities decoded, whitespace and control characters removed: what a browser acts on in a URL. */
const squeeze = text => decodeEntities(text).replace(/[\s\u0000-\u001f\u007f]+/g, '');

// An `on…` attribute name, after any junk a browser keeps in the name (`"onerror` is not one, but
// counting it costs nothing).
const EVENT_NAME = /^[^a-z0-9]*on[a-z]+$/i;
// Whitespace between attributes. Wider than HTML's (it adds \v and the Unicode spaces), so a name is
// never missed by reading it as part of another.
const SPACE = /\s/;

/**
 * Reads every tag in `text` (`<` and a letter) like a browser's tokenizer: attribute names run to
 * whitespace, `/`, `>` or `=`; values are quoted (to the same quote, `>` included) or run to whitespace or
 * `>`. Returns why the text is unsafe ('' when fine): an `on…=` attribute with a value, or a link
 * attribute holding a data: URL that is not a raster image. A quoted value that holds `<` is read again
 * as text of its own (a renderer might draw it), at most two levels deep. Linear in the text's length.
 */
function tagScan(text, depth = 0) {
    let at = text.indexOf('<');
    while (at >= 0 && at < text.length) {
        if (!/[a-z]/i.test(text[at + 1] ?? '')) {
            at = text.indexOf('<', at + 1);
            continue;
        }
        at += 1;
        while (at < text.length && !SPACE.test(text[at]) && text[at] !== '/' && text[at] !== '>') at += 1;   // the tag name
        while (at < text.length && text[at] !== '>') {
            const char = text[at];
            if (SPACE.test(char) || char === '/') { at += 1; continue; }
            const start = at;
            at += 1;   // a name may start with "=" (a browser keeps it in the name)
            while (at < text.length && !SPACE.test(text[at]) && !'/>='.includes(text[at])) at += 1;
            const name = text.slice(start, at).toLowerCase();
            let probe = at;
            while (probe < text.length && SPACE.test(text[probe])) probe += 1;
            if (text[probe] !== '=') continue;
            at = probe + 1;
            while (at < text.length && SPACE.test(text[at])) at += 1;
            let value;
            const quote = text[at];
            if (quote === '"' || quote === '\'') {
                const close = text.indexOf(quote, at + 1);
                value = text.slice(at + 1, close < 0 ? text.length : close);
                at = close < 0 ? text.length : close + 1;
            } else {
                const begin = at;
                while (at < text.length && !SPACE.test(text[at]) && text[at] !== '>') at += 1;
                value = text.slice(begin, at);
            }
            // `online == 1` in a condition reads as online="=": not code.
            if (EVENT_NAME.test(name) && !value.startsWith('=')) return 'has an HTML event attribute (on…=)';
            if (LINK_ATTRS.has(name)) {
                const url = squeeze(value).toLowerCase();
                if (url.startsWith('data:') && !RASTER_DATA.test(url)) return 'links to a data: document (only PNG, JPEG, GIF and WebP data images are allowed)';
            }
            if (depth < 2 && (quote === '"' || quote === '\'') && value.includes('<')) {
                const inner = tagScan(value, depth + 1);
                if (inner) return inner;
            }
        }
        at = text.indexOf('<', at);
    }
    return '';
}

const describe = value => {
    if (typeof value === 'function') return 'a function';
    if (value === undefined) return 'undefined';
    if (typeof value === 'symbol') return 'a symbol';
    if (typeof value === 'bigint') return 'a bigint';
    if (typeof value === 'number') return String(value);
    return `a ${value?.constructor?.name ?? 'special'} object`;
};

const isPlainObject = value => {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};

/**
 * Walks `value` and lists every way it is not plain, safe data:
 * `[{ code, path, message }]`, empty when fine. Stops after LIMITS.errors problems.
 * Codes: NOT_PLAIN, UNSAFE_KEY, UNSAFE_HTML, UNSAFE_URL, TOO_DEEP, TOO_LONG, TOO_MANY.
 */
export function checkPlain(value, limits = LIMITS) {
    const errors = [];
    const seen = new Set();
    const add = (code, path, message) => { if (errors.length < limits.errors) errors.push({ code, path, message: `${path || 'The pack'} ${message}.` }); };

    const visit = (node, path, depth, key) => {
        if (errors.length >= limits.errors) return;
        if (node === null || typeof node === 'boolean') return;
        if (typeof node === 'string') {
            const max = CODE_KEYS.has(key) ? limits.code : limits.string;
            if (node.length > max) return add('TOO_LONG', path, `is longer than ${max} characters`);
            const unsafe = unsafeText(node);
            if (unsafe) return add('UNSAFE_HTML', path, unsafe);
            if (URL_KEYS.has(key) && !SAFE_URL.test(node.trim())) add('UNSAFE_URL', path, 'must be an https link or a PNG, JPEG, GIF or WebP data URL');
            return;
        }
        if (typeof node === 'number') {
            if (!Number.isFinite(node)) add('NOT_PLAIN', path, `is ${describe(node)}, not a finite number`);
            return;
        }
        if (typeof node !== 'object') return add('NOT_PLAIN', path, `is ${describe(node)}; packs hold data only`);
        if (seen.has(node)) return add('NOT_PLAIN', path, 'refers back to itself');
        if (depth >= limits.depth) return add('TOO_DEEP', path, `is nested more than ${limits.depth} levels deep`);
        const isArray = Array.isArray(node);
        if (!isArray && !isPlainObject(node)) return add('NOT_PLAIN', path, `is ${describe(node)}; packs hold data only`);
        seen.add(node);
        const keys = Reflect.ownKeys(node);
        if (isArray) {
            if (node.length > limits.array) add('TOO_MANY', path, `has more than ${limits.array} entries`);
        } else if (keys.length > limits.keys) add('TOO_MANY', path, `has more than ${limits.keys} fields`);
        for (const name of keys) {
            if (isArray && name === 'length') continue;
            if (typeof name === 'symbol') { add('NOT_PLAIN', path, 'has a symbol key'); continue; }
            const at = isArray ? `${path}[${name}]` : path ? `${path}.${name}` : name;
            const descriptor = Object.getOwnPropertyDescriptor(node, name);
            // A getter would run code just by being read.
            if (descriptor.get || descriptor.set) { add('NOT_PLAIN', at, 'is a getter or setter; packs hold data only'); continue; }
            if (!isArray) {
                if (UNSAFE_KEYS.has(name)) { add('UNSAFE_KEY', at, 'is a reserved name'); continue; }
                if (name.length > limits.name) { add('TOO_LONG', at, `is a field name longer than ${limits.name} characters`); continue; }
                const unsafe = unsafeText(name);
                if (unsafe) { add('UNSAFE_HTML', at, unsafe); continue; }
            }
            visit(descriptor.value, at, depth + 1, isArray ? key : name);
        }
        seen.delete(node);
    };
    visit(value, '', 0, '');
    return errors;
}

/** UTF-8 length of a string. */
export const byteLength = text => new TextEncoder().encode(text).length;
