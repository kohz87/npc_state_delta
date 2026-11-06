// Classic rules and Rolls off still let the narrator move foe health.
// Their per-reply grammar restores those lines while the board's fixed grammar stays trimmed.

import { activeDefinition } from '../../data-modules/adapters.js';
import { moduleGrammar, referenceOf } from '../../data-modules/grammar.js';

export function narratedFoeGrammar(state) {
    const ids = Object.keys(state?.domains?.dataModules?.active ?? {});
    return ids.flatMap(id => {
        const definition = activeDefinition(state, id);
        if (definition?.role !== 'foes') return [];
        const lines = moduleGrammar(definition, referenceOf(ids, id), { prompt: false, only: /^(?:hurt|clear)-\d+$/u });
        return lines ? [lines] : [];
    });
}
