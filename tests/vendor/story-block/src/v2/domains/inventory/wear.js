// The inventory domain's equipment and condition handlers (moved out of domains/inventory.js unchanged; inventory.js re-exports every public
// name): reading the party, wearing and mending a piece, equipping, stowing, restoring and releasing a stack, and the story's wear words.

import { OWNER_RE, capitalize, ownerNameIn, isPlainObject } from '../common.js';
import { stepDown, slotWordOf, GEAR, placeOf, stepUp } from '../gear.js';
import { COND_MAX, condOf, condWrite, RPG_MODULE, gearOn } from './state.js';
import { baseSlot } from './validate.js';
import { stackIn, refuseBound, ownerArg, boundName, addStack, stacksOf } from './stacks.js';

function readParty(ctx) {
    try {
        return ctx.read('party');
    } catch {
        return null;
    }
}

// ---------- equipment through the rules module ----------
//
export function joinNames(names) {
    return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Only another module's rules wear or mend a piece (a fight, a fall, a smith's work): `ctx.caller` must
// be set, whatever the cause. Amounts are clamped into 0…100, so a module's call never fails on a
// number that is merely too big (its whole action would fail with it).
function moduleOnly(ctx, what) {
    if (!ctx.caller) ctx.fail('REFUSED', `${what} comes from another module's rules, not from a button or a change line.`);
}

function amountArg(ctx, value, fallback, what) {
    const n = value === undefined || value === null ? fallback : value;
    if (!Number.isSafeInteger(n) || n < 0) ctx.fail('INVALID', `The ${what} must be a whole number of at least 0.`);
    return Math.min(COND_MAX, n);
}

// `inventory.wear { stack, amount }`: the condition goes down by `amount` (1…100), never below 0 (broken).
export function wear(ctx, payload) {
    moduleOnly(ctx, 'Wear');
    const inv = ctx.draft('inventory');
    const stack = stackIn(ctx, inv, payload.stack);
    const def = inv.defs[stack.def];
    const amount = amountArg(ctx, payload.amount, undefined, 'wear');
    if (amount < 1) ctx.fail('INVALID', 'The wear must be a whole number of at least 1.');
    const before = condOf(stack, inv);
    const now = condWrite(ctx, inv, stack, -amount);
    return {
        summary: before === 0 ? `${def.name} is already broken.` : now === 0 ? `${def.name} breaks.` : `${def.name} wears (${before} → ${now}).`,
        data: { stack: stack.id, def: def.id, amount, before, now, broken: now === 0 },
        narrate: false,
    };
}

