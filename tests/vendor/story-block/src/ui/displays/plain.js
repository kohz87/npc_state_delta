// Plain display: the block as text, line breaks kept, **bold** and *italic* allowed.
//
// Markup is built from elements and text nodes, never innerHTML, so whatever the model
// wrote (including "<script>" or HTML entities) shows literally.

import { blockName, el, emptyText, renderEmpty, renderFrame } from '../dom.js';

// `**bold**` first so `*` inside it is not taken for italics. Italic needs a non-space
// right after the opening and right before the closing star, so "2 * 3 * 4" stays text.
const INLINE = /\*\*(?=\S)([\s\S]*?\S)\*\*|\*(?=[^\s*])([^*]*?[^\s*])\*/g;

export function appendInline(parent, text) {
    const source = String(text ?? '');
    let last = 0;
    for (const match of source.matchAll(INLINE)) {
        if (match.index > last) parent.appendChild(document.createTextNode(source.slice(last, match.index)));
        if (match[1] !== undefined) {
            const strong = el('strong');
            appendInline(strong, match[1]);
            parent.appendChild(strong);
        } else {
            parent.appendChild(el('em', '', match[2]));
        }
        last = match.index + match[0].length;
    }
    if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)));
    return parent;
}

/**
 * Text for any state shape, so a block whose display was set to Plain still reads
 * sensibly whatever its format is.
 */
export function plainTextOf(state) {
    if (!state || typeof state !== 'object') return '';
    if (typeof state.text === 'string') return state.text;
    if (Array.isArray(state.categories)) {
        const lines = [];
        for (const category of state.categories) {
            const items = category?.items ?? [];
            if (!items.length) continue;
            if (lines.length) lines.push('');
            lines.push(`**${category.name}**`);
            for (const item of items) lines.push([item.name, item.quantity, item.remark].filter(Boolean).join(' · '));
        }
        return lines.join('\n');
    }
    if (Array.isArray(state.entries)) {
        return state.entries.map(entry => `**${entry.label}:** ${entry.raw ?? ''}`).join('\n');
    }
    return '';
}

export function render(pane, { def, state, error, truncated, onEdit } = {}) {
    renderFrame(pane, { def, error, truncated, onEdit, display: 'plain' });
    const text = plainTextOf(state).replace(/\r\n?/g, '\n').trim();
    if (!text) {
        renderEmpty(pane, emptyText(def, state));
        return;
    }
    const body = el('div', 'story-block-display-body story-block-plain-text');
    body.setAttribute('aria-label', blockName(def));
    text.split('\n').forEach((line, index) => {
        if (index) body.appendChild(el('br'));
        appendInline(body, line);
    });
    pane.appendChild(body);
}
