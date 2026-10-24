// Shared DOM helpers for the standard widgets (SPEC §13.5).
//
// Every widget builds its DOM with createElement / createElementNS and textContent: names, labels and
// numbers come from story data (and so, at one remove, from the model), so none of it is ever parsed as
// markup. Styling goes through `ss-w-` classes, `data-*` attributes and CSS custom properties only, so a
// screen's CSS can restyle any widget.

import { widgetCss } from './styles.js';
import { cutAt } from '../../../text.js';
import { hasIcon, svgIcon } from '../icons/index.js';

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const DEFAULT_FA_ICON = 'fa-table-columns';

/** Tones a widget accepts; anything else is shown as `neutral` (data never picks an arbitrary class). */
export const TONES = Object.freeze(['neutral', 'accent', 'good', 'warn', 'bad', 'info']);

/** The document an element lives in (a widget may be drawn into another window's document). */
export function docOf(el) {
    return el?.ownerDocument ?? globalThis.document;
}

/** An HTML element with an optional class and text. */
export function h(doc, tag, className = '', text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
}

/** An SVG element with attributes (values stringified; `class` is an attribute on SVG). */
export function s(doc, tag, attrs = {}) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) node.setAttribute(name, String(value));
    }
    return node;
}

/** The allowed tone for a value. */
export function toneOf(value) {
    return TONES.includes(value) ? value : 'neutral';
}

/** Puts exactly one `ss-w-tone-*` class on a node. */
export function setTone(node, value) {
    for (const tone of TONES) node.classList.remove(`ss-w-tone-${tone}`);
    node.classList.add(`ss-w-tone-${toneOf(value)}`);
}

/** A `data-*` value from data: a short plain string, or the attribute is removed. */
export function setData(node, name, value) {
    const text = value === undefined || value === null ? '' : cutAt(String(value), 64);
    if (text) node.setAttribute(`data-${name}`, text);
    else node.removeAttribute(`data-${name}`);
}

/** Clamps a number into [min, max]. */
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** A finite number, or the fallback. */
export function num(value, fallback = 0) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** A number for display or an SVG attribute: at most two decimals, no trailing zeros, no "-0", never "Infinity". */
export function fmt(value) {
    const n = num(value);
    // Two decimals only where n * 100 is still exact enough to round (and cannot overflow to Infinity).
    const rounded = Math.abs(n) < 1e13 ? Math.round(n * 100) / 100 : Math.round(n);
    return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** A display string from a text-ish value ('' for null/undefined/objects). */
export function str(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

// Base64 raster data: images only, as the layout renderer allows (LAYOUTS.md): no SVG documents.
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/]*={0,2}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_URL = 4_000_000;

/**
 * The image URL if it is a base64 `data:image/png|jpeg|gif|webp|avif` URL, an `https:` URL, or a same-origin path from the site root
 * (SillyTavern's avatars: `/thumbnail?type=avatar&file=…`, `/User Avatars/…`, MODULES §F11), else ''.
 * Everything else (http:, javascript:, protocol-relative `//host`, other relative paths, blob:, file:,
 * URLs with credentials) is refused.
 */
export function safeImageUrl(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text || text.length > MAX_URL || CONTROL.test(text)) return '';
    if (DATA_IMAGE.test(text)) return text;
    // One leading slash and no backslash anywhere: browsers read "//x" and "/\x" as another host.
    if (/^\/(?![/\\])/.test(text) && !text.includes('\\')) return text;
    if (!/^https:\/\//i.test(text) || /\s/.test(text)) return '';
    try {
        const url = new URL(text);
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';
        return url.href;
    } catch {
        return '';
    }
}

const FA_STYLE = /^(?:fa-(?:solid|regular|brands|light|thin|duotone|sharp)|fa[srlbdt])$/;
const FA_TOKEN = /^fa(?:-[a-z0-9]+)+$/;

/** Font Awesome class tokens for a value like "fa-map", "fa-solid fa-map" or "fas fa-map"; null if not FA. */
export function faClasses(value) {
    if (typeof value !== 'string') return null;
    const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 6) return null;
    if (!tokens.every(token => FA_STYLE.test(token) || FA_TOKEN.test(token))) return null;
    if (!tokens.some(token => !FA_STYLE.test(token))) return null;
    return tokens.some(token => FA_STYLE.test(token)) ? tokens : ['fa-solid', ...tokens];
}

