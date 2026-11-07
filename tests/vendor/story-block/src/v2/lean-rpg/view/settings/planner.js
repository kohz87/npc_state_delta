// Draws the RPG settings Planner card: the reader's bounded note and the planner's full prompt, previewed from the
// same live values as a roll will use.

import { h } from '../../../view/widgets/dom.js';
import { NOTE_MAX, NOTE_SETTING, formulaOf, plannerNoteOf } from '../../rules.js';
import { fill } from '../../strings.js';
import { plannerPrompt } from '../settings-data.js';
import { S } from './constants.js';

export function createPlannerSection({ doc, card, values, put, headState, pack }) {
    let previewParts = null;

    function drawPlanner() {
        const box = card('planner', S.planner, S.plannerHelp);
        const area = doc.createElement('textarea');
        area.className = 'rpg-set-area';
        area.setAttribute('rows', '3');
        area.setAttribute('maxlength', String(NOTE_MAX));
        area.setAttribute('aria-label', S.plannerLabel);
        area.setAttribute('data-field', 'planner');
        area.value = plannerNoteOf(values());
        const count = h(doc, 'span', 'rpg-set-count');
        const row = h(doc, 'div', 'rpg-set-row');
        row.appendChild(count);
        const fold = h(doc, 'details', 'rpg-set-fold');
        fold.appendChild(h(doc, 'summary', '', S.plannerShow));
        const pre = h(doc, 'pre', 'rpg-set-pre');
        fold.append(pre, h(doc, 'p', 'rpg-set-help', S.plannerFixed));
        previewParts = { area, count, pre };
        // Kept as it is typed (a short text, saved with the rest of the settings), so the prompt below is always the real one.
        area.addEventListener('input', () => {
            const text = plannerNoteOf({ [NOTE_SETTING]: area.value });
            put(NOTE_SETTING, text);
            drawPreview();
        });
        box.append(area, row, fold);
        drawPreview();
    }
    function drawPreview() {
        if (!previewParts) return;
        const note = plannerNoteOf(values());
        previewParts.count.textContent = fill(S.plannerCount, { n: [...previewParts.area.value].slice(0, NOTE_MAX).length, max: NOTE_MAX });
        previewParts.pre.textContent = plannerPrompt(headState(), note, { standard: formulaOf(values(), pack()) === 'standard' });
    }

    return { drawPlanner, drawPreview };
}
