// The pause screen between Send and the fight board: known foes, the planner's wait, or new foes with rolled approach checks.
// It renders pauseViewData only; both choices are callbacks so the send flow keeps ownership of the fight.

import { button, h, text } from '../../view/widgets/dom.js';

export const PAUSE_ROOT = 'rpg-fight-pause';

const outcomeName = value => (value === 'success' || value === 'cost' || value === 'fail' ? value : 'neutral');

/**
 * createPauseView({ doc, onBoard, onNarrate })
 * → { render(container, data), update(data), clear(), destroy(), element }.
 * Narration is available even while the opening is being planned.
 */
export function createPauseView({ doc = globalThis.document, onBoard = () => {}, onNarrate = () => {} } = {}) {
    let host = null, root = null, shown = null;
    const clear = () => { root?.remove?.(); root = null; return null; };

    function foeRow(foe) {
        const row = h(doc, 'div', 'rpg-fight-pause-foe');
        row.appendChild(h(doc, 'span', 'rpg-fight-pause-foe-name', text(foe?.label ?? foe?.name, 140)));
        if (text(foe?.health, 40)) row.appendChild(h(doc, 'span', 'rpg-fight-pause-foe-health', text(foe.health, 40)));
        return row;
    }

    function draw() {
        if (!host || !shown) return null;
        if (!root) root = h(doc, 'section', PAUSE_ROOT);
        const mode = shown.mode === 'new' || shown.mode === 'working' ? shown.mode : 'known';
        root.className = `${PAUSE_ROOT} ${PAUSE_ROOT}-${mode} ss-glass`;
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', text(shown.label) || 'Fight pause');
        root.replaceChildren();
        if (mode === 'working') {
            const status = h(doc, 'div', 'rpg-fight-pause-working');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            status.appendChild(h(doc, 'span', 'rpg-fight-pause-spinner'));
            status.appendChild(h(doc, 'span', '', text(shown.status) || 'Working out the fight…'));
            root.appendChild(status);
            const actions = h(doc, 'div', 'rpg-fight-pause-actions');
            actions.appendChild(button(doc, text(shown.narrateLabel) || 'Narrate it instead', 'ss-button rpg-fight-pause-narrate', () => onNarrate?.(shown)));
            root.appendChild(actions);
        } else {
            if (text(shown.title, 100)) root.appendChild(h(doc, 'h3', 'rpg-fight-pause-title', text(shown.title, 100)));
            if (text(shown.note, 180)) root.appendChild(h(doc, 'p', 'rpg-fight-pause-note', text(shown.note, 180)));
            if (shown.foes?.length) {
                const foes = h(doc, 'div', 'rpg-fight-pause-foes');
                if (text(shown.foeTitle, 40)) foes.appendChild(h(doc, 'h4', 'rpg-fight-pause-foes-head', text(shown.foeTitle, 40)));
                for (const foe of shown.foes) foes.appendChild(foeRow(foe));
                root.appendChild(foes);
            }
            if (shown.checks?.length) {
                root.appendChild(h(doc, 'h4', 'rpg-fight-pause-checks-head', 'Approach checks'));
                const checks = h(doc, 'ul', 'rpg-fight-pause-checks');
                for (const check of shown.checks) {
                    const line = h(doc, 'li', `rpg-fight-pause-check rpg-fight-pause-${outcomeName(check?.outcome)}`, text(check?.label, 220));
                    line.setAttribute('data-outcome', outcomeName(check?.outcome));
                    checks.appendChild(line);
                }
                root.appendChild(checks);
            }
            if (text(shown.edge, 160)) root.appendChild(h(doc, 'p', 'rpg-fight-pause-edge', text(shown.edge, 160)));
            const actions = h(doc, 'div', 'rpg-fight-pause-actions');
            actions.appendChild(button(doc, text(shown.boardLabel) || 'Fight it on the board', 'ss-button ss-button-primary rpg-fight-pause-board', () => onBoard?.(shown)));
            actions.appendChild(button(doc, text(shown.narrateLabel) || 'Narrate it instead', 'ss-button rpg-fight-pause-narrate', () => onNarrate?.(shown)));
            root.appendChild(actions);
        }
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
