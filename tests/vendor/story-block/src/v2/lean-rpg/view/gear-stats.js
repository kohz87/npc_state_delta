// What gear adds to a character's stats, for the Party card and the Skills sheet. It asks the one source the rolls use: `planGear` (the gear record of
// every member: worn pieces, broken ones give nothing, the load) laid over the stats by `applyGear` (the sum held to 30, the encumbered penalty). Nothing is
// worked out another way here. Each stat of a card gets `eff` (the stat a roll uses) and `add` (eff minus the block's number) only where they differ;
// `value` stays the block's number (the Stats screen and the bars' growth read that). Without a plan (Gear in fights off) the party is returned as it is.
import { applyGear } from '../gear.js';
import { fold } from '../read.js';

/** `party` (readParty's) with `eff` and `add` on the stats gear moves; `plan` is `planGear(...)`'s record or null. */
export function dressParty(party, plan) {
    if (!plan?.who) return party;
    const sheet = { characters: party.map(character => ({ key: fold(character.name), stats: Object.fromEntries(character.stats.map(stat => [stat.key, stat.value])) })) };
    // (two cards with one name: the first one's key is the one the roll reads, as the sheet does)
    const seen = new Set();
    const dressed = applyGear(sheet, plan).characters;
    return party.map((character, at) => {
        const key = dressed[at].key;
        if (seen.has(key)) return character;
        seen.add(key);
        const stats = character.stats.map(stat => {
            const eff = dressed[at].stats[stat.key];
            return Number.isInteger(eff) && eff !== stat.value ? { ...stat, eff, add: eff - stat.value } : stat;
        });
        return stats.some((stat, i) => stat !== character.stats[i]) ? { ...character, stats } : character;
    });
}

/** The number a roll uses for a stat entry of a card. */
export const effOf = stat => (Number.isInteger(stat?.eff) ? stat.eff : stat?.value);
