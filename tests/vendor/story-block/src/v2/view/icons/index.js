// The extension's own icons (UI stage, step 7): the inline SVG builder for the `ph-*` set (view/icons/set.js, Phosphor)
// and the default icon of each game view screen and tab. Built with createElementNS only (no HTML parsing).
// An id names the line weight (`ph-house`); `ph-house:fill` names the solid one (the current tab).

import { ICON_SET } from './set.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WEIGHTS = Object.freeze(['regular', 'fill']);

/** The default `ph-*` icon of the game view's screens and tabs, by full id or by the id's last part. */
export const TAB_ICONS = Object.freeze({
    'story-block/home': 'ph-house',
    'story-block/inventory': 'ph-backpack',
    'story-director/quests': 'ph-scroll',
    'story-director/world': 'ph-globe-hemisphere-west',
    'story-director/map': 'ph-map-trifold',
    'story-block/scene': 'ph-map-pin',
    'story-director/chronicle': 'ph-book-open',
    'story-director/director': 'ph-film-slate',
    'npc-state-delta/cast': 'ph-identification-card',
    home: 'ph-house',
    party: 'ph-users-three',
    inventory: 'ph-backpack',
    quests: 'ph-scroll',
    world: 'ph-globe-hemisphere-west',
    map: 'ph-map-trifold',
    fight: 'ph-sword',
    crafting: 'ph-hammer',
    trade: 'ph-scales',
    scene: 'ph-map-pin',
    chronicle: 'ph-book-open',
    director: 'ph-film-slate',
    cast: 'ph-identification-card',
    dossiers: 'ph-identification-card',
    savepoints: 'ph-bookmark-simple',
    settings: 'ph-gear-six',
});

/** { id, weight } for `ph-name` or `ph-name:fill`; null when it is not a `ph-*` id of the set. */
function parse(value) {
    if (typeof value !== 'string') return null;
    const [id, weight = 'regular', ...rest] = value.trim().split(':');
    if (rest.length || !WEIGHTS.includes(weight) || !Object.hasOwn(ICON_SET, id)) return null;
    return { id, weight };
}

/** True when `value` is a known `ph-*` id (with or without `:fill`). */
export function hasIcon(value) {
    return parse(value) !== null;
}

/** The default `ph-*` icon for a screen or tab id (full id first, then its last part); '' when there is none. */
export function tabIcon(id) {
    if (typeof id !== 'string' || !id.trim()) return '';
    const key = id.trim().toLowerCase();
    if (Object.hasOwn(TAB_ICONS, key)) return TAB_ICONS[key];
    const tail = key.split('/').pop();
    return Object.hasOwn(TAB_ICONS, tail) ? TAB_ICONS[tail] : '';
}

/**
 * The icon to draw for a screen or tab: the suite's own icon for one of its screens (a full id in TAB_ICONS), else the
 * icon the screen or tab gives (`own`), else the default for its id's last part (tabIcon); '' when there is none.
 */
export function iconFor(id, own = '') {
    const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
    if (key.includes('/') && Object.hasOwn(TAB_ICONS, key)) return TAB_ICONS[key];
    const given = typeof own === 'string' ? own.trim() : '';
    return given || tabIcon(key);
}

/**
 * An inline `<svg class="ss-icon-svg">` (viewBox 0 0 256 256, one path, fill currentColor, aria-hidden, not focusable,
 * 1em square) for `value` (`ph-name` or `ph-name:fill`); `weight` picks the solid one too. Null for an unknown id.
 */
export function svgIcon(doc, value, { weight = '', className = '' } = {}) {
    const found = parse(value);
    if (!found) return null;
    const use = WEIGHTS.includes(weight) ? weight : found.weight;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    const extra = typeof className === 'string' ? className.trim() : '';
    svg.setAttribute('class', extra ? `${extra} ss-icon-svg` : 'ss-icon-svg');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('data-icon', found.id);
    svg.setAttribute('data-weight', use);
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICON_SET[found.id][use]);
    svg.appendChild(path);
    return svg;
}
