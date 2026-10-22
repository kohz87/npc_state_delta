// "Before you start" on the Home screen: the `story-block.ready-hint` host widget. While a module's
// canGenerate hook holds the story back (MODULES §F12: RPG Battle until your character exists), it draws
// one panel with each such module's name and reason and, when the module has an onBlocked hook, a button
// that runs it (RPG Battle's opens the character wizard). The button's words are the module's own
// (`{ ok: false, reason, action }`), else a plain default; `action: false` asks for no button. With no
// module holding back (Story Block alone, or the character made) it draws nothing.
//
// ui-host.js passes `blockers()` (turn.blockers: every canGenerate asked, nothing logged) and
// `unblock(moduleId, reason)` (turn.unblock: that module's onBlocked hook). It redraws on the host's
// `head`, `committed`, `turn` and `feature` events. Setup, not a story action (F95/F96): the button runs
// no command itself. Text is set with textContent.

import { STRINGS } from '../strings.js';

const S = STRINGS.readyHint;

export const READY_HINT_WIDGET = 'story-block.ready-hint';

// The longest reason shown (a module's sentence; longer ones are cut).
const REASON_LIMIT = 300;
const cut = (value, max) => Array.from(String(value ?? '')).slice(0, max).join('');

function el(doc, tag, className = '', text = '') {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * The widget → `{ props, render(el, props, api) }`. `blockers()` → (a promise of) [{ moduleId, name, reason,
 * action, canOpen }]; `unblock(moduleId, reason)` runs that module's onBlocked hook.
 */
export function createReadyHintWidget({ blockers = () => [], unblock = () => false } = {}) {
    return Object.freeze({
        props: {},
        primary: null,
        validate: () => [],
        render(host, _props, api = {}) {
            const doc = host.ownerDocument ?? globalThis.document;
            let drawn = 0;
            let gone = false;
            function paint(list) {
                if (!list.length) {
                    host.replaceChildren();
                    return;
                }
                const root = el(doc, 'section', 'panel ready-hint');
                root.setAttribute('aria-label', S.title);
                const head = el(doc, 'h4');
                const glyph = el(doc, 'i', 'fa-solid fa-flag-checkered');
                glyph.setAttribute('aria-hidden', 'true');
                head.append(glyph, doc.createTextNode(` ${S.title}`));
                const rows = el(doc, 'ul', 'sb-ready-list');
                for (const entry of list) {
                    const row = el(doc, 'li', 'sb-ready-item');
                    row.dataset.module = String(entry.moduleId ?? '');
                    const text = el(doc, 'p', 'sb-ready-reason');
                    text.append(el(doc, 'b', '', cut(entry.name ?? entry.moduleId, 80)), doc.createTextNode(`: ${cut(entry.reason, REASON_LIMIT)}`));
                    row.append(text);
                    if (entry.canOpen) {
                        const go = el(doc, 'button', 'btn sb-ready-go');
                        go.type = 'button';
                        go.setAttribute('type', 'button');
                        const icon = el(doc, 'i', 'fa-solid fa-arrow-right');
                        icon.setAttribute('aria-hidden', 'true');
                        go.append(icon, el(doc, 'span', '', entry.action || S.go));
                        go.addEventListener('click', () => {
                            try { unblock(entry.moduleId, entry.reason); } catch { /* the turn logs a hook's failure */ }
                        });
                        row.append(go);
                    }
                    rows.append(row);
                }
                root.append(head, rows);
                host.replaceChildren(root);
            }
            async function draw() {
                const mine = ++drawn;
                let list = [];
                try { list = await blockers(); } catch { list = []; }
                if (gone || mine !== drawn) return;     // a newer draw (or the page) took over
                paint(Array.isArray(list) ? list.filter(entry => entry && typeof entry === 'object') : []);
            }
            const offs = [];
            if (typeof api?.on === 'function') {
                for (const name of ['head', 'committed', 'turn', 'feature']) {
                    try {
                        const off = api.on(name, () => { draw(); });
                        if (typeof off === 'function') offs.push(off);
                    } catch { /* an older host without that event */ }
                }
            }
            draw();
            return {
                update: () => { draw(); },
                destroy: () => {
                    gone = true;
                    offs.splice(0).forEach(off => { try { off(); } catch { /* gone already */ } });
                },
            };
        },
    });
}