// `gear.wear { owner, slot, steps }` (`story-block.gear`): the system's or another module's call (a fight's rules), never a button or a
// story line. `slot`: weapon, body (armour), off-hand (shield), or defence (the body armour, else the off-hand: what a decisive hit
// taken wears). The piece worn there goes down `steps` (1…3, default 1) condition words (good → worn → torn → broken) through the same
// condition events as `inventory.wear`; at 0 it is broken and gives no bonus (gearAnswer). Part 2: a decisive hit TAKEN wears the
// defender's `defence`, a decisive miss of the attacker wears their `weapon`.
const WEAR_SLOTS = Object.freeze({ weapon: 'weapon', body: 'body', armour: 'body', 'off-hand': 'off-hand', shield: 'off-hand', defence: 'defence' });
export function gearWear(ctx, payload) {
    // (a roll that carries a gear mark wears by it even if the switch is off now: `recorded`, and only the RPG's own `rpg.resolve` may say so: its nested call has
    // the Story Block module as `ctx.caller`; a pack event step (`event:<id>`), another module or a top-level call is refused the flag, whatever the switch says)
    if (payload.recorded === true && !(ctx.cause === 'system' && ctx.caller === RPG_MODULE)) ctx.fail('REFUSED', 'Only the fight\'s own rolls wear gear by their record.');
    if (!gearOn(ctx) && payload.recorded !== true) ctx.fail('REFUSED', 'Gear is not switched on.');
    if (!(ctx.cause === 'system' || ctx.caller)) ctx.fail('REFUSED', 'Gear wears from the rules of a fight, not from a button or a change line.');
    const owner = typeof payload.owner === 'string' && payload.owner ? payload.owner : 'party';
    if (!OWNER_RE.test(owner)) ctx.fail('INVALID', 'The owner is the party or a member.');
    const asked = typeof payload.slot === 'string' ? payload.slot.trim().toLowerCase() : '';
    if (!Object.hasOwn(WEAR_SLOTS, asked)) ctx.fail('INVALID', 'The slot is weapon, body, off-hand or defence.');
    const steps = payload.steps === undefined ? 1 : payload.steps;
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 3) ctx.fail('INVALID', 'The steps are a whole number from 1 to 3.');
    const inv = ctx.draft('inventory');
    const wornIn = place => Object.values(inv.stacks)
        .filter(other => other.owner === owner && other.equipped === place)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    const slot = WEAR_SLOTS[asked] === 'defence' ? (wornIn('body') ? 'body' : 'off-hand') : WEAR_SLOTS[asked];
    const stack = wornIn(slot);
    if (!stack) ctx.fail('NOT_FOUND', `${capitalize(ownerNameIn(ctx, owner))} wears nothing in the ${slot} slot.`);
    const def = inv.defs[stack.def];
    const before = condOf(stack, inv);
    const target = stepDown(before, steps);
    const amount = before - target;
    const now = amount > 0 ? condWrite(ctx, inv, stack, -amount) : before;
    return {
        summary: before === 0 ? `${def.name} is already broken.` : now === 0 ? `${def.name} breaks.` : `${def.name} wears (${before} → ${now}).`,
        data: { owner, slot, stack: stack.id, def: def.id, steps, amount, before, now, broken: now === 0 },
        narrate: false,
    };
}

// `item.equip { stack, owner?, slot }` (`story-block.gear`): one item per slot per owner. The reader's Edit and the gear UI use it; the item
// must be equipment that fits the slot (its own slot, or an accessory in either accessory place), and belong to `owner`.
export function itemEquip(ctx, payload) {
    if (!gearOn(ctx)) ctx.fail('REFUSED', 'Gear is not switched on.');
    let inv = ctx.draft('inventory');
    let stack = stackIn(ctx, inv, payload.stack);
    const def = inv.defs[stack.def];
    // (a bound piece is not handed to anyone else, and, once worn, not moved to another slot: inventory.equip says so for the slot)
    if (payload.owner !== undefined && payload.owner !== stack.owner) refuseBound(ctx, inv, stack);
    // `transfer: true` (the item Edit): hand it to `owner` first. It is one command, so a refusal below leaves it where it was (all or nothing).
    let handed = false;
    if (payload.owner !== undefined && payload.owner !== stack.owner && payload.transfer === true) {
        const moved = ctx.call('inventory.transfer', { stack: stack.id, to: payload.owner });
        inv = ctx.draft('inventory');
        stack = stackIn(ctx, inv, moved?.data?.stack ?? stack.id);
        handed = true;
    }
    if (payload.owner !== undefined && payload.owner !== stack.owner) ctx.fail('REFUSED', `${def.name} is not ${ownerNameIn(ctx, payload.owner)}'s.`);
    const named = slotWordOf(payload.slot ?? def.slot);
    if (!named) ctx.fail('INVALID', `The slot is one of ${GEAR.places.join(', ')}.`);
    const own = slotWordOf(def.slot);
    if (def.kind === 'equipment' && own && baseSlot(named) !== baseSlot(own) && !(own === 'accessory' && baseSlot(named) === 'accessory')) ctx.fail('REFUSED', `${def.name} does not fit the ${named} slot.`);
    const place = placeOf(named);
    // Accessories: either place, the first free one when none was named.
    let where = place;
    if (named === 'accessory') {
        const taken = key => Object.values(inv.stacks).some(other => other.owner === stack.owner && other.id !== stack.id && other.equipped === key);
        where = ['accessory-1', 'accessory-2'].find(key => !taken(key)) ?? 'accessory-1';
    }
    const out = ctx.call('inventory.equip', { stack: stack.id, slot: where });
    return { ...out, data: { ...(out.data ?? {}), owner: stack.owner, place: where, ...(handed ? { handed: true } : {}) } };
}

