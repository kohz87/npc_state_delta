// Story Suite v2: the pack validator's checks for the look (moved out of packs/validate.js unchanged): the theme, the CSS a pack
// may carry (`unsafeCss`, urls and loaders refused) and the screens (`checkScreens`, also used by data-module blocks).

import { SCREEN_FIELDS, SCREEN_ID, LIMITS, TAB_ID, TAB_TITLE_MAX, MOUNTS } from '../limits.js';
import { tooDeep, MAX_DEPTH as MAX_TEMPLATE_DEPTH } from '../../view/template/html.js';
import { cssDepth, MAX_AT_DEPTH, sheetEscape } from '../../view/css.js';
import { isObject, shapeProblem } from './core.js';

// Themes are CSS custom properties (SPEC §13.3): `{ "--ss-accent": "#7c5cff" }`.
const TOKEN = /^--[a-z][a-z0-9-]{0,47}$/;
const CSS_VALUE_ESCAPE = /url\s*\(|expression\s*\(|@import|[<>{};\\]/i;

export function checkTheme(theme, add, path) {
    if (!isObject(theme)) {
        add('BAD_THEME', path, `${path} must map CSS custom properties to values: { "--ss-accent": "#7c5cff" }.`);
        return {};
    }
    const out = {};
    for (const [name, value] of Object.entries(theme)) {
        if (!TOKEN.test(name)) { add('BAD_THEME', `${path}.${name}`, `"${name}" is not a CSS custom property name (two dashes, then letters, digits and dashes, like "--ss-accent").`); continue; }
        if (typeof value === 'number') { out[name] = value; continue; }
        if (typeof value !== 'string' || value.length > 200 || CSS_VALUE_ESCAPE.test(value)) { add('BAD_THEME', `${path}.${name}`, `${path} "${name}" must be a plain CSS value (no url(), no braces, semicolons or backslashes).`); continue; }
        const loads = cssUrlProblem(value);
        if (loads) { add('BAD_THEME', `${path}.${name}`, `${path} "${name}" ${loads}.`); continue; }
        out[name] = value.trim();
    }
    return out;
}

// A screen's stylesheet (SPEC §13.3): Story Block scopes it; here it may not load or run
// anything. url() only to https or image data, no @import, no expression() or bindings,
// no markup and no backslash escapes (which could spell any of these).
const CSS_URL = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const CSS_SAFE_URL = /^(?:https:\/\/|data:image\/(?:png|jpeg|gif|webp)[;,])/i;
const CSS_UNSAFE = /@import|expression\s*\(|behavior\s*:|-moz-binding|[<\\]/i;
// Functions whose arguments the browser loads: their strings must be safe URLs, and they may not take
// a value from var(), attr() or env() (a custom property could hold any URL as a plain string).
const CSS_LOADERS = /(?:^|[^\w-])((?:-webkit-|-moz-)?(?:image-set|image|cross-fade|src|url|element))\s*\(/gi;
const CSS_STRING = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
// A string that names a URL: a scheme with `//`, a protocol-relative `//`, or a scheme that loads or runs.
const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:javascript|vbscript|livescript|data|blob|file|filesystem):)/i;

/** The arguments of the call whose `(` is at `open`, to its matching `)` (strings respected). */
function callArgs(text, open) {
    let depth = 0;
    let quote = null;
    for (let i = open; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === '\'') quote = char;
        else if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
}

/** Why a CSS text loads something it may not ('' when fine): image-set() and the like, URL strings. */
function cssUrlProblem(css) {
    for (const match of css.matchAll(CSS_LOADERS)) {
        const name = match[1].toLowerCase();
        const args = callArgs(css, match.index + match[0].length - 1);
        if (/\b(?:var|attr|env)\s*\(/i.test(args)) return `may not give ${name}() a value from var(), attr() or env()`;
        for (const string of args.matchAll(CSS_STRING)) {
            const url = (string[1] ?? string[2]).trim();
            if (name !== 'element' && !CSS_SAFE_URL.test(url)) return `may load only https or image data URLs (not "${url.slice(0, 40)}" in ${name}())`;
        }
    }
    for (const string of css.matchAll(CSS_STRING)) {
        const url = (string[1] ?? string[2]).replace(/[\u0000-\u0020\u007f]+/g, '');
        if (URLISH.test(url) && !CSS_SAFE_URL.test(url)) return `may hold only https or image data URLs (not "${url.slice(0, 40)}")`;
    }
    return '';
}

export function unsafeCss(css) {
    // A rule's own braces are one level; each @media/@supports around it one more.
    if (cssDepth(css) > MAX_AT_DEPTH + 1) return `may nest @-rules at most ${MAX_AT_DEPTH} deep`;
    if (CSS_UNSAFE.test(css)) return 'may not use @import, expression(), behavior, -moz-binding, < or backslashes';
    // A selector that reaches past the screen's root (the page beside it, its siblings, a :has() on them) is refused whole.
    const reach = sheetEscape(css);
    if (reach) return `may style only inside its own screen (a selector ${reach})`;
    for (const [, , target] of css.matchAll(CSS_URL)) if (!CSS_SAFE_URL.test(target.trim())) return `may load only https or image data URLs (not "${target.trim().slice(0, 40)}")`;
    return cssUrlProblem(css);
}

export function checkScreens(list, packId, add) {
    if (!Array.isArray(list)) {
        add('BAD_SCREENS', 'screens', 'screens must be a list of screen definitions.');
        return [];
    }
    const out = [];
    const seen = new Set();
    list.forEach((screen, index) => {
        const path = `screens[${index}]`;
        if (!isObject(screen)) return add('BAD_SCREENS', path, `${path} must be an object.`);
        const label = typeof screen.id === 'string' ? `Screen "${screen.id}"` : path;
        let ok = true;
        const say = (field, message, code = 'BAD_SCREENS') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
        for (const key of Object.keys(screen)) if (!SCREEN_FIELDS.includes(key)) say(key, `"${key}" is not a screen field (expected ${SCREEN_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
        if (typeof screen.id !== 'string' || !SCREEN_ID.test(screen.id) || screen.id.length > 100) say('id', 'id must be a screen id like "example-module/overview" (to restyle that screen) or "riverside-board".');
        else if (seen.has(screen.id)) say('id', 'two screens share this id.', 'DUPLICATE');
        else seen.add(screen.id);
        for (const field of ['title', 'icon']) if (screen[field] !== undefined && (typeof screen[field] !== 'string' || screen[field].length > LIMITS.name)) say(field, `${field} must be text of at most ${LIMITS.name} characters.`);
        if (screen.tab !== undefined && (typeof screen.tab !== 'string' || !TAB_ID.test(screen.tab))) say('tab', 'tab must be a short lowercase id like "reputation" (letters, digits and -).');
        if (screen.tabTitle !== undefined && (typeof screen.tabTitle !== 'string' || !screen.tabTitle.trim() || [...screen.tabTitle].length > TAB_TITLE_MAX)) say('tabTitle', `tabTitle must be text of 1 to ${TAB_TITLE_MAX} characters.`);
        if (screen.tabTitle !== undefined && screen.tab === undefined) say('tabTitle', 'tabTitle needs a tab.');
        if (screen.order !== undefined && !(typeof screen.order === 'number' && Number.isFinite(screen.order))) say('order', 'order must be a number (lower comes first).');
        if (screen.mounts !== undefined && (!Array.isArray(screen.mounts) || screen.mounts.some(mount => !MOUNTS.includes(mount)))) say('mounts', `mounts must be a list of ${MOUNTS.join(', ')}.`);
        if (screen.template === undefined && screen.layout === undefined) say('template', 'a screen needs a template or a layout.');
        if (screen.template !== undefined && typeof screen.template !== 'string') say('template', 'template must be text (an HTML template).');
        else if (typeof screen.template === 'string' && tooDeep(screen.template)) say('template', `the template nests elements more than ${MAX_TEMPLATE_DEPTH} deep.`);
        else if (typeof screen.template === 'string') {
            const why = shapeProblem(screen.template);
            if (why) say('template', `the template ${why}.`);
        }
        if (screen.layout !== undefined && !isObject(screen.layout)) say('layout', 'layout must be an object: { "root": … }.');
        if (screen.css !== undefined) {
            const why = typeof screen.css === 'string' ? unsafeCss(screen.css) : 'must be text';
            if (why) say('css', `css ${why}.`);
        }
        if (screen.data !== undefined && !isObject(screen.data)) say('data', 'data must map names to queries: { "pc": { "query": "party.pc" } }.');
        if (screen.steps !== undefined && (!Array.isArray(screen.steps) || screen.steps.some(step => !isObject(step) || (step.template !== undefined && typeof step.template !== 'string')))) say('steps', 'steps must be a list of { "id", "title", "template" }.');
        else if (Array.isArray(screen.steps) && screen.steps.some(step => typeof step.template === 'string' && tooDeep(step.template))) say('steps', `a step's template nests elements more than ${MAX_TEMPLATE_DEPTH} deep.`);
        else if (Array.isArray(screen.steps)) {
            const why = screen.steps.map(step => (typeof step.template === 'string' ? shapeProblem(step.template) : '')).find(Boolean);
            if (why) say('steps', `a step's template ${why}.`);
        }
        const theme = screen.theme === undefined ? {} : checkTheme(screen.theme, add, `${path}.theme`);
        if (ok) out.push({ ...screen, theme, pack: packId });
    });
    return out;
}
