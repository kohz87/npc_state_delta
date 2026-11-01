// The game view's header, for the RPG: the reader's own character's stage bars (Health, Mana, Stamina) and its experience, as the
// bars `ss.hero` draws (view/widgets/hero.js: `{ kind: hp | mp | sp | exp, label, value, max, text }`). The header reads a lead's pools from
// the party module's `party.pc`; the RPG keeps its character in a block (a Character block, see party-data.js) and no such module answers, so
// without this the header had no bars (they were only on the Party and Fight tabs). Pure: no DOM.

import { RPG_STRINGS, fill } from '../strings.js';
import { BARS, readParty } from './party-data.js';

const KINDS = Object.freeze({ health: 'hp', mana: 'mp', stamina: 'sp' });
const P = RPG_STRINGS.party;

/**
 * The header's lead from the story state: `{ name, bars }` for the reader's own character (`own` is the reader's name; the one whose
 * Character block names them), or null when there is none (no character yet, or the block names another person). A character who left
 * the party has none. The stage words are the bars' text ("Hurt"), the experience reads "12 / 100".
 */
export function heroLead(state, { own = '', roleOf } = {}) {
    const character = readParty(state, { own, roleOf }).find(item => item.own && !item.left);
    if (!character) return null;
    const bars = BARS.map(key => {
        const bar = character.bars[key];
        const label = character.definition.state?.[key]?.label ?? RPG_STRINGS.bars[key];
        return { kind: KINDS[key], label, value: bar.value, max: bar.max, text: bar.word };
    });
    bars.push({ kind: 'exp', label: P.xp, value: character.xp, max: 100, text: fill(P.xpText, { xp: character.xp }) });
    return { name: character.name, bars };
}
