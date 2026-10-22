// What's sent (0.9.18): the exact text an extension adds to the next reply's prompt, shown to the
// reader read-only, with its size and a Copy button. Story Block's settings panel shows its own;
// Story Suite's overlay shows every extension's that offers `api.manage.preview()`
// (docs/STORY_SUITE.md). Built from nodes with textContent only: the text is the prompt as sent.

import { tokensOf } from '../tokens.js';
import { el } from './dom.js';

// "injection" → "Injection", "liveDossier" → "Live dossier".
const labelOf = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().replace(/^./, first => first.toUpperCase()).replace(/(?<= )\w/g, word => word.toLowerCase());

/**
 * An extension's preview as a list of `{ label, text }` parts, or null when it offers none.
 * `[{ label, text }]` is the contract; one part, `{ parts: [...] }`, a plain string, or an
 * object of named texts (`{ injection, capture }`, each a part named for its key) read too.
 * Empty texts are kept (they say "nothing is sent now"); anything else, a promise included,
 * is null.
 */
export function previewParts(raw, fallbackLabel = 'Sent') {
    if (raw === null || raw === undefined || typeof raw?.then === 'function') return null;
    let list;
    if (typeof raw === 'string') list = [{ label: fallbackLabel, text: raw }];
    else if (Array.isArray(raw)) list = raw;
    else if (typeof raw !== 'object') return null;
    else if (Array.isArray(raw.parts)) list = raw.parts;
    else if ('text' in raw) list = [raw];
    else list = Object.entries(raw).filter(([, value]) => typeof value === 'string').map(([key, text]) => ({ label: labelOf(key), text }));
    const parts = list
        .filter(part => part && typeof part === 'object' && 'text' in part)
        .map(part => ({ label: String(part.label ?? '').trim() || fallbackLabel, text: String(part.text ?? '') }));
    return parts.length ? parts : null;
}

const make = (d, tag, className = '', text = '') => el(tag, className, text, d);

async function copyText(text) {
    try {
        await globalThis.navigator?.clipboard?.writeText?.(text);
        return true;
    } catch {
        return false;
    }
}

/**
 * The parts as nodes: per part a head (label, "~N tokens", Copy) and the text in a scrolling
 * monospace box; `onRefresh` adds a Refresh button above them.
 */
export function renderPreview(d, parts, { onRefresh = null, empty = 'Nothing is sent with the next reply right now.' } = {}) {
    const root = make(d, 'div', 'story-block-preview');
    if (typeof onRefresh === 'function') {
        const bar = make(d, 'div', 'story-block-preview-bar');
        const refresh = make(d, 'button', 'menu_button story-block-preview-refresh');
        refresh.type = 'button';
        refresh.textContent = 'Refresh';
        refresh.addEventListener('click', () => onRefresh());
        bar.appendChild(refresh);
        root.appendChild(bar);
    }
    if (!parts?.length) {
        root.appendChild(make(d, 'p', 'story-suite-muted story-block-preview-empty', empty));
        return root;
    }
    for (const part of parts) {
        const section = make(d, 'section', 'story-block-preview-part');
        const head = make(d, 'div', 'story-block-preview-head');
        head.append(make(d, 'b', 'story-block-preview-label', part.label), make(d, 'span', 'story-block-preview-size', part.text ? `~${tokensOf(part.text).toLocaleString('en-US')} tokens` : 'nothing'));
        if (part.text) {
            const copy = make(d, 'button', 'menu_button story-block-preview-copy');
            copy.type = 'button';
            copy.textContent = 'Copy';
            copy.addEventListener('click', async () => {
                copy.textContent = (await copyText(part.text)) ? 'Copied' : 'Copy failed';
            });
            head.appendChild(copy);
        }
        section.appendChild(head);
        section.appendChild(part.text ? make(d, 'pre', 'story-block-preview-text', part.text) : make(d, 'p', 'story-suite-muted', empty));
        root.appendChild(section);
    }
    return root;
}