// `inventory.stow { owner }` (`story-block.gear`, a module's call: the party module's leave): the pieces bound to `owner` leave the inventory with
// them. They are set aside in `kept[owner]` (def, quantity, the slot they were worn in, note, condition as it stands: the events folded into one
// number, so what wear they took stays), and their condition events go with them. Nothing is lost: `inventory.restore` brings them back.
export function stow(ctx, payload) {
    // (only Story Block's own leave: a pack event, another module, a button or a change line is refused)
    if (ctx.caller !== RPG_MODULE) ctx.fail('REFUSED', 'Gear leaves with a member when they leave the party, not from a button, an event or another module.');
    const owner = ownerArg(ctx, payload.owner, undefined);
    if (owner === 'party') ctx.fail('INVALID', 'Only a party member\'s gear is bound to them.');
    // `module`: the member's block, kept with the pieces so they find their way back if the member is renamed while away
    const by = typeof payload.module === 'string' && payload.module && payload.module.length <= 120 ? payload.module : '';
    const inv = ctx.draft('inventory');
    const pieces = Object.values(inv.stacks).filter(stack => stack.owner === owner && stack.bound === owner)
        .sort((a, b) => (inv.defs[a.def]?.name ?? a.def).localeCompare(inv.defs[b.def]?.name ?? b.def, 'en') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!pieces.length) return { summary: `${boundName(ctx, owner)} has no bound gear.`, data: { owner, items: [], stacks: [] }, narrate: false };
    if (!isPlainObject(inv.kept)) inv.kept = {};
    const list = Array.isArray(inv.kept[owner]) ? inv.kept[owner] : [];
    const names = [];
    for (const stack of pieces) {
        const cond = condOf(stack, inv);
        list.push({ def: stack.def, qty: stack.qty, equipped: stack.equipped, note: stack.note, ...(by ? { by } : {}), ...(cond < COND_MAX ? { cond } : {}),
            ...(stack.key === true ? { key: true } : {}), ...(stack.story === true ? { story: true } : {}) });
        names.push(inv.defs[stack.def]?.name ?? stack.def);
        if (isPlainObject(inv.condLog)) delete inv.condLog[stack.id];
        delete inv.stacks[stack.id];
    }
    inv.kept[owner] = list;
    return { summary: `${boundName(ctx, owner)}'s gear leaves with them: ${names.join(', ')}.`, data: { owner, items: names, stacks: pieces.map(stack => stack.id) }, narrate: false };
}

// `inventory.restore { owner }` (`story-block.gear`, a module's call: the party module's return): what `inventory.stow` set aside comes back, once
// (the record is emptied), bound again, in the condition it left in, worn in the slot it was worn in when that slot is free (else carried).
export function restore(ctx, payload) {
    if (ctx.caller !== RPG_MODULE) ctx.fail('REFUSED', 'Gear comes back with a member when they return to the party, not from a button, an event or another module.');
    const owner = ownerArg(ctx, payload.owner, undefined);
    if (owner === 'party') ctx.fail('INVALID', 'Only a party member\'s gear is bound to them.');
    const inv = ctx.draft('inventory');
    const list = isPlainObject(inv.kept) && Array.isArray(inv.kept[owner]) ? inv.kept[owner] : [];
    const items = [];
    for (const entry of list) {
        const def = inv.defs[entry.def];
        if (!def) continue;
        const free = entry.equipped !== null && !Object.values(inv.stacks).some(other => other.owner === owner && other.equipped === entry.equipped);
        const id = addStack(ctx, inv, def.id, entry.qty, owner, entry.note, entry.key === true, entry.story === true);
        const stack = inv.stacks[id];
        stack.bound = owner;
        if (free) stack.equipped = entry.equipped;
        if (Number.isSafeInteger(entry.cond)) stack.cond = entry.cond;
        items.push({ def: def.id, name: def.name, stack: id, equipped: stack.equipped });
    }
    if (isPlainObject(inv.kept)) {
        delete inv.kept[owner];
        if (!Object.keys(inv.kept).length) delete inv.kept;
    }
    return { summary: items.length ? `${boundName(ctx, owner)}'s gear comes back: ${items.map(item => item.name).join(', ')}.` : `${boundName(ctx, owner)} has no gear to bring back.`,
        data: { owner, items: items.map(item => item.name), pieces: items }, narrate: false };
}

