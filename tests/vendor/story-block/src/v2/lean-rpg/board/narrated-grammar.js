// Rolls off lets the narrator move foe health; under the board the story only starts a fight (set-slot, in the fixed grammar) and
// ends one by clearing a group that left. These per-reply lines restore the foe kinds while the board's fixed grammar stays trimmed.

import { activeDefinition } from '../../data-modules/adapters.js';
import { moduleGrammar, referenceOf } from '../../data-modules/grammar.js';

/** The foe kinds the story may still write beside the board: only the clears (a group fled, yielded or went away). */
export const CLEAR_ONLY = /^clear-\d+$/u;

export function narratedFoeGrammar(state, only = /^(?:hurt|clear)-\d+$/u) {
    const ids = Object.keys(state?.domains?.dataModules?.active ?? {});
    return ids.flatMap(id => {
        const definition = activeDefinition(state, id);
        if (definition?.role !== 'foes') return [];
        const lines = moduleGrammar(definition, referenceOf(ids, id), { prompt: false, only });
        return lines ? [lines] : [];
    });
}
