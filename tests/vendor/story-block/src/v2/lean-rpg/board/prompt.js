// Keeps the board's fixed grammar as small as a quiet reply's grammar.
// Combat flavour and manual rules are supplied only in the reply context that can use them.
import { activeDefinition } from '../../data-modules/adapters.js';
import { moduleGrammar, referenceOf } from '../../data-modules/grammar.js';
import { oneLine } from '../../../text.js';
import { CLEAR_ONLY, narratedFoeGrammar } from './narrated-grammar.js';

// How a fight starts under the board: the story sets a foe slot, the offer line appears, and code plays the blows.
const START = 'A fight starts when you set a foe slot; the reader plays it on the board, so tell no blows yourself.';

export { boardGrammar, boardXpGuide } from '../../data-modules/board-static.js';

export function boardReplyGrammar(state, { fight = false, manual = false, practice = false } = {}) {
    const ids = Object.keys(state?.domains?.dataModules?.active ?? {});
    const lines = ids.flatMap(id => {
        const definition = activeDefinition(state, id);
        if (!definition) return [];
        if (definition.role === 'rules' && fight) {
            // Keep the pack's combat flavour exactly as before; the fixed XP guide is already sent.
            const prompt = String(definition.prompt ?? '')
                .replace(/Rolls: tell the rolled result as given; code moves the bars for hits, heals, skill costs: never set those\.\s*/u, '')
                .replace(/XP guide:.*$/u, '').trim();
            return prompt ? [oneLine(prompt)] : [];
        }
        if (definition.role === 'foes' && fight) {
            const prompt = String(definition.prompt ?? '').replace(/The narrator sets a slot when a group arrives, hurts it as the fight goes and clears it when the group is down, gone, fled, captured or (?:has )?yielded\./u, 'The narrator sets a slot when a group arrives.');
            return prompt ? [oneLine(prompt)] : [];
        }
        if (definition.role === 'skills' && practice) {
            const lines = moduleGrammar(definition, referenceOf(ids, id), { prompt: false, only: /^practice-\d+$/u });
            return lines ? ['Practice a skill 5 to 20 per use.', lines] : [];
        }
        return [];
    });
    if (!fight) { if (ids.some(id => activeDefinition(state, id)?.role === 'foes')) lines.push(START); }
    else lines.push(...narratedFoeGrammar(state, manual ? undefined : CLEAR_ONLY));
    return lines;
}
