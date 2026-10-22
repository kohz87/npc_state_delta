// The "This turn" strip: one slim button under the latest reply listing what that
// reply changed, so the reader sees the changes without opening the sidebar.
// Tapping it opens the sidebar on the first change's tab (the runtime's onOpen).
//
// There is only ever one strip in the chat: mounting one removes any other.

import { el } from './dom.js';

const CLASS = 'story-block-strip';
const TONES = new Set(['up', 'down', 'neutral', 'warn']);
const SHOWN = 3;

function hostOf(messageElement) {
    return messageElement.querySelector?.('.mes_block') ?? messageElement;
}

function normalizeItems(items) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
        const text = String(item?.text ?? '').trim();
        if (!text) continue;
        out.push({
            tabId: item?.tabId === undefined || item?.tabId === null ? null : String(item.tabId),
            block: String(item?.block ?? '').trim(),
            text,
            tone: TONES.has(item?.tone) ? item.tone : 'neutral',
        });
    }
    return out;
}

const itemText = item => (item.tone === 'warn' ? `${item.text} · tap to fix` : item.text);

function warnGlyph() {
    const glyph = el('i', 'fa-solid fa-triangle-exclamation story-block-strip-icon');
    glyph.setAttribute('aria-hidden', 'true');
    return glyph;
}

function renderQuiet() {
    const chip = el('div', `${CLASS} story-block-strip-quiet`);
    chip.setAttribute('role', 'status');
    chip.appendChild(el('span', 'story-block-strip-body', 'Nothing changed this turn'));
    return chip;
}

function renderItems(list, onOpen) {
    const shown = list.slice(0, SHOWN);
    const more = list.length - shown.length;
    // A strip made only of errors reads as the error itself (no "This turn" label).
    const onlyWarn = shown.every(item => item.tone === 'warn');
    const strip = el('button', `${CLASS}${shown.some(item => item.tone === 'warn') ? ' story-block-strip-has-warn' : ''}`);
    strip.type = 'button';
    if (list[0].tabId !== null) strip.dataset.tabId = list[0].tabId;
    if (onlyWarn) strip.appendChild(warnGlyph());

    const body = el('span', 'story-block-strip-body');
    if (!onlyWarn) body.appendChild(el('span', 'story-block-strip-title', 'This turn'));
    shown.forEach((item, index) => {
        if (index > 0) {
            const dot = el('span', 'story-block-strip-sep', '·');
            dot.setAttribute('aria-hidden', 'true');
            body.appendChild(dot);
        }
        body.appendChild(el('span', `story-block-strip-item story-block-strip-${item.tone}`, itemText(item)));
    });
    if (more > 0) body.appendChild(el('span', 'story-block-strip-more', `+${more} more`));
    strip.appendChild(body);

    // The visible text is clipped to two lines; the tooltip and the accessible name
    // carry every change, with its block.
    const full = list.map(item => (item.block ? `${item.block}: ${itemText(item)}` : itemText(item)));
    strip.title = full.join('\n');
    strip.setAttribute('aria-label', `${onlyWarn ? '' : 'This turn: '}${full.join('; ')}. Open Story Block.`);

    strip.addEventListener('click', event => {
        // Keep the click from SillyTavern's message handlers.
        event.stopPropagation();
        try { onOpen?.(list[0].tabId); } catch (error) { console.error('[Story Block] strip onOpen failed', error); }
    });
    return strip;
}

/**
 * Render the strip at the end of the message's `.mes_block` (fallback: the message
 * element), replacing any previous strip. Returns it, or null when nothing is shown.
 */
export function mountStrip(messageElement, items, { onOpen, showQuiet = false } = {}) {
    const doc = messageElement?.ownerDocument ?? globalThis.document;
    unmountStrip(doc);
    if (!messageElement) return null;
    const list = normalizeItems(items);
    if (!list.length && !showQuiet) return null;
    const strip = list.length ? renderItems(list, onOpen) : renderQuiet();
    hostOf(messageElement).appendChild(strip);
    return strip;
}

/** Remove every strip under `root`. */
export function unmountStrip(root = globalThis.document) {
    for (const node of [...(root?.querySelectorAll?.(`.${CLASS}`) ?? [])]) node.remove();
}
