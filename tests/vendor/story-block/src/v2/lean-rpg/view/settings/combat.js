// Draws the RPG settings Combat card: the chat's Combat rules text in a bounded box, saved as an edit of that block
// when the box is left, reset, hidden with the page, or the window closes; one save waits for the one before it.

import { h } from '../../../view/widgets/dom.js';
import { refusalText } from '../../../strings.js';
import { fill } from '../../strings.js';
import { COMBAT_MAX, COMBAT_DEFAULT, combatBlock, combatTemplate, withPrompt } from '../settings-data.js';
import { oneLine } from '../../../../text.js';
import { S } from './constants.js';

export function createCombatSection({ doc, root, card, values, pack, roleOf, command, headState, onChange, redraw, isAlive, state }) {
    // The Combat text's saves go one at a time: `asked` is the text last asked for (until its save is done), `inFlight` the saves so far.
    let asked = null, inFlight = Promise.resolve();

    function drawCombat() {
        const box = card('combat', S.combat, S.combatHelp);
        const block = combatBlock(headState(), { roleOf });
        state.flush = null;
        state.shown = block ? `${block.module}\n${block.prompt}` : '';
        if (!block) {
            box.appendChild(h(doc, 'p', 'rpg-set-help rpg-combat-none', S.combatNone));
            if (typeof command === 'function') {
                const add = h(doc, 'button', 'ss-button rpg-set-button', S.combatAdd);
                add.setAttribute('type', 'button');
                add.setAttribute('data-act', 'combat-add');
                add.addEventListener('click', async () => {
                    const definition = combatTemplate();
                    const result = definition ? await command('dm.define', { definition }) : null;
                    state.note = result?.ok ? S.combatAdded : refusalText(result, S.combatFailed, { pinsFull: S.combatPinsFull });
                    if (isAlive()) redraw('[data-act="combat-add"]');
                });
                box.appendChild(add);
            }
        } else {
            const area = doc.createElement('textarea');
            area.className = 'rpg-set-area';
            area.setAttribute('rows', '9');
            area.setAttribute('aria-label', S.combatLabel);
            area.setAttribute('data-field', 'combat');
            area.value = block.prompt;
            const row = h(doc, 'div', 'rpg-set-row');
            const reset = h(doc, 'button', 'ss-button rpg-set-button', S.combatReset);
            reset.setAttribute('type', 'button');
            reset.setAttribute('data-act', 'combat-reset');
            const count = h(doc, 'span', 'rpg-set-count');
            const status = h(doc, 'p', 'rpg-set-help rpg-set-status', state.note);
            status.setAttribute('role', 'status');
            const tally = () => {
                const n = [...oneLine(area.value)].length;
                count.textContent = fill(S.combatCount, { n, max: COMBAT_MAX });
                count.classList.toggle('rpg-over', n > COMBAT_MAX);
                return n;
            };
            // Saved when the box is left (not on every key: each save is an edit of the block on the latest reply), and when the
            // window closes or the page is hidden while the box still has what was typed (no `change` comes when a box is taken away).
            // A save waits for the one in flight, and what is asked is compared with the last text asked for, not with the block as it
            // stands (which only changes when a save is done), so the last thing the reader did is what is kept.
            async function write(text) {
                let result;
                try {
                    if (text === block.prompt) return;
                    result = await command('dm.redefine', { module: block.module, definition: withPrompt(block.definition, text) });
                } finally { if (asked === text) asked = null; }
                state.note = result?.ok ? S.combatSaved : refusalText(result, S.combatFailed, { pinsFull: S.combatPinsFull });
                // The box may have been drawn again while the command ran (the story moved): the note goes on the one that is there now.
                const shown = root.querySelector('.rpg-set-status');
                if (shown) shown.textContent = state.note;
                if (result?.ok) { block.prompt = text; state.shown = `${block.module}\n${text}`; onChange(); }
            }
            function save() {
                const text = oneLine(area.value);
                if (text === (asked ?? block.prompt) || typeof command !== 'function') return inFlight;
                if (tally() > COMBAT_MAX) { state.note = fill(S.combatTooLong, { max: COMBAT_MAX }); status.textContent = state.note; return inFlight; }
                asked = text;
                const run = inFlight.then(() => write(text));
                inFlight = run.catch(() => {});
                return run;
            }
            state.flush = save;
            area.addEventListener('input', tally);
            area.addEventListener('change', save);
            area.addEventListener('focusout', save);
            reset.addEventListener('click', () => { area.value = COMBAT_DEFAULT; tally(); save(); });
            row.append(reset, count);
            box.append(area, row, status);
            tally();
        }
    }

    return { drawCombat };
}
