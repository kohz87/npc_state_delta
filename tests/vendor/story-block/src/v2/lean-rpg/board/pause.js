// The pause screen between Send and the fight board: a typed attack on standing foes, held until the reader plays it.
// It renders pauseViewData only; the choices (Fight on the board, Auto-fight) are callbacks so the send flow keeps ownership of the fight.

import { button, h, text } from '../../view/widgets/dom.js';

export const PAUSE_ROOT = 'rpg-fight-pause';

/**
 * createPauseView({ doc, onBoard, onAuto })
 * → { render(container, data), update(data), clear(), destroy(), element }.
 * A typed attack on standing foes offers exactly two choices: the board and Auto-fight.
 */
export function createPauseView({ doc = globalThis.document, onBoard = () => {}, onAuto = () => {} } = {}) {
    let host = null, root = null, shown = null;
    const clear = () => { root?.remove?.(); root = null; return null; };

    function draw() {
        if (!host || !shown) return null;
        if (!root) root = h(doc, 'section', PAUSE_ROOT);
        root.className = `${PAUSE_ROOT} ${PAUSE_ROOT}-known ss-glass`;
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', text(shown.label) || 'Fight pause');
        root.replaceChildren();
        if (text(shown.title, 100)) root.appendChild(h(doc, 'h3', 'rpg-fight-pause-title', text(shown.title, 100)));
        if (text(shown.note, 180)) root.appendChild(h(doc, 'p', 'rpg-fight-pause-note', text(shown.note, 180)));
        const actions = h(doc, 'div', 'rpg-fight-pause-actions');
        actions.appendChild(button(doc, text(shown.boardLabel) || 'Fight on the board', 'ss-button ss-button-primary rpg-fight-pause-board', () => onBoard?.(shown)));
        if (text(shown.autoLabel)) actions.appendChild(button(doc, text(shown.autoLabel), 'ss-button rpg-fight-pause-auto', () => onAuto?.(shown)));
        root.appendChild(actions);
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
