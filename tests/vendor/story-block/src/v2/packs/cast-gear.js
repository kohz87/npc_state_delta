// A cast member's signature gear (`story-block.gear`, docs/v2/GEAR.md "Signature gear"): the pack items a person brings when they join the
// party, and the one "Gear:" line the narrator's cast entry may carry while they are not in it. Pure: the enabled packs in, plain rows out.

import { foldKey, oneLine } from '../../text.js';
import { slotWordOf } from '../domains/gear.js';

/**
 * The cast entry a name means (its name or an alias, folded) and the pack items of its `gear`, in the order written:
 * `{ id, name, aliases, pack, items: [{ id, name, slot }] }` or null. `packs`: the enabled packs (`packs.packs()`); the first pack with the person wins.
 */
export function castGearOf(packs, name) {
    const key = foldKey(oneLine(name));
    if (!key) return null;
    for (const pack of Array.isArray(packs) ? packs : []) {
        const person = (pack?.content?.cast ?? []).find(entry => [entry.name, ...(entry.aliases ?? [])].some(each => foldKey(each) === key));
        if (!person) continue;
        const byId = new Map((pack.content.items ?? []).map(item => [item.id, item]));
        const items = (person.gear ?? []).map(id => byId.get(id)).filter(item => item && item.kind === 'equipment' && slotWordOf(item.slot))
            .map(item => ({ id: item.id, name: item.name, slot: slotWordOf(item.slot) }));
        return { id: person.id, name: person.name, aliases: [...(person.aliases ?? [])], pack: pack.id, items };
    }
    return null;
}

/** The narrator's short line: `Gear: Cane Sword, Oak Buckler`, or '' for no gear. */
export const gearLine = items => (items.length ? `Gear: ${items.map(item => item.name).join(', ')}` : '');