// `inventory.release { owner }` (a module's call: the party module's removal of a Character block): the member is gone, so nothing may stay filed under their actor (a block made
// later under the same name would inherit it). Their pieces go to the party's bag, taken off and no longer bound (plain items now, their condition kept), and what was set
// aside for them (`kept`) is given back to the bag the same way. Nothing is lost. No feature on it: it runs whatever the gear switch says.
export function release(ctx, payload) {
    if (ctx.caller !== RPG_MODULE) ctx.fail('REFUSED', 'A member\'s things go to the party\'s bag when their block is removed, not from a button, an event or another module.');
    const owner = ownerArg(ctx, payload.owner, undefined);
    if (owner === 'party') ctx.fail('INVALID', 'Only a party member\'s things can be released.');
    const inv = ctx.draft('inventory');
    const names = [];
    for (const stack of Object.values(inv.stacks).filter(item => item.owner === owner).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        stack.owner = 'party';
        stack.equipped = null;
        delete stack.bound;
        names.push(inv.defs[stack.def]?.name ?? stack.def);
    }
    const list = isPlainObject(inv.kept) && Array.isArray(inv.kept[owner]) ? inv.kept[owner] : [];
    for (const entry of list) {
        const def = inv.defs[entry.def];
        if (!def) continue;
        const id = addStack(ctx, inv, def.id, entry.qty, 'party', entry.note, entry.key === true, entry.story === true);
        if (Number.isSafeInteger(entry.cond)) inv.stacks[id].cond = entry.cond;
        names.push(def.name);
    }
    if (isPlainObject(inv.kept)) {
        delete inv.kept[owner];
        if (!Object.keys(inv.kept).length) delete inv.kept;
    }
    return { summary: names.length ? `${boundName(ctx, owner)}'s things go to the party's bag: ${names.join(', ')}.` : `${boundName(ctx, owner)} has nothing to release.`, data: { owner, items: names }, narrate: false };
}

// `inventory.repair { stack, amount }`: the condition goes up by `amount` (1…100), never above 100;
// as new (100), the field is dropped again.
export function repair(ctx, payload) {
    moduleOnly(ctx, 'Repair');
    const inv = ctx.draft('inventory');
    const stack = stackIn(ctx, inv, payload.stack);
    const def = inv.defs[stack.def];
    const amount = amountArg(ctx, payload.amount, undefined, 'repair');
    if (amount < 1) ctx.fail('INVALID', 'The repair must be a whole number of at least 1.');
    const before = condOf(stack, inv);
    const now = condWrite(ctx, inv, stack, amount);
    return {
        summary: now === before ? `${def.name} is already as good as new.` : `${def.name} is mended (${before} → ${now}).`,
        data: { stack: stack.id, def: def.id, amount, before, now },
        narrate: false,
    };
}

// The story's word for wear on a piece (`~ item Coat — torn by brambles | wear: scuff|tear|ruin`). With a
// module answering `item.wear` (a module's gear rules) the line goes
// there as `item.wear { name, wear, why, story: true }`; without one Story Block wears the stack itself
// by STORY_WEAR, once per piece per reply. The words and numbers are shared by the fallback, so
// both read a line the same way.
export const STORY_WEAR = Object.freeze({ scuff: 5, tear: 15, ruin: 40 });
const WEAR_WORDS = Object.freeze({
    scuff: 'scuff', scuffed: 'scuff', scratch: 'scuff', scratched: 'scuff', nick: 'scuff', nicked: 'scuff', dent: 'scuff', dented: 'scuff',
    tear: 'tear', torn: 'tear', tore: 'tear', rip: 'tear', ripped: 'tear', cut: 'tear', gash: 'tear', crack: 'tear', cracked: 'tear', burn: 'tear', burned: 'tear', burnt: 'tear',
    ruin: 'ruin', ruined: 'ruin', wreck: 'ruin', wrecked: 'ruin', smash: 'ruin', smashed: 'ruin', shatter: 'ruin', shattered: 'ruin', destroy: 'ruin', destroyed: 'ruin',
});

