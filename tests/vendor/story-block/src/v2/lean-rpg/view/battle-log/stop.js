// The battle log's why-it-ended words: one muted line for a recorded stop and the plain Settings hint for the
// pace and exchange-cap reasons. Pure words only; a record with no stop keeps the log exactly as it was.

import { LIMITS, PACE } from '../../names.js';

const STOP_WORDS = Object.freeze({
    won: 'Ended: every foe is down.',
    lost: 'Ended: the party is down.',
    heavy: 'Ended: a hero was badly hurt (2 or more Health blocks).',
    budget: 'Ended: the rolls were trimmed to fit the note size.',
    fled: 'Ended: the party fled.',
    decisive: 'Ended: a decisive round (old rule).',
    over: 'Ended: the fight was decided (old rule).',
});
const CONTINUES = 'Fight continues: you pick the next exchange.';
const SETTINGS_HINT = 'The fight goes on next reply. To allow more per reply: Settings → RPG → Rolls → Most exchanges per reply.';
const integer = value => (Number.isSafeInteger(value) ? value : null);

// The cap the roll used: the reader's resolved `cap`, else its rules, else the default for its flow.
function capOf(model) {
    return integer(model?.cap) ?? integer(model?.rules?.roundCap) ?? (model?.flow === 2 ? LIMITS.roundCapDefault : LIMITS.roundCap);
}

// The exchanges an old-flow pace allowed. The record's `pace` is the only source; without it the line stays silent.
function paceLimit(model) {
    const pace = typeof model?.pace === 'string' ? model.pace : '';
    if (Object.hasOwn(PACE, pace)) return PACE[pace];
    return integer(model?.rounds?.length);
}

/**
 * The words under the last round (or nothing): `model` is a recorded/replayed roll with `stop`, `pace`, `flow`,
 * `cap`, `board` and optional `rules`. Board stops never borrow the board record's fixed careful pace.
 */
export function stopLine(model) {
    const stop = typeof model?.stop === 'string' ? model.stop : '';
    if (!stop || stop === 'none') return '';
    if (model?.board === true) {
        if (stop === 'open') return CONTINUES;
        if (stop === 'fled') return STOP_WORDS.fled;
        return stop === 'won' || stop === 'lost' ? STOP_WORDS[stop] : '';
    }
    if (stop === 'pace') {
        if (model?.flow === 2) return model?.pace === 'careful' ? 'Ended: careful pace allows 1 exchange.' : '';
        const limit = paceLimit(model);
        return limit === null ? '' : `Ended: pace limit (${limit}).`;
    }
    if (stop === 'cap') return `Ended: reached the most exchanges per reply (${capOf(model)}).`;
    return Object.hasOwn(STOP_WORDS, stop) ? STOP_WORDS[stop] : '';
}

/** The plain-text hint shown under a pace or cap stop; '' for every other reason and for board fights. */
export function stopHint(model) {
    if (model?.board === true || (model?.stop !== 'pace' && model?.stop !== 'cap') || !stopLine(model)) return '';
    return SETTINGS_HINT;
}
