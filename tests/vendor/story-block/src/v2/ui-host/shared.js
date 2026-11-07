// Shared DOM, reader-setting and reply helpers for the page furniture; public helpers remain exported by ui-host.js.

import { readRecord } from '../persist.js';
import { CORE_FEATURE } from '../features.js';
import { STRINGS } from '../strings.js';

export const S = STRINGS;

export const IDS = Object.freeze({ bar: 'story_suite_v2_bar', panel: 'story_suite_v2_panel', drawer: 'story_suite_v2_drawer', menu: 'story_suite_v2_menu' });

export function el(doc, tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

export function iconButton(doc, className, iconName, label, title = label) {
    const node = el(doc, 'button', `menu_button ${className}`);
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', title);
    const glyph = el(doc, 'i', `fa-solid ${iconName}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph, el(doc, 'span', 'story-suite-label', label));
    return node;
}

/** True for Alt+G alone (no Ctrl, Meta or Shift); `code` so it works whatever Alt types on a Mac. */
export const isGameViewKey = event => Boolean(event?.altKey) && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && (event.code === 'KeyG' || String(event.key ?? '').toLowerCase() === 'g');

/**
 * Does message `index` of `chat` get inline cards? Only a reply after the reader's first message (not the
 * greeting) that carries a v2 record for its shown swipe.
 */
export function hasReplyRecord(chat, index) {
    const message = chat?.[index];
    if (!message || message.is_user) return false;
    const firstUser = chat.findIndex(item => item?.is_user);
    if (firstUser < 0 || index < firstUser) return false;
    return readRecord(message) !== null;
}

/**
 * The status strip is on unless the reader turned it off (MODULES §F54): the feature `story-block.hud`
 * when the reader has set it, else the drawer switch older versions kept (`storySuite.hud`).
 */
export function hudOn(extensionSettings) {
    const suite = extensionSettings?.storySuite;
    const choice = suite?.features?.[CORE_FEATURE.hud];
    return typeof choice === 'boolean' ? choice : suite?.hud !== false;
}

/** Reader choices for screens and cards: extension_settings.storySuite.{screens, cards}. */
export function readerStore(ctx) {
    const root = () => {
        const es = ctx.extensionSettings ?? {};
        if (!es.storySuite || typeof es.storySuite !== 'object') es.storySuite = {};
        return es.storySuite;
    };
    return {
        reader: () => ({ screens: root().screens ?? {}, cards: root().cards ?? {} }),
        saveReader(next) {
            root().screens = next.screens ?? {};
            root().cards = next.cards ?? {};
            ctx.saveSettingsDebounced?.();
        },
    };
}
