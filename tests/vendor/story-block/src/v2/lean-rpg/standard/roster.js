// The Standard formula's sheet reader: every character, foe group and skill resource as a bar (id, kind, name, module, field,
// value, size); `maxOf` caps a bar by the block field it came from.
import { blocksFor, foeHealthBlocks } from '../formula.js';
import { FOE_SLOTS } from '../names.js';
import { foeBlocksByLevel } from '../foes.js';

export const charId = character => `c:${character.key}`;
export const foeId = slot => `f:${slot}`;
const hurtField = slot => `hurt${((slot - 1) % FOE_SLOTS) + 1}`;

// ---- the sheet, as bars -----------------------------------------------------------------------------------------------

// Every character and foe group as a bar: { id, kind, name, module, field, value, size }. A bar that cannot be read (no number) counts as full.
// `maxOf(module, field)`: the most the block's own field holds (a Classic block under the Standard formula holds at most 5).
export function rosterOf(sheet, maxOf) {
    const characters = sheet.characters.map((character, at) => {
        const size = Math.max(1, Math.min(blocksFor(character.base ?? character.stats).health, maxOf(character.module, 'health')));
        const value = Number.isInteger(character.health) ? Math.max(0, Math.min(size, character.health)) : size;
        return { at, id: charId(character), kind: 'char', character, name: character.who, module: character.module, field: 'health', value, size };
    });
    const foes = sheet.foes.filter(foe => foe.filled).map(foe => {
        const field = hurtField(foe.slot), size = Math.max(1, Math.min(foe.levelled ? foe.size ?? foeBlocksByLevel(foe.level) : foeHealthBlocks(foe.class), maxOf(foe.module, field)));
        const value = Number.isInteger(foe.hurt) ? Math.max(0, Math.min(size, foe.hurt)) : size;
        return { at: foe.slot, id: foeId(foe.slot), kind: 'foe', foe, name: foe.name, module: foe.module, field, value, size, slot: foe.slot };
    });
    // Stamina and Mana: a skill spends a block of its resource each use (the bars are named `c:<key>:stamina` and `c:<key>:mana`).
    const resources = characters.flatMap(({ character, name, module }) => ['stamina', 'mana'].map(field => {
        const size = Math.max(1, Math.min(blocksFor(character.base ?? character.stats)[field], maxOf(module, field)));
        const value = Number.isInteger(character[field]) ? Math.max(0, Math.min(size, character[field])) : size;
        return { id: `${charId(character)}:${field}`, kind: 'char', name, module, field, value, size };
    }));
    return { characters, foes, resources };
}