/** scuff | tear | ruin for a wear label's words, or null. */
export function wearWord(value) {
    const said = String(value ?? '').normalize('NFKC').toLowerCase().trim().split(/[^a-z]+/).filter(Boolean);
    for (const word of said) if (Object.hasOwn(WEAR_WORDS, word)) return WEAR_WORDS[word];
    return null;
}

export function storyWear(ctx, inv, def, written, why) {
    const word = wearWord(written);
    if (!word) ctx.fail('INVALID', 'Say how the piece suffered: wear: scuff, wear: tear or wear: ruin.');
    let out;
    try {
        out = ctx.call('item.wear', { name: def.name, wear: word, ...(why ? { why } : {}), story: true });
    } catch (error) {
        if (!(error?.code === 'UNKNOWN_COMMAND' && String(error.message).includes('item.wear'))) throw error;
        out = null;
    }
    if (out) return typeof out.summary === 'string' && out.summary ? out.summary : `${def.name}: ${word}.`;
    // Without a gear module: the piece worn, else the first lot (as `- item` takes them).
    const held = stacksOf(inv, def.id);
    const stack = held.find(other => other.equipped !== null) ?? held[0];
    if (!stack) ctx.fail('NOT_FOUND', `There is no ${def.name} in the inventory.`);
    const reply = ctx.carrier?.sid ?? ctx.receiptId ?? '';
    if (!ctx.claim(`wear:${reply}:${stack.id}`)) ctx.fail('CLAIMED', `${def.name} already took its wear in this reply.`);
    // With gear on a ruin breaks the piece in one step; scuff and tear are as they were.
    const now = condWrite(ctx, inv, stack, word === 'ruin' && gearOn(ctx) ? -COND_MAX : -STORY_WEAR[word]);
    return now === 0 ? `${def.name} is broken` : `${def.name} is ${{ scuff: 'scuffed', tear: 'damaged', ruin: 'badly damaged' }[word]} (${now}/100)`;
}

// The story's word for a repair (`~ item Cane Sword — the smith reground it | repair: mend|restore`), with the gear feature on: mend (mended,
// patched, fixed) is one condition word up, restore (restored, reforged, as new) is back to Good. It goes through the same condition
// events as `inventory.repair`, once per piece per reply; the coin for it stays the narrator's own `- coin` line.
const REPAIR_WORDS = Object.freeze({
    mend: 'mend', mended: 'mend', patch: 'mend', patched: 'mend', fix: 'mend', fixed: 'mend', repair: 'mend', repaired: 'mend', mending: 'mend',
    restore: 'restore', restored: 'restore', reforge: 'restore', reforged: 'restore', new: 'restore', renewed: 'restore',
});
export function storyRepair(ctx, inv, def, written) {
    const said = String(written ?? '').normalize('NFKC').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const word = said.map(item => REPAIR_WORDS[item]).find(Boolean);
    if (!word) ctx.fail('INVALID', 'Say how the piece was mended: repair: mend or repair: restore.');
    // The piece worn, else the most worn lot.
    const held = stacksOf(inv, def.id);
    const stack = held.find(other => other.equipped !== null) ?? [...held].sort((a, b) => condOf(a, inv) - condOf(b, inv))[0];
    if (!stack) ctx.fail('NOT_FOUND', `There is no ${def.name} in the inventory.`);
    const reply = ctx.carrier?.sid ?? ctx.receiptId ?? '';
    if (!ctx.claim(`repair:${reply}:${stack.id}`)) ctx.fail('CLAIMED', `${def.name} was already mended in this reply.`);
    const before = condOf(stack, inv);
    const target = stepUp(before, word === 'restore');
    if (target <= before) return `${def.name} is already as good as new`;
    const now = condWrite(ctx, inv, stack, target - before);
    return `${def.name} is ${word === 'restore' ? 'restored' : 'mended'} (${before} → ${now}/100)`;
}
