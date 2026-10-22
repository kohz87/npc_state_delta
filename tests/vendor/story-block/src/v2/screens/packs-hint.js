// "Import a pack" on the Home screen: the `story-block.packs-hint` host widget. While no pack is
// installed it draws one quiet panel, a line on what a pack is and a button that opens the Story Suite
// settings at the Packs fold (ui-host.js passes `open`). With a pack installed, or when this Story Block
// cannot tell (`list()` gives null), it draws nothing. It redraws when the installed list changes
// (`subscribe`) and on the host's `head` and `feature` events.
//
// Settings management, not a story action (F95/F96): nothing here runs a command. Text is set with
// textContent.

import { STRINGS } from '../strings.js';

const S = STRINGS.packsHint;

export const PACKS_HINT_WIDGET = 'story-block.packs-hint';

function el(doc, tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * The widget → `{ props, render(el, props, api) }`. `list()` → the installed packs (or null when
 * unknown); `subscribe(fn)` → an unsubscribe function (optional); `open()` opens the settings at Packs.
 */
export function createPacksHintWidget({ list = () => null, subscribe = null, open = () => {} } = {}) {
    return Object.freeze({
        props: {},
        primary: null,
        validate: () => [],
        render(host, _props, api = {}) {
            const doc = host.ownerDocument ?? globalThis.document;
            function draw() {
                let packs = null;
                try { packs = list(); } catch { packs = null; }
                if (!Array.isArray(packs) || packs.length) {
                    host.replaceChildren();
                    return;
                }
                const root = el(doc, 'section', 'panel packs-hint');
                root.setAttribute('aria-label', S.title);
                const head = el(doc, 'h4');
                const glyph = el(doc, 'i', 'fa-solid fa-box-archive');
                glyph.setAttribute('aria-hidden', 'true');
                head.append(glyph, doc.createTextNode(` ${S.title}`));
                const line = el(doc, 'p', 'muted sb-packs-none', S.none);
                const go = el(doc, 'button', 'btn sb-packs-import');
                go.type = 'button';
                go.setAttribute('type', 'button');
                go.setAttribute('title', S.importTitle);
                const icon = el(doc, 'i', 'fa-solid fa-file-import');
                icon.setAttribute('aria-hidden', 'true');
                go.append(icon, el(doc, 'span', '', S.import));
                go.addEventListener('click', () => open());
                root.append(head, line, go);
                host.replaceChildren(root);
            }
            const offs = [];
            const keep = off => { if (typeof off === 'function') offs.push(off); };
            try { keep(subscribe?.(() => draw())); } catch { /* no live list: drawn on the events below */ }
            if (typeof api?.on === 'function') {
                for (const name of ['head', 'feature']) {
                    try { keep(api.on(name, () => draw())); } catch { /* an older host without that event */ }
                }
            }
            draw();
            return {
                update: () => draw(),
                destroy: () => offs.splice(0).forEach(off => { try { off(); } catch { /* gone already */ } }),
            };
        },
    });
}
