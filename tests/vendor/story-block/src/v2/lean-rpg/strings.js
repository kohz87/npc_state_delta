// Every text the RPG screens show the reader (the Party tab, the Spend points sheet, the battle log, the
// "Changed this reply" lines and the Settings → RPG page), in one place like src/v2/strings.js. A text with holes names
// them in braces and is filled with `fill`. Plain words, no markup.

import { fill } from '../strings.js';

export { fill };

import { CHARACTER_STRINGS } from './strings/character.js';
import { STORY_STRINGS } from './strings/story.js';
import { FIGHT_STRINGS } from './strings/fight.js';

export const RPG_STRINGS = Object.freeze({
    ...CHARACTER_STRINGS,
    ...STORY_STRINGS,
    ...FIGHT_STRINGS,
});
