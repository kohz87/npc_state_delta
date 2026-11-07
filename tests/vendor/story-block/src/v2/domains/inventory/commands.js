// The inventory domain's commands (moved out of domains/inventory.js unchanged; inventory.js re-exports every public name): the command
// table and the guard of the commands that make something out of nothing. commands/wallet.js holds the purse commands and TOLD.

import { isPlainObject, capitalize, ownerNameIn, clone } from '../common.js';
import { cleanName, resolveDef, slugify, aliasKey } from '../names.js';
import { handDef, slotWordOf } from '../gear.js';
import { fill } from '../../strings.js';
import { RPG_MODULE, MAX_NOTE, gearOn, KINDS, RARITIES, MAX_UNSTACKED, condOf, COND_MAX, condWrite, nonBlank, isCount, FEATURE } from './state.js';
import { itemText, baseSlot } from './validate.js';
import {
    count, receiverArg, textArg, defineGiven, defineByName, addStack, grantInto, told, E, ownerArg, peekPackDef,
    stackIn, boundId, refuseBound, ambiguous, stacksOf, freeId, storeDef, unbound, shortOf, takeAcross,
    looseMatch, take,
} from './stacks.js';
import { wear, repair, gearWear, itemEquip, stow, restore, release } from './wear.js';
import { lootTake } from './loot.js';
import {
    byReader, handStats, handSlot, kitOpen, holdBudget, remakeAsEquipment, guardReaderEdit, addDecision,
    handPlace, handEdit, renameDecision, editStack, editPieces,
} from './edit.js';
import { readerCarry } from './lines.js';
import { TOLD, createWalletCommands } from './commands/wallet.js';
export { TOLD } from './commands/wallet.js';

// Commands that make something out of nothing (items, money) run for the story, the host, or another
// module's command (ctx.caller); a 'ui' command at the top is refused with `why`.
function byModule(ctx, why) {
    if (!(ctx.caller || ctx.cause === 'story' || ctx.cause === 'system')) ctx.fail('REFUSED', why);
}

