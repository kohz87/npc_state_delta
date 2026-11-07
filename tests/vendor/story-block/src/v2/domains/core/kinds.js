// Story Block's core change-line kinds and the `~ you` grammar line. They are static grammar text plus
// feature flags; the capture handlers that apply them live with the scene and inventory domains.

import { CORE_FEATURE } from '../../features.js';
import { EXTRA_KINDS } from '../../extras.js';
import { FEATURE } from '../inventory.js';
import { WEATHER_CHARS, YOU_CHARS } from '../scene.js';

/** The `~ you` grammar line: wearing and condition, and a rank under the pack's own word for it (`label`) when a pack gives one. */
export function youGrammar(label = '') {
    return `~ you ${label ? `rank: ${label} | ` : ''}wearing: what {{user}} has on | condition: how {{user}} is (only when one changes; each at most ${YOU_CHARS} characters)`;
}

export const CORE_KINDS = Object.freeze({
    item: Object.freeze({ grammar: '+ item Name | qty: 1 | note: short detail (- item Name | qty: 1 when used up or lost; ~ item Name | note: … when it changes)' }),
    coin: Object.freeze({ grammar: '+ coin 30 | from: who (- coin 5 | to: who when paid; whenever {{user}} is paid or pays in the story, even a few coins, write the coin line; one number, in the wallet\'s currency)' }),
    place: Object.freeze({ grammar: '~ place Name | kind: settlement|wild|dungeon|… | region: wider area | with: who came along (the rest stay behind)' }),
    // `after: ['place']`: a move leaves behind everyone it does not bring (scene.js setPlace), so a reply's present lines run behind its place line,
    // whatever order they were written in (registry captureEntry, capture-flow linesInOrder): the people the story adds at the new place stay.
    present: Object.freeze({ grammar: '+ present Name when someone arrives, - present Name when they leave; when someone already here is first named, - present the old word and + present the name (- present clerk, + present Nelje)', after: Object.freeze(['place']) }),
    // MODULES §F120: the weather, descriptive only; its grammar line only while `story-block.weather` is on.
    weather: Object.freeze({ grammar: `~ weather cold drizzle, low fog (only when the weather changes, not every reply; a few words, at most ${WEATHER_CHARS} characters)`, feature: CORE_FEATURE.weather }),
    // MODULES §F126: {{user}}'s rank, what they wear and how they are, descriptive only; its grammar line only while `story-block.you` is on.
    // Without a pack that gives a Rank (`content.you.rank`) the line names wearing and condition only; with one, `youGrammar(label)`.
    you: Object.freeze({ grammar: youGrammar(''), feature: CORE_FEATURE.you }),
    // The party's mounts (src/v2/domains/mounts.js): their grammar line only while `story-block.mounts` is on.
    mount: Object.freeze({ grammar: '+ mount Name | kind: horse|mule|cart|… | count: 1 | pace: km/day | where: who rides or where it is (~ mount Name | condition: lame; - mount Name when lost or sold; at most 6)', feature: CORE_FEATURE.mounts }),
    // MODULES §F100: off, the kind and its grammar line are left out (a host without Features keeps it).
    loot: Object.freeze({ grammar: '? loot Thing, Other Thing x2 — where it lies (things the party could pick up; the reader chooses what to take)', feature: FEATURE.loot }),
    // MODULES §F115: display kinds, read for the reader alone (src/v2/extras.js); each under its feature.
    ...EXTRA_KINDS,
});
