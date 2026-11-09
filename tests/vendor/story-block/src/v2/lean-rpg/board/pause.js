// The pause screen between Send and the fight board: a typed attack on standing foes, held until the reader plays it.
// It renders pauseViewData only; the choices (Fight on the board, Auto-fight, and for foes the pre-check found Send without a fight) are callbacks so the send
// flow keeps ownership of the fight. While the pre-check reads, the same box shows one quiet line with a spinner and no choice.

import { button, h, text } from '../../view/widgets/dom.js';

export const PAUSE_ROOT = 'rpg-fight-pause';

/**
 * createPauseView({ doc, onBoard, onAuto, onSend })
 * → { render(container, data), update(data), clear(), destroy(), element }.
 * A typed attack on standing foes offers two choices: the board and Auto-fight; on foes the pre-check found, a third: Send without a fight (`sendLabel`).
 */
export function createPauseView({ doc = globalThis.document, onBoard = () => {}, onAuto = () => {}, onSend = () => {} } = {}) {
    let host = null, root = null, shown = null;
    const clear = () => { root?.remove?.(); root = null; return null; };

    function draw() {
        if (!host || !shown) return null;
        if (!root) root = h(doc, 'section', PAUSE_ROOT);
        root.className = `${PAUSE_ROOT} ${PAUSE_ROOT}-known ss-glass`;
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', text(shown.label) || 'Fight pause');
        root.replaceChildren();
        if (shown.mode === 'working') {
            const status = h(doc, 'p', 'rpg-fight-pause-title rpg-fight-pause-working');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.append(h(doc, 'span', 'rpg-fight-pause-spinner'), text(shown.title, 100));
            root.appendChild(status);
            if (text(shown.hint, 180)) root.appendChild(h(doc, 'p', 'rpg-fight-pause-note', text(shown.hint, 180)));
            if (root.parentNode !== host) host.appendChild(root);
            return root;
        }
        if (text(shown.title, 300)) root.appendChild(h(doc, 'h3', 'rpg-fight-pause-title', text(shown.title, 300)));
        if (text(shown.note, 180)) root.appendChild(h(doc, 'p', 'rpg-fight-pause-note', text(shown.note, 180)));
        const actions = h(doc, 'div', 'rpg-fight-pause-actions');
        actions.appendChild(button(doc, text(shown.boardLabel) || 'Fight on the board', 'ss-button ss-button-primary rpg-fight-pause-board', () => onBoard?.(shown)));
        if (text(shown.autoLabel)) actions.appendChild(button(doc, text(shown.autoLabel), 'ss-button rpg-fight-pause-auto', () => onAuto?.(shown)));
        if (text(shown.sendLabel)) actions.appendChild(button(doc, text(shown.sendLabel), 'ss-button rpg-fight-pause-send', () => onSend?.(shown)));
        root.appendChild(actions);
        if (text(shown.hint, 180)) root.appendChild(h(doc, 'p', 'rpg-fight-pause-note rpg-fight-pause-hint', text(shown.hint, 180)));
        if (root.parentNode !== host) host.appendChild(root);
        return root;
    }

    return {
        render(container, data) {
            host = container ?? null;
            shown = data ?? null;
            if (!host || !shown) { clear(); return null; }
            return draw();
        },
        update(data) { shown = data ?? null; return draw(); },
        clear,
        destroy() { clear(); host = null; shown = null; },
        get element() { return root; },
    };
}