/** The inventory commands; `env` = { hooks: name => fn[], settings: () => this module's settings }. */
export function createInventoryCommands(env) {
    return {
        // { def | defId | name, qty, owner, note? }: `def` is a def ID or a full def. Internal (§7):
        // the story, the host, or another module's command through ctx.call.
        'inventory.grant'(ctx, payload = {}) {
            byModule(ctx, 'Items cannot be handed out from a button; they come from the story or from another module.');
            if (payload.bound !== undefined && payload.bound !== false && ctx.caller !== RPG_MODULE) ctx.fail('REFUSED', 'Only Story Block\'s own join binds gear to a member.');
            const inv = ctx.draft('inventory');
            const qty = count(ctx, payload.qty, 1);
            const owner = receiverArg(ctx, payload.owner);
            const note = textArg(ctx, payload.note, MAX_NOTE, 'note');
            let def;
            let created = false;
            const wanted = payload.def ?? payload.defId;
            if (isPlainObject(wanted)) {
                ({ def, created } = defineGiven(ctx, inv, wanted, env, { note, owner }));
            } else if (wanted !== undefined) {
                def = typeof wanted === 'string' ? inv.defs[wanted] : null;
                if (!def) ctx.fail('NOT_FOUND', 'There is no such item to give.');
            } else if (payload.name !== undefined) {
                ({ def, created } = defineByName(ctx, inv, String(payload.name), env, { note, owner }));
            } else ctx.fail('INVALID', 'Say which item to give.');
            // `bound: true` (a cast member's signature gear, GEAR.md): kept as stacks of their own, marked as theirs.
            if (payload.bound !== undefined && typeof payload.bound !== 'boolean') ctx.fail('INVALID', 'bound must be true or false.');
            if (payload.bound === true && owner === 'party') ctx.fail('INVALID', 'Only a party member\'s gear can be bound to them.');
            const stacks = payload.bound === true
                ? (def.stack ? [addStack(ctx, inv, def.id, qty, owner, note)] : grantInto(ctx, inv, def, qty, owner, note))
                : grantInto(ctx, inv, def, qty, owner, note);
            if (payload.bound === true) for (const id of stacks) inv.stacks[id].bound = owner;
            return {
                summary: `${capitalize(ownerNameIn(ctx, owner))} gains ${itemText(def.name, qty)}.`,
                data: { def: def.id, qty, owner, stacks, created },
                narrate: told(ctx),
            };
        },

        // The reader's own item, resolved just like a story item but without the story's grant command.
        'inventory.add'(ctx, payload = {}) {
            byReader(ctx);
            const prefix = ctx.read('inventory');
            const inv = ctx.draft('inventory');
            if (typeof payload.name !== 'string') ctx.fail('INVALID', E.itemName);
            const name = cleanName(payload.name);
            if (!name || [...name].length > 60) ctx.fail('INVALID', E.itemNameLength);
            const qty = count(ctx, payload.qty, 1);
            // Hand-set gear (gear on): `slot`, `stats` ({ STR: 1 }) and `equip` (the owner who puts it on) join `kind` and `rarity`. The starting kit rule is held here.
            const gearWords = ['slot', 'stats', 'equip'].filter(key => payload[key] !== undefined && payload[key] !== null && payload[key] !== '' && !(key === 'stats' && isPlainObject(payload.stats) && !Object.keys(payload.stats).length));
            if (gearWords.length && !gearOn(ctx) && payload.starting !== true) ctx.fail('REFUSED', E.gearOff);
            const equipOn = gearWords.includes('equip') ? ownerArg(ctx, payload.equip) : null;
            const owner = receiverArg(ctx, equipOn ?? payload.owner);
            const note = textArg(ctx, payload.note, MAX_NOTE, 'note');
            // A saved character's things come with the kind and rarity the file kept; they apply only when the item is new to this chat.
            const keep = {};
            if (payload.kind !== undefined && payload.kind !== null) {
                if (!KINDS.includes(payload.kind)) ctx.fail('INVALID', fill(E.itemKind, { kinds: KINDS.join(', ') }));
                keep.kind = payload.kind;
            }
            if (payload.rarity !== undefined && payload.rarity !== null) {
                if (!RARITIES.includes(payload.rarity)) ctx.fail('INVALID', fill(E.itemRarity, { rarities: RARITIES.join(', ') }));
                keep.rarity = payload.rarity;
            }
            const gear = gearOn(ctx);
            const stats = handStats(ctx, payload.stats);
            const slot = handSlot(ctx, payload.slot);
            // The starting kit: Rarity above Common and a Bonus only while the chat is at its first message (an imported character's `starting: true` things are the file's own).
            const open = kitOpen(env);
            // A character file's things (`starting: true`) come as written only while the kit is open; later they come in as Common with no bonus, and the Problems list says so.
            let written = name;
            const imported = gear && payload.starting === true && !open;
            if (imported && (keep.rarity ?? 'common') !== 'common' || imported && (slot || Object.keys(stats).length)) {
                env.problem?.({ module: 'story-block', code: 'HELD', message: fill(E.importLate, { name }) });
                delete keep.rarity;
            }
            // After the kit a name that a story or pack piece already has never copies its rarity or bonus: the reader's own Common piece of it is made (named "Your …").
            if (gear && payload.starting !== true && !open) {
                const found = resolveDef(inv, name);
                const same = found.status === 'found' ? inv.defs[found.id] : null;
                if (same && !handDef(inv, same) && (same.kind === 'equipment' || same.rarity !== 'common')) {
                    written = `Your ${[...name].slice(0, 60 - 'Your '.length).join('')}`;
                    keep.kind ??= same.kind;
                    if (same.kind === 'equipment' && !slot && same.slot) keep.slot = baseSlot(same.slot);
                }
            }
            // The same for a pack piece not held yet: the `item.resolve` hooks are asked, and equipment or a piece above Common is never copied at the pack's words.
            if (gear && !open && written === name && resolveDef(inv, name).status === 'none') {
                const asked = peekPackDef(env, name);
                if (asked && (asked.kind === 'equipment' || (asked.rarity ?? 'common') !== 'common')) {
                    written = `Your ${[...name].slice(0, 60 - 'Your '.length).join('')}`;
                    if (payload.starting !== true) {
                        keep.kind ??= asked.kind;
                        if (asked.kind === 'equipment' && !slot && asked.slot) keep.slot = baseSlot(asked.slot);
                    }
                    delete keep.rarity;
                }
            }
            if (gear && payload.starting !== true && !open && ((keep.rarity ?? 'common') !== 'common' || Object.keys(stats).length)) ctx.fail('REFUSED', E.kitClosed);
            if (gear && payload.starting !== true && (gearWords.length || keep.kind !== undefined)) {
                holdBudget(ctx, keep.rarity ?? 'common', stats);
                if (keep.kind === 'equipment') {
                    // (the name's own guess of a slot gives way to the reader's choice, and the stats are theirs: none unless they picked some)
                    if (slot) keep.slot = baseSlot(slot);
                    keep.stats = stats;
                } else if (keep.kind !== undefined) {
                    Object.assign(keep, { slot: null, stats: {}, stack: true });
                }
            }
            // A saved character's piece the reader set by hand keeps its own slot and bonus (still held to the rarity's points); with gear off the words are left out.
            if (gear && payload.starting === true && open && keep.kind === 'equipment' && (slot || Object.keys(stats).length)) {
                holdBudget(ctx, keep.rarity ?? 'common', stats);
                if (slot) keep.slot = baseSlot(slot);
                if (Object.keys(stats).length) keep.stats = stats;
            }
            const { def, created } = defineByName(ctx, inv, written, env, { note, owner }, true, keep);
            // The reader's explicit Kind = Equipment wins over a definition of the reader's own that this name already reached (see `remakeAsEquipment`).
            if (gear && payload.starting !== true && !created && keep.kind === 'equipment' && written === name) remakeAsEquipment(ctx, inv, def, keep, slot);
            // Equipment with no place to be worn is refused here (the reader's Slot, else a slot word in the name, else the definition's own).
            if (gear && payload.starting !== true && keep.kind === 'equipment' && def.kind === 'equipment' && !def.slot) ctx.fail('REFUSED', fill(E.kitNoSlot, { name: def.name }));
            // (slot, bonus and putting on are for equipment: judged on the def the name means, which may be a pack's or the story's own)
            if (gear && payload.starting !== true && (slot || Object.keys(stats).length) && def.kind !== 'equipment') ctx.fail('INVALID', E.gearNeedsEquipment);
            if (created && gear && def.id.startsWith('story/')) inv.defs[def.id].hand = true;
            guardReaderEdit(ctx, 'inventory.add', null, null, { def: def.id, witness: addDecision(prefix, payload, def.id) });
            readerCarry(ctx, [{ defId: def.id, qty }], owner);
            const stacks = grantInto(ctx, inv, def, qty, owner, note);
            let worn = null;
            if (equipOn) {
                if (def.kind !== 'equipment') ctx.fail('REFUSED', fill(E.kitNotEquipment, { name: def.name }));
                const place = slot ?? slotWordOf(def.slot);
                if (!place) ctx.fail('REFUSED', E.kitNeedSlot);
                worn = ctx.call('item.equip', { stack: stacks[0], owner, slot: handPlace(inv, owner, stacks[0], place) });
            }
            return { summary: fill(E.itemAdded, { item: itemText(def.name, qty) }),
                data: { edit: true, def: def.id, qty, owner, stacks, created, ...(worn ? { place: worn.data?.place } : {}), told: payload.starting === true ? TOLD.startKit : TOLD.editKit }, narrate: true };
        },

        'inventory.edit'(ctx, payload = {}) {
            byReader(ctx);
            const inv = ctx.draft('inventory');
            const stack = stackIn(ctx, inv, payload.stack);
            const original = inv.defs[stack.def];
            // A bound piece keeps its name and count (the reader's own note on it is fine).
            if (boundId(ctx, stack)) {
                const group = payload.group === true && !original.stack ? Object.values(inv.stacks).filter(item => item.def === stack.def && item.owner === stack.owner).length : stack.qty;
                if ((typeof payload.name === 'string' && cleanName(payload.name) !== original.name) || (payload.qty !== undefined && payload.qty !== group)) refuseBound(ctx, inv, stack);
            }
            // The reader's own gear (gear on): kind, slot, rarity and bonus of a piece they added by hand.
            if (['kind', 'slot', 'rarity', 'stats'].some(key => payload[key] !== undefined)) handEdit(ctx, env, inv, stack, payload);
            const oldName = original.name;
            const decision = typeof payload.name === 'string' ? { witness: renameDecision(inv, stack, payload) } : null;
            let groupQty;
            // The screen counts separate pieces together without changing the one-piece stack invariant.
            if (payload.group === true && !original.stack && payload.qty !== undefined) {
                const qty = count(ctx, payload.qty, undefined);
                if (qty > MAX_UNSTACKED) ctx.fail('INVALID', fill(E.itemGroupLimit, { max: MAX_UNSTACKED }));
                const editPiece = payload.name !== undefined || payload.note !== undefined;
                const pieces = Object.values(inv.stacks).filter(item => item.def === stack.def && item.owner === stack.owner);
                guardReaderEdit(ctx, 'inventory.edit', editStack(stack), editPieces(inv, stack), decision);
                // If this edit also changes the selected piece, keep that piece when reducing the group.
                const loose = pieces.filter(item => item.equipped === null && !boundId(ctx, item) && (!editPiece || item.id !== stack.id)).reverse();
                const remove = pieces.length - qty;
                if (remove > loose.length) ctx.fail('REFUSED', E.itemGroupEquipped);
                if (remove > 0) for (const item of loose.slice(0, remove)) delete inv.stacks[item.id];
                if (remove < 0) {
                    readerCarry(ctx, [{ defId: original.id, qty: -remove }], stack.owner);
                    grantInto(ctx, inv, original, -remove, stack.owner, stack.note);
                }
                if (!editPiece) {
                    const remaining = Object.values(inv.stacks).find(item => item.def === original.id && item.owner === stack.owner);
                    return { summary: fill(E.itemSet, { detail: fill(E.itemCount, { name: original.name, qty }) }),
                        data: { edit: true, stack: remaining.id, told: TOLD.editKit }, narrate: true };
                }
                groupQty = qty;
            }
            if (groupQty === undefined) guardReaderEdit(ctx, 'inventory.edit', editStack(stack), null, decision);
            if (payload.qty !== undefined && groupQty === undefined) {
                const qty = count(ctx, payload.qty, undefined);
                // A non-stacking item is one stack per piece (the domain's invariant).
                if (!original.stack && qty !== 1) ctx.fail('REFUSED', fill(E.itemUnstackable, { name: original.name }));
                if (qty > stack.qty) readerCarry(ctx, [{ defId: original.id, qty: qty - stack.qty }], stack.owner);
                stack.qty = qty;
            }
            if (payload.note !== undefined) stack.note = textArg(ctx, payload.note, MAX_NOTE, 'note');
            let name = original.name;
            let resultStack = stack.id;
            if (payload.name !== undefined) {
                if (typeof payload.name !== 'string') ctx.fail('INVALID', E.itemName);
                name = cleanName(payload.name);
                if (!name || [...name].length > 60) ctx.fail('INVALID', E.itemNameLength);
                const found = resolveDef(inv, name);
                if (found.status === 'ambiguous') ctx.fail('INVALID', ambiguous(inv, name, found.ids));
                if (found.status === 'found' && found.id !== original.id) {
                    const targetDef = inv.defs[found.id];
                    const target = stacksOf(inv, found.id).find(other => targetDef.stack && stack.owner === other.owner
                        && stack.equipped === other.equipped && stack.note === other.note && condOf(stack, inv) === condOf(other, inv)
                        && (stack.key === true) === (other.key === true));
                    if (!target) ctx.fail('REFUSED', fill(E.itemCannotMerge, { name }));
                    if (!Number.isSafeInteger(target.qty + stack.qty)) ctx.fail('INVALID', E.itemQuantityLarge);
                    stack.def = targetDef.id;
                    ctx.call('inventory.merge', { stack: stack.id, into: target.id });
                    resultStack = target.id;
                    name = targetDef.name;
                } else if (name !== original.name) {
                    const shared = Object.values(inv.stacks).some(other => other.id !== stack.id && other.def === original.id);
                    if (shared || original.id.startsWith('pack.')) {
                        const id = freeId(inv, `story/${slugify(name)}`);
                        const copy = { ...clone(original), id, name };
                        delete copy.carry;
                        delete copy.bonus;
                        storeDef(inv, copy);
                        stack.def = id;
                    } else {
                        for (const [key, id] of Object.entries(inv.aliases)) if (id === original.id) delete inv.aliases[key];
                        original.name = name;
                        inv.aliases[aliasKey(name)] = original.id;
                    }
                }
            }
            const current = inv.stacks[resultStack];
            const detail = groupQty !== undefined && name !== oldName
                ? fill(E.itemGroupRenamed, { name: oldName, qty: groupQty, renamed: name })
                : payload.qty !== undefined ? fill(E.itemCount, { name, qty: groupQty ?? current.qty }) : payload.note !== undefined ? fill(E.itemNote, { name }) : name;
            return { summary: fill(E.itemSet, { detail }), data: { edit: true, stack: resultStack, told: TOLD.editKit }, narrate: true };
        },

        'inventory.consume'(ctx, payload = {}) {
            const inv = ctx.draft('inventory');
            const qty = count(ctx, payload.qty, 1);
            let def;
            let stacks;
            if (payload.stack !== undefined) {
                const stack = stackIn(ctx, inv, payload.stack);
                refuseBound(ctx, inv, stack);
                def = inv.defs[stack.def];
                stacks = [stack];
            } else if (payload.def !== undefined) {
                def = typeof payload.def === 'string' ? inv.defs[payload.def] : null;
                if (!def) ctx.fail('NOT_FOUND', 'There is no such item.');
                stacks = unbound(ctx, inv, stacksOf(inv, def.id, payload.owner === undefined ? null : ownerArg(ctx, payload.owner)));
            } else ctx.fail('INVALID', 'Say which item to use up.');
            const have = stacks.reduce((sum, stack) => sum + stack.qty, 0);
            if (have < qty) ctx.fail('NOT_ENOUGH', shortOf(def.name, have));
            takeAcross(inv, stacks, qty);
            return {
                summary: `${itemText(def.name, qty)} used up (${have - qty} left).`,
                data: { def: def.id, qty, left: have - qty, stacks: stacks.map(stack => stack.id) },
                narrate: told(ctx),
            };
        },

        'inventory.transfer'(ctx, payload = {}) {
            const inv = ctx.draft('inventory');
            const stack = stackIn(ctx, inv, payload.stack);
            refuseBound(ctx, inv, stack);
            const def = inv.defs[stack.def];
            if (payload.to === undefined || payload.to === null) ctx.fail('INVALID', 'Say who should get it.');
            const to = receiverArg(ctx, payload.to);
            const from = stack.owner;
            if (to === from) ctx.fail('REFUSED', `${def.name} is already with ${ownerNameIn(ctx, to)}.`);
            const qty = count(ctx, payload.qty, stack.qty);
            if (qty > stack.qty) ctx.fail('NOT_ENOUGH', shortOf(def.name, stack.qty));
            // The reader's hand-over (Give on the Inventory screen): only the taker's own load is checked.
            if (ctx.cause === 'ui') readerCarry(ctx, [{ defId: def.id, qty }], to, true);
            const cond = condOf(stack, inv);
            const target = def.stack && stack.key !== true ? looseMatch(inv, def.id, to, stack.note, null, cond) : null;
            const note = stack.note;
            let moved;
            if (qty === stack.qty && !target) {
                stack.owner = to;
                stack.equipped = null;
                moved = stack.id;
            } else {
                take(inv, stack, qty);
                if (target) {
                    target.qty += qty;
                    if (stack.story === true) target.story = true;
                    moved = target.id;
                } else {
                    moved = addStack(ctx, inv, def.id, qty, to, note, stack.key === true, stack.story === true);
                    if (cond < COND_MAX) condWrite(ctx, inv, inv.stacks[moved], cond - COND_MAX);
                }
            }
            return {
                summary: `${capitalize(ownerNameIn(ctx, from))} gives ${itemText(def.name, qty)} to ${ownerNameIn(ctx, to)}.`,
                data: { def: def.id, qty, from, to, stack: moved },
                narrate: told(ctx),
            };
        },

        'inventory.drop'(ctx, payload = {}) {
            const inv = ctx.draft('inventory');
            const stack = stackIn(ctx, inv, payload.stack);
            refuseBound(ctx, inv, stack);
            const def = inv.defs[stack.def];
            const qty = count(ctx, payload.qty, stack.qty);
            if (qty > stack.qty) ctx.fail('NOT_ENOUGH', shortOf(def.name, stack.qty));
            const owner = stack.owner;
            guardReaderEdit(ctx, 'inventory.drop', editStack(stack));
            take(inv, stack, qty);
            return {
                summary: `${capitalize(ownerNameIn(ctx, owner))} drops ${itemText(def.name, qty)}.`,
                data: { def: def.id, qty, owner, stack: stack.id, ...(ctx.cause === 'ui' ? { edit: true } : {}) },
                narrate: told(ctx),
            };
        },

        'inventory.equip'(ctx, payload = {}) {
            const inv = ctx.draft('inventory');
            const stack = stackIn(ctx, inv, payload.stack);
            const def = inv.defs[stack.def];
            if (def.kind !== 'equipment') ctx.fail('REFUSED', `${def.name} is not equipment; it cannot be worn or wielded.`);
            const slot = payload.slot ?? def.slot;
            if (!nonBlank(slot)) ctx.fail('REFUSED', `${def.name} has no slot to be worn in.`);
            const where = slot.trim();
            if (stack.equipped === where) ctx.fail('REFUSED', `${def.name} is already equipped.`);
            // (a bound piece worn in another slot stays there, and a bound piece in this slot is not put away)
            if (stack.equipped !== null) refuseBound(ctx, inv, stack);
            const occupant = Object.values(inv.stacks).find(other => other.id !== stack.id && other.owner === stack.owner && other.equipped === where);
            if (occupant) refuseBound(ctx, inv, occupant);
            if (occupant) occupant.equipped = null;
            stack.equipped = where;
            const away = occupant ? `, putting away ${inv.defs[occupant.def].name}` : '';
            return {
                summary: `${capitalize(ownerNameIn(ctx, stack.owner))} equips ${def.name} (${where})${away}.`,
                data: { stack: stack.id, def: def.id, slot: where, replaced: occupant?.id ?? null },
                narrate: told(ctx),
            };
        },

        'inventory.unequip'(ctx, payload = {}) {
            const inv = ctx.draft('inventory');
            const stack = stackIn(ctx, inv, payload.stack);
            refuseBound(ctx, inv, stack);
            const def = inv.defs[stack.def];
            if (stack.equipped === null) ctx.fail('REFUSED', `${def.name} is not equipped.`);
            const slot = stack.equipped;
            stack.equipped = null;
            return {
                summary: `${capitalize(ownerNameIn(ctx, stack.owner))} takes off ${def.name}.`,
                data: { stack: stack.id, def: def.id, slot },
                narrate: told(ctx),
            };
        },

        'inventory.split'(ctx, payload = {}) {
            const inv = ctx.draft('inventory');
            const stack = stackIn(ctx, inv, payload.stack);
            refuseBound(ctx, inv, stack);
            const def = inv.defs[stack.def];
            if (stack.qty < 2) ctx.fail('REFUSED', `There is only one ${def.name}; it cannot be split.`);
            const qty = payload.qty;
            if (!isCount(qty, 1) || qty >= stack.qty) ctx.fail('INVALID', `Split off between 1 and ${stack.qty - 1} ${def.name}.`);
            stack.qty -= qty;
            const made = addStack(ctx, inv, def.id, qty, stack.owner, stack.note, stack.key === true, stack.story === true);
            const cond = condOf(stack, inv);
            if (cond < COND_MAX) condWrite(ctx, inv, inv.stacks[made], cond - COND_MAX);
            return {
                summary: `${itemText(def.name, qty)} set apart from the rest.`,
                data: { stack: stack.id, made, qty },
                narrate: false,
            };
        },

        // Only alike stacks join: the same def, owner, equipped slot and note.
        'inventory.merge'(ctx, payload = {}) {
            const inv = ctx.draft('inventory');
            const stack = stackIn(ctx, inv, payload.stack);
            const into = stackIn(ctx, inv, payload.into);
            refuseBound(ctx, inv, stack);
            refuseBound(ctx, inv, into);
            const def = inv.defs[stack.def];
            if (stack.id === into.id) ctx.fail('INVALID', 'A stack cannot be put together with itself.');
            if (stack.def !== into.def) ctx.fail('REFUSED', `${def.name} and ${inv.defs[into.def].name} are different items.`);
            if (!def.stack) ctx.fail('REFUSED', `${def.name} does not stack.`);
            if (stack.owner !== into.owner) ctx.fail('REFUSED', `These ${def.name} are held by different owners.`);
            if (stack.equipped !== into.equipped) ctx.fail('REFUSED', `One ${def.name} is worn and the other is not.`);
            if (stack.note !== into.note) ctx.fail('REFUSED', `These ${def.name} have different notes.`);
            if (condOf(stack, inv) !== condOf(into, inv)) ctx.fail('REFUSED', `These ${def.name} are in different condition.`);
            if ((stack.key === true) !== (into.key === true)) ctx.fail('REFUSED', `One ${def.name} is a key item, kept apart from the rest.`);
            into.qty += stack.qty;
            if (stack.story === true) into.story = true;
            delete inv.stacks[stack.id];
            return {
                summary: `${def.name} put together (${into.qty}).`,
                data: { stack: stack.id, into: into.id, qty: into.qty },
                narrate: false,
            };
        },

        ...createWalletCommands(env, byModule),

        // { stack, amount }: gear condition down / up, for another module's rules only (ctx.caller).
        'inventory.wear': (ctx, payload = {}) => wear(ctx, payload),
        'inventory.repair': (ctx, payload = {}) => repair(ctx, payload),
        // { owner, slot, step }: the piece `owner` wears in `slot` (weapon | armour | shield) takes scuff | tear | ruin wear (part 2's fights).
        // (no feature on the command: a roll that carries a gear record wears by it with the switch off; gearWear itself refuses everyone else)
        'gear.wear': (ctx, payload = {}) => gearWear(ctx, payload),
        'item.equip': Object.assign((ctx, payload = {}) => itemEquip(ctx, payload), { feature: FEATURE.gear }),
        // { owner }: a member's bound pieces leave with them / come back with them (the party module's leave and join; GEAR.md "Signature gear").
        'inventory.stow': Object.assign((ctx, payload = {}) => stow(ctx, payload), { feature: FEATURE.gear }),
        // (no feature on restore: what was set aside always comes back, whatever the switch says when they return)
        'inventory.restore': (ctx, payload = {}) => restore(ctx, payload),
        // { owner }: a removed member's things go to the party's bag, plain (no feature: whatever the switch says).
        'inventory.release': (ctx, payload = {}) => release(ctx, payload),
        // { sid, pick: [index…] }: the reader takes what they picked of a reply's loot.
        'inventory.lootTake': Object.assign((ctx, payload = {}) => lootTake(ctx, payload, env), { feature: FEATURE.loot }),
    };
}
