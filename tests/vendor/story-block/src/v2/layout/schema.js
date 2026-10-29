// What a layout may contain: node types and their fields, theme tokens, limits, and the
// small value checks shared by the validator and the renderer.
//
// A layout is data from a pack (or a module) and is never trusted: no HTML, no script,
// no style text, no URL that could run or fetch anything but an image.

export const LIMITS = Object.freeze({
    depth: 16,            // nesting of nodes, the root counting as 1
    nodes: 600,           // nodes written in the layout
    bytes: 256 * 1024,    // the layout as JSON
    children: 100,        // children of one container
    pages: 12,            // pages of one tabs node
    listItems: 200,       // rows a list shows at most
    rendered: 3000,       // nodes one render may build (lists inside lists multiply)
    text: 2000,           // characters in one literal text
    cond: 500,            // characters in one condition
    urlHttps: 2048,
    urlData: 200 * 1024,
});

export const TONES = Object.freeze([
    'neutral', 'accent', 'good', 'warn', 'bad',
    'common', 'uncommon', 'rare', 'epic', 'legendary',
]);
export const TEXT_VARIANTS = Object.freeze(['body', 'title', 'label', 'muted']);
export const IMAGE_SIZES = Object.freeze(['small', 'medium', 'large']);

// Theme tokens a layout may set; each becomes `--ss-l-<name>` on the layout's root.
export const TOKENS = Object.freeze([
    'accent', 'bg', 'surface', 'fg', 'muted', 'border', 'radius', 'gap', 'pad', 'font',
    'good', 'warn', 'bad', 'meter', 'meter-bg',
]);

// Field kinds:
//   value    literal (string, number, boolean, null), an `$item` reference, or a binding
//   children array of nodes      node   one node      cond  condition string
//   command  command name        payload plain JSON (strings may be `$item` references)
//   icon     Font Awesome class  cols  integer 1-12   limit integer 1-200
//   pages    [{ title, node }]   props plain JSON object (widgets)
// `bind` is shorthand for the node's main field (`main`).
export const NODE_TYPES = Object.freeze({
    box: { fields: { title: 'value', children: 'children' } },
    row: { fields: { children: 'children' } },
    col: { fields: { children: 'children' } },
    grid: { fields: { cols: 'cols', children: 'children' }, required: ['cols'] },
    text: { fields: { value: 'value', label: 'value', variant: 'variant' }, main: 'value' },
    meter: { fields: { value: 'value', max: 'value', label: 'value', tone: 'value' }, main: 'value' },
    list: { fields: { item: 'node', empty: 'value', limit: 'limit' }, main: 'items', required: ['bind', 'item'] },
    image: { fields: { src: 'value', alt: 'value', size: 'size' }, main: 'src' },
    badge: { fields: { value: 'value', label: 'value', tone: 'value' }, main: 'value' },
    button: { fields: { label: 'value', command: 'command', payload: 'payload', icon: 'icon', tone: 'value' }, required: ['label', 'command'] },
    tabs: { fields: { pages: 'pages' }, required: ['pages'] },
    when: { fields: { cond: 'cond', children: 'children' }, required: ['cond'] },
});

export const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const isBinding = value => isPlainObject(value) && typeof value.query === 'string';

// Names: queries and commands are dotted (`inventory.items`), widgets may be too
// (`example-module.actor-card`).
export const QUERY_NAME = /^[A-Za-z][\w-]*(\.[\w-]+)*$/;
export const COMMAND_NAME = /^[A-Za-z][\w-]*(\.[\w-]+)+$/;
export const WIDGET_NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
export const LAYOUT_ID = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
export const ICON = /^fa-[a-z0-9-]{1,40}$/;
export const TOKEN_NAME = /^[a-z][a-z0-9-]{0,31}$/;

// A path into a query result or a list item: `hp.cur`, `actors.0.name`.
const SEGMENT = /^[\w$-]{1,64}$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
export function pathError(path) {
    if (typeof path !== 'string' || !path) return 'a path must be a non-empty string';
    if (path.length > 256) return 'a path must be at most 256 characters';
    for (const segment of path.split('.')) {
        if (!SEGMENT.test(segment)) return `"${path}" is not a path (use names joined by dots, like hp.cur)`;
        if (FORBIDDEN.has(segment)) return `"${path}" uses the reserved name "${segment}"`;
    }
    return '';
}

// `$item`, `$item.name`, `$index`: references to the list row being drawn.
const ITEM_REF = /^\$item(?:\.(.+))?$/;
export function itemRef(value) {
    if (typeof value !== 'string') return null;
    if (value === '$index') return { index: true };
    const match = ITEM_REF.exec(value);
    if (!match) return null;
    return { path: match[1] ?? '' };
}

/** Own-property walk; '' returns the value itself. Missing → undefined. */
export function getPath(value, path) {
    if (!path) return value;
    let current = value;
    for (const segment of path.split('.')) {
        if (FORBIDDEN.has(segment) || current === null || typeof current !== 'object') return undefined;
        if (!Object.hasOwn(current, segment)) return undefined;
        current = current[segment];
    }
    return current;
}

// Images: https (no user:password) or a base64 data: image in a raster format. SVG is
// left out: it is a document, not a picture.
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;
export function imageUrlError(src) {
    if (typeof src !== 'string' || !src) return 'an image needs a URL';
    if (/^data:/i.test(src)) {
        if (src.length > LIMITS.urlData) return 'a data: image is larger than 200 KB';
        return DATA_IMAGE.test(src) ? '' : 'a data: image must be base64 PNG, JPEG, GIF, WebP or AVIF';
    }
    if (!/^https:\/\//i.test(src)) return `"${src.slice(0, 60)}" is not an allowed image URL (use https: or a data: image)`;
    if (src.length > LIMITS.urlHttps) return 'an image URL is longer than 2048 characters';
    let url;
    try {
        url = new URL(src);
    } catch {
        return `"${src.slice(0, 60)}" is not a valid URL`;
    }
    if (url.protocol !== 'https:') return 'an image URL must use https:';
    if (url.username || url.password) return 'an image URL must not carry a user name or password';
    return '';
}

// Token values: colours, lengths and font names. No url(), no var(), no ; { } < > \ / :
const TOKEN_VALUE = /^[#a-zA-Z0-9 .,%'"()+-]{1,64}$/;
const TOKEN_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla']);
export function tokenValueError(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return '';
    if (typeof value !== 'string' || !TOKEN_VALUE.test(value)) return 'must be a colour, a length or a font name (letters, digits, # . , % ( ) quotes)';
    for (const match of value.matchAll(/([a-zA-Z-]*)\s*\(/g)) {
        if (!TOKEN_FUNCTIONS.has(match[1].toLowerCase())) return `may not use "${match[1] || '('}(": only rgb(), rgba(), hsl(), hsla()`;
    }
    return '';
}
