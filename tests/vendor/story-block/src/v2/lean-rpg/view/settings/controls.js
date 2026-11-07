// The RPG settings page's small builders: a card section, choice chips, a labelled field, a bounded number row and
// the note naming a value the story's pack decides. They write into the page's live card map and root.

import { h } from '../../../view/widgets/dom.js';
import { packInForce } from '../../rules.js';
import { fill } from '../../strings.js';
import { S } from './constants.js';

export function createControls({ doc, cards, root, put, redraw, pack, values }) {
    function card(key, title, help) {
        const node = h(doc, 'section', 'rpg-set-card');
        node.setAttribute('data-card', key);
        node.appendChild(h(doc, 'h4', 'rpg-set-title', title));
        if (help) node.appendChild(h(doc, 'p', 'rpg-set-help', help));
        cards[key] = node;
        root.appendChild(node);
        return node;
    }
    function chips(parent, label, options, value, pick) {
        const row = h(doc, 'div', 'rpg-set-chips');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', label);
        for (const [id, text] of options) {
            const chip = h(doc, 'button', 'rpg-chip', text);
            chip.setAttribute('type', 'button');
            chip.setAttribute('data-value', id);
            chip.setAttribute('aria-pressed', String(id === value));
            chip.addEventListener('click', () => { if (id !== value) { pick(id); redraw(`[data-card="${parent.getAttribute('data-card')}"] [data-value="${id}"]`); } });
            row.appendChild(chip);
        }
        parent.appendChild(row);
    }
    const field = (parent, label, help) => {
        const wrap = h(doc, 'label', 'rpg-set-num');
        wrap.appendChild(h(doc, 'span', '', label));
        parent.appendChild(wrap);
        return { add: node => { wrap.appendChild(node); wrap.appendChild(h(doc, 'small', '', help)); return node; } };
    };

    // "From the pack: Ersveil" when the story's pack decides the formula or the numbers (the reader has chosen nothing there).
    const packNote = (...which) => {
        const given = pack(), live = packInForce(values(), given);
        return given && which.some(key => live[key]) ? h(doc, 'p', 'rpg-set-help rpg-from-pack', fill(S.fromPack, { name: given.name || given.pack || '' })) : null;
    };

    function numberRow(grid, { label, help, setting, min, max, step, current, clean, unit = '' }) {
        const slot = field(grid, label, help);
        const input = doc.createElement('input');
        input.setAttribute('type', 'number');
        input.setAttribute('min', String(min));
        input.setAttribute('max', String(max));
        input.setAttribute('step', String(step));
        input.setAttribute('inputmode', 'numeric');
        input.setAttribute('data-setting', setting);
        input.setAttribute('aria-label', label);
        input.className = 'rpg-set-input';
        input.value = String(current());
        input.addEventListener('change', () => {
            const typed = Number(String(input.value).trim());
            // A number outside its range is held to it (and to its step); something that is not a number is put back.
            const next = Number.isFinite(typed) && String(input.value).trim() !== '' ? clean(typed) : current();
            input.value = String(next);
            put(setting, next);
        });
        // A unit stands beside the input on the same row (approved mockup rpg-no-rolls.html: `<div class="row"><input> <span>seconds</span></div>`).
        if (unit) {
            const row = h(doc, 'div', 'rpg-set-row');
            row.append(input, h(doc, 'span', 'rpg-set-unit', unit));
            slot.add(row);
        } else slot.add(input);
    }

    return { card, chips, field, numberRow, packNote };
}
