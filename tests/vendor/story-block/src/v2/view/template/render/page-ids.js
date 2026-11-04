// Story Suite v2: how a template's ids and names are drawn on the shared page (moved out of render.js unchanged). Every `id` is
// prefixed with its screen's (`ss-t-<screen>-`), the attributes that point at ids follow, each further copy of a screen drawn at the
// same time adds a copy mark, class lists lose the reserved classes and reserved control names go. `COPIES` is the one table of copy
// numbers drawn now; only takeCopy and freeCopy touch it.

import { templateIdPrefix } from '../../css.js';
import { cleanClasses, RESERVED_NAMES } from '../sanitize.js';
import { CONTROLS } from './dom.js';

// Attributes whose value is one id, or a space-separated list of ids, in the same template.
const ID_LISTS = new Set(['for', 'headers', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto']);
export const PAINT_REFS = new Set(['fill', 'stroke', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'filter']);

/** The id prefix for the screen a scope belongs to (`ss-t-` alone when no screen is named). */
export const idPrefixOf = screenId => (typeof screenId === 'string' && screenId ? templateIdPrefix(screenId) : 'ss-t-');

// A screen is often drawn more than once at a time (a card under every reply, a tab and a hud), and
// ids and control names must not be shared between the copies (B-b5b-robust-r2-1: a label would check
// another copy's box, radios would be one group). The first copy of a screen on the page keeps the
// screen's ids (`ss-t-<screen>-<id>`); each other copy drawn at the same time adds `--c<n>`. A screen's
// CSS reaches every copy (css.js: `#id` is scoped to the screen's ids with or without the copy mark).
const COPIES = new Map();   // id prefix → the copy numbers drawn now

export function takeCopy(prefix) {
    const taken = COPIES.get(prefix) ?? new Set();
    COPIES.set(prefix, taken);
    let n = 1;
    while (taken.has(n)) n += 1;
    taken.add(n);
    return n;
}

export function freeCopy(prefix, n) {
    const taken = COPIES.get(prefix);
    taken?.delete(n);
    if (taken && !taken.size) COPIES.delete(prefix);
}

// `id` as drawn in this view: the screen's prefix, and the copy's mark after the first copy.
const pageId = (view, id) => `${view.idPrefix}${id}${view.copy > 1 ? `--c${view.copy}` : ''}`;

/**
 * The value an attribute is set to in the page: ids and references to them get the screen's prefix, class
 * lists lose reserved classes, reserved control names go. `null` leaves the attribute out.
 */
export function pageValue(view, tag, name, value) {
    const lower = name.toLowerCase();
    if (lower === 'id') return value.trim() ? pageId(view, value.trim()) : null;
    if (ID_LISTS.has(lower)) return value.split(/\s+/).filter(Boolean).map(id => pageId(view, id)).join(' ');
    if ((lower === 'href' || lower === 'xlink:href') && /^\s*#./.test(value)) return `#${pageId(view, value.replace(/^\s*#/, ''))}`;
    if (PAINT_REFS.has(lower)) return value.replace(/url\(\s*(['"]?)\s*#([^)'"\s]*)/gi, (_, quote, id) => `url(${quote}#${pageId(view, id)}`);
    if (lower === 'class') {
        const classes = cleanClasses(value);
        if (classes.dropped.length) view.warn(`The class ${classes.dropped.join(', ')} was left off <${tag}>: SillyTavern acts on it.`);
        return classes.value;
    }
    if (lower === 'name' && tag !== 'ss-widget') {
        if (RESERVED_NAMES.has(value.trim())) {
            view.warn(`name="${value.trim()}" was left off <${tag}>: SillyTavern reads controls by that name.`);
            return null;
        }
        if (tag === 'form' || CONTROLS.has(tag)) return value.trim() ? pageId(view, value.trim()) : null;
    }
    return value;
}
