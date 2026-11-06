// The small fight offer under a narrator reply that set foes (the Fight tab's alert is the badge in view/fight.js).
// It draws only from offerLineData and hands the two choices back to the caller; it keeps no fight state itself.

import { button, h, text } from '../../view/widgets/dom.js';

export const OFFER_LINE_ROOT = 'rpg-fight-offer';

/**
 * createOfferLineView({ doc, onFight, onNarrate })
 * → { render(container, data), update(data), clear(), destroy(), element }.
 * `render` appends under the reply; `data.visible: false` removes the line (the reader kept narrating).
 */
export function createOfferLineView({ doc = globalThis.document, onFight = () => {}, onNarrate = () => {} } = {}) {
    let host = null, root = null, shown = null;
    const clear = () => { root?.remove?.(); root = null; return null; };

    function draw() {
        if (!host || !shown?.visible) return null;
        if (!root) root = h(doc, 'section', OFFER_LINE_ROOT);
        root.replaceChildren();
        root.className = OFFER_LINE_ROOT;
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', text(shown.label, 120) || 'Fight offer');
        const line = h(doc, 'p', 'rpg-fight-offer-line');
        const mark = h(doc, 'span', 'rpg-fight-offer-mark', '⚔');
        mark.setAttribute('aria-hidden', 'true');
        line.append(mark, h(doc, 'strong', '', text(shown.text, 300)));
        root.appendChild(line);
        const actions = h(doc, 'div', 'rpg-fight-offer-actions');
        actions.appendChild(button(doc, text(shown.boardLabel, 120) || 'Fight on the board', 'ss-button ss-button-primary rpg-fight-offer-fight', () => onFight?.(shown)));
        actions.appendChild(button(doc, text(shown.narrateLabel, 120) || 'Keep narrating', 'ss-button rpg-fight-offer-narrate', () => onNarrate?.(shown)));
        root.appendChild(actions);
        if (root.parentNode !== host) host.appendChild(root);
        return root;
    }

    return {
        render(container, data) {
            host = container ?? null;
            shown = data ?? null;
            if (!host || !shown?.visible) { clear(); return null; }
            return draw();
        },
        update(data) { shown = data ?? null; return draw(); },
        clear,
        destroy() { clear(); host = null; shown = null; },
        get element() { return root; },
    };
}