/**
 * An icon node from a `ph-*` icon id (view/icons, `ph-name:fill` for the solid weight), a Font Awesome class name,
 * a data:/https: image, or a short glyph (an emoji, a letter); null when the value is none of these. An unknown
 * `ph-*` id falls back to the default Font Awesome icon. Icons are decorative: the label lives next to them.
 */
export function iconNode(doc, value, className = 'ss-w-icon') {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed && hasIcon(trimmed)) return svgIcon(doc, trimmed, { className });
    if (trimmed.startsWith('ph-')) {
        const node = h(doc, 'i', `${className ? `${className} ` : ''}fa-solid ${DEFAULT_FA_ICON}`);
        node.setAttribute('aria-hidden', 'true');
        return node;
    }
    const fa = faClasses(value);
    if (fa) {
        const node = h(doc, 'i', `${className} ${fa.join(' ')}`);
        node.setAttribute('aria-hidden', 'true');
        return node;
    }
    const url = safeImageUrl(value);
    if (url) {
        const node = h(doc, 'img', `${className} ss-w-icon-img`);
        node.setAttribute('src', url);
        node.setAttribute('alt', '');
        node.setAttribute('aria-hidden', 'true');
        node.setAttribute('draggable', 'false');
        return node;
    }
    const glyph = typeof value === 'string' ? value.trim() : '';
    if (glyph && Array.from(glyph).length <= 3 && !/^(?:[a-z]+:|\/|\.)/i.test(glyph)) {
        const node = h(doc, 'span', `${className} ss-w-icon-text`, glyph);
        node.setAttribute('aria-hidden', 'true');
        return node;
    }
    return null;
}

/** Up to two initials from a name ("Ren Avel" → "RA", "astra" → "A"); '?' when there is no name. */
export function initials(name) {
    const words = str(name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    const first = Array.from(words[0])[0];
    const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
    return `${first}${last}`.toUpperCase();
}

/** "fire-ward" → "fire ward": a readable label from a kind slug. */
export function humanize(value) {
    return str(value).replace(/[-_]+/g, ' ').trim();
}

/**
 * Runs a command through the widget api, if both are given. Results are the host's to report (it shows
 * failures in plain words); a widget never throws at the reader.
 */
export function runCommand(api, type, payload) {
    if (typeof type !== 'string' || !type || typeof api?.command !== 'function') return false;
    try {
        const result = api.command(type, payload);
        if (result && typeof result.then === 'function') result.then(undefined, () => {});
    } catch {
        // The host already reported it.
    }
    return true;
}

/** Adds the widgets' base stylesheet to a document once (low specificity: any screen CSS overrides it). */
export function ensureStyles(doc) {
    const head = doc?.head;
    if (!head || head.querySelector('style[data-ss-widgets]')) return;
    const style = doc.createElement('style');
    style.setAttribute('data-ss-widgets', '');
    style.textContent = widgetCss;
    head.appendChild(style);
}

/**
 * The common widget shell: a root element appended to `el`, listeners tracked so destroy() removes them,
 * and update()/destroy() that are safe to call after destroy.
 */
export function shell(el, tag, name, draw) {
    const doc = docOf(el);
    ensureStyles(doc);
    const root = h(doc, tag, `ss-w ss-w-${name}`);
    const listeners = [];
    const cleanups = [];
    let alive = true;
    const ctx = {
        doc,
        root,
        listen(node, type, fn, options) {
            node.addEventListener(type, fn, options);
            listeners.push([node, type, fn, options]);
        },
        cleanup(fn) { cleanups.push(fn); },
    };
    el.appendChild(root);
    const view = draw(ctx);
    return {
        update(props) {
            if (alive) view.update(props);
        },
        destroy() {
            if (!alive) return;
            alive = false;
            for (const [node, type, fn, options] of listeners) node.removeEventListener(type, fn, options);
            listeners.length = 0;
            for (const fn of cleanups) {
                try { fn(); } catch { /* best effort */ }
            }
            view.destroy?.();
            root.remove();
        },
    };
}
