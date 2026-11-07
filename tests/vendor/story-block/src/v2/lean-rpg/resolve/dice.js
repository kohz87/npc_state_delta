// The roll primitives the Standard roll shares with its record and guard: the flow version, the outcome rule and one dice stream per planned action.
// (resolve.js keeps the record and the replay guard; standard/ holds the roll itself.)

import { FORMULA } from '../names.js';
import { STANDARD } from '../rules.js';
import { rng as seededRandom } from '../../rng.js';

/** The version of the rule a reply's exchanges stop by (`flow` in the payload of `rpg.resolve`): 2 = until won, lost, heavy, the cap or the budget (see the top). */
export const FLOW_VERSION = 2;
/** The outcome for the party member's die and total against `against` (see the top); `rules` are the numbers in force (default: Standard). */
export function outcomeOf(die, total, against, rules = STANDARD) {
    if (die === FORMULA.die) return 'success';
    if (die === 1) return 'fail';
    if (total >= against) return 'success';
    return total >= against - rules.costMargin ? 'cost' : 'fail';
}

/**
 * The dice of one roll, one stream per planned action: `streams(kind, at)` → a function that gives that action's next d20 (1–20),
 * `kind` 'act', 'foe' or 'check' and `at` the action's index in the plan's list of that kind. `base` is one number drawn from the
 * receipt's seed; each action's stream is seeded from it and the action's place, so the streams never depend on one another.
 */
export function positionalDice(base) {
    // (`init` and `open`: the turn order and opening action.)
    const KIND = { act: 1, foe: 2, check: 3, init: 4, open: 5 };
    return Object.assign((kind, at) => {
        const random = seededRandom((base ^ Math.imul(KIND[kind] * 64 + at + 1, 0x9E3779B1)) >>> 0);
        return () => 1 + Math.floor(random() * FORMULA.die);
    }, { positional: true });
}
