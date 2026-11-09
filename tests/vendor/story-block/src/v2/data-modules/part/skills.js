// The Skills block's slot rules (moved out of data-modules/part.js unchanged): skill rows, learn
// and practice routing, the level's open slots, and the additive upgrade of an older block.
import { DM_LIMITS as L } from '../schema.js';
import { validateDataModules, dataModuleDefaults, dataModuleHash } from '../check.js';
import { copy, atPath } from '../interpreter.js';
import { activeDefinition } from '../adapters.js';
import { fill } from '../../strings.js';
import { fold, readSheet } from '../../lean-rpg/read.js';
import { SKILL_SLOTS_BASE, SKILL_SLOTS_EVERY, SKILL_SLOTS_MAX, SKILL_FIELDS_MAX, SLOT_NUMBER, UTILITY_SLOTS, isTypedSkills, skillTypeOf, signatureAt, skillSlots } from '../../skill-slots.js';
import { J, rpg, rawDefinition, instancePath } from './shared.js';

const skillCapacity = definition => Math.min(SKILL_SLOTS_MAX, Object.keys(definition?.state ?? {}).filter(key => /^skill\d+$/u.test(key)).length);
const skillRow = (fields, n) => ({ name: fields[`skill${n}`], about: typeof fields[`about${n}`] === 'string' ? fields[`about${n}`] : '', stat: fields[`stat${n}`], uses: fields[`uses${n}`] ?? 'stamina', rank: Number.isSafeInteger(fields[`rank${n}`]) ? fields[`rank${n}`] : 0 });
// A skill name or a reason as the matcher compares it: NFKC, lower case, runs of spaces and dashes as one space.
const words = value => ` ${String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-‐‑–—_]+/gu, ' ').replace(/[^\p{L}\p{N} ]/gu, '').replace(/ +/gu, ' ').trim()} `;
// The one skill a reason names (whole words; of two names inside it, the longer one if the shorter is part of it), else null.
function skillNamed(slots, reason) {
    const text = words(reason);
    const found = slots.filter(slot => slot.name && words(slot.name).trim() && text.includes(words(slot.name)));
    const top = found.filter(slot => !found.some(other => other !== slot && words(other.name).includes(words(slot.name)) && words(other.name) !== words(slot.name)));
    const keys = new Set(top.map(slot => words(slot.name)));
    return keys.size === 1 && top.length === 1 ? top[0] : null;
}
// The Skills block's story lines never overwrite a slot (USER, 3 Nov). `learn-N` of a name some slot already holds updates that slot (a signature skill, one a
// pack's cast member brought, is never updated: it keeps its name and slot); a new name goes to slot N if it is empty and open, else the first open one, else the
// line is refused. A slot is open when the block has it and the character's level has opened it (names.js skillSlots: 5, a sixth at Lv 20, a seventh at 40, an
// eighth at 60; a level drop only closes the empty ones). `practice-N` whose reason names one of the skills credits that skill's slot.
// → { kind, slot, name, update? } | { refuse } | null (not one of these lines: as written).
function skillRoute(fields, kindName, args, reason, room = SKILL_SLOTS_BASE) {
    const typed = isTypedSkills(fields), top = typed ? SKILL_FIELDS_MAX : SKILL_SLOTS_MAX;
    const learn = new RegExp(`^learn-(${SLOT_NUMBER})$`, 'u').exec(kindName), practice = new RegExp(`^practice-(${SLOT_NUMBER})$`, 'u').exec(kindName);
    if ((!learn && !practice) || Number((learn ?? practice)[1]) > top) return null;
    const slots = Array.from({ length: top }, (_, i) => ({ n: i + 1, type: skillTypeOf(fields, i + 1), name: typeof fields[`skill${i + 1}`] === 'string' ? fields[`skill${i + 1}`] : '', signature: signatureAt(fields.sig, i + 1) }));
    if (learn) {
        const wanted = fold(args.name);
        const same = wanted ? slots.find(slot => slot.name && fold(slot.name) === wanted) : undefined;
        if (same?.signature) return { refuse: fill(J.signature, { who: typeof fields.who === 'string' ? fields.who : '', skill: same.name }) };
        if (same) return { kind: `learn-${same.n}`, slot: same.n, name: same.name, update: true };
        if (typed) return typedLearn(slots, learn, args, fields, room);
        const at = Number(learn[1]);
        const free = at <= room && !slots[at - 1].name ? at : slots.find(slot => slot.n <= room && !slot.name)?.n;
        if (free) return { kind: `learn-${free}`, slot: free, name: args.name };
        // (`full`: no open slot is free, the only reason a block is extended; the words say when the next slot opens, or that all eight hold a skill)
        const held = slots.filter(slot => slot.name).length;
        return { refuse: `No free skill slot for ${args.name}. ${held >= SKILL_SLOTS_MAX ? J.slotsFull : fill(J.slotLater, { level: Math.max(0, held + 1 - SKILL_SLOTS_BASE) * SKILL_SLOTS_EVERY })}`, full: true };
    }
    const named = skillNamed(slots, reason);
    const slot = named ? named.n : Number(practice[1]);
    return { kind: `practice-${slot}`, slot, name: slots[slot - 1].name };
}
// A learn line for a new name in a block with types: the line's `type` (utility, else combat) names the pool. A combat skill needs a free one of the slots the level opens (`room`), a
// utility skill one of the three; the skill goes to the slot the line names if it is empty, else the first empty one (any slot holds either type).
function typedLearn(slots, learn, args, fields, room) {
    const type = args.type === 'utility' ? 'utility' : 'combat', cap = type === 'utility' ? UTILITY_SLOTS : room;
    const held = slots.filter(slot => slot.name && slot.type === type).length, empty = slots.filter(slot => !slot.name);
    if (held >= cap || !empty.length) {
        return { refuse: type === 'utility' ? fill(J.utilityFull, { skill: args.name, max: UTILITY_SLOTS })
            : `No free skill slot for ${args.name}. ${held >= SKILL_SLOTS_MAX ? J.slotsFull : fill(J.slotLater, { level: Math.max(0, held + 1 - SKILL_SLOTS_BASE) * SKILL_SLOTS_EVERY })}`, full: true };
    }
    const at = Number(learn[1]), free = empty.find(slot => slot.n === at) ?? empty[0];
    return { kind: `learn-${free.n}`, slot: free.n, name: args.name };
}
// How many skill slots a Skills block has open: the slots it has, as far as its character's level opens them (names.js skillSlots); a Skills block no Character names is read at level 1.
function skillRoom(state, definition, fields) {
    const capacity = Math.min(SKILL_SLOTS_MAX, Object.keys(definition.state ?? {}).filter(key => /^skill\d+$/u.test(key)).length);
    let level = 1;
    try { level = readSheet(state).characters.find(person => fold(person.who) === fold(fields.who))?.level ?? 1; } catch { level = 1; }
    return Math.min(capacity, skillSlots(level));
}
// The slots the character's level opens (names.js skillSlots), whatever the block has.
function skillWant(state, fields) {
    let level = 1;
    try { level = readSheet(state).characters.find(person => fold(person.who) === fold(fields.who))?.level ?? 1; } catch { level = 1; }
    return skillSlots(level);
}
// The additive upgrade of a Skills block made before the extra slots (five slots, no `sig`; templates.js grownSkills): when it is first needed (a learn line once the level
// has opened a slot the block lacks, or a cast member's skills to mark), the block's pin is replaced by the same definition with the missing slots and the mark added.
// Nothing is removed or renamed; the fields it adds start at their defaults and every existing skill keeps its rank and practice. It is part of the action that needed it:
// its ops carry the new pin and a Re-read plans it again from the same prefix, so rebuild, Re-read and reload all give the same block (the pack is not asked).
// → the new definition (the draft holds it), or null when nothing was missing.
function growSkills(ctx, prefix, draft, module) {
    const domain = prefix.domains.dataModules, old = domain?.active?.[module], current = activeDefinition(prefix, module);
    if (!old || !current || current.role !== 'skills' || current.pack !== 'chat' || domain.pins[old.hash]?.packId !== 'chat') return null;
    const grown = rpg().grownSkills(rawDefinition(current));
    if (!grown) return null;
    const catalog = Object.keys(domain.active).map(id => activeDefinition(prefix, id)).filter(Boolean);
    const checked = validateDataModules([grown], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'], definitions: catalog });
    if (!checked.ok) return null;
    const definition = checked.definitions[0], hash = dataModuleHash(definition);
    if (Object.keys(draft.pins).length >= L.pins + 1) return null;
    draft.pins[hash] = copy({ definition, packId: 'chat', packVersion: '0', packHash: null, interpreter: 1 });
    draft.active[module] = { ...copy(old), hash, generation: Math.max(ctx.rev, old.generation + 1) };
    const fields = atPath(draft, instancePath(module, 'chat')).fields;
    for (const [key, value] of Object.entries(dataModuleDefaults(definition.state))) if (!Object.hasOwn(fields, key)) fields[key] = value;
    if (old.hash !== hash && !Object.values(draft.active).some(entry => entry.hash === old.hash)) delete draft.pins[old.hash];
    return definition;
}

function createSkills() {
    return { skillCapacity, skillRow, skillNamed, words, skillRoute, skillRoom, skillWant, growSkills };
}

export { createSkills, skillCapacity, skillRow, skillNamed, words, skillRoute, skillRoom, skillWant, growSkills };
