// The `inventory` domain (§7): item definitions, stacks, wallets and the alias index, with
// its validator, commands, capture kinds `item` and `coin`, queries and prompt view. Pure.
//
// Handlers follow §3.2: synchronous, everything through ctx (read/draft/call/claim/rng/fail).
// A stack whose count reaches 0 is removed, never kept at 0 (§2.5). Numbers are set by code:
// a change line proposes, these functions decide. Payloads, codes and money follow MODULES.md F:
// a rule refusal is REFUSED, a malformed payload INVALID; a wallet is { coin: n } in the smallest unit.

import { OWNER_RE, isPlainObject, clone, labelOf, parseCount, newId, ownerNameIn, capitalize } from './common.js';
import { aliasKey, cleanName, resolveDef, slugify, trimText } from './names.js';
import { WALLET_KEY, coinValue, countedMoney, formatAmount, isCurrencyName, parseAmount, resolveCurrency } from './money.js';
import { DEF_ID, isId } from '../check.js';
import {
    GEAR, createGearQueries, gearDefine, gearSlotOf, handDef, itemCarryOf, packBonus, placeOf, slotWordOf,
    statsFor, statsOf, stepDown, stepUp,
} from './gear.js';
import { STRINGS, fill } from '../strings.js';
import {
    defErrors, isCount, nonBlank, COND_MAX, condLogErrors, keptErrors, gearOn, condOf, MAX_UNSTACKED, RARITIES,
    STORY_KIND, packCarry, MAX_NAME, defaultDef, condWrite, RPG_MODULE, featureOn, FEATURE, KINDS, MAX_NOTE,
    KIND_ORDER, CARRY_MAX, condEvents,
} from './inventory/state.js';
import { itemText, legendaryEarned, baseSlot, slotLimits, canWear, legendEarned } from './inventory/validate.js';
import { pack, WALLET_NOTE } from './inventory/prompt.js';
import {
    carryAnswer, definitionsOf, listItems, carryBonuses, gearIsOn, boundNames, equipmentView, encumbrance,
    defCarry, ENCUMBERED_PENALTY, gearWearers,
} from './inventory/queries.js';
export { DEFINITIONS_MAX_IDS, carryBonuses, listItems, equipmentView, ENCUMBERED_PENALTY, defCarry, ENCUMBERED_STATS, encumbrance, encumbranceTail, definitionsOf } from './inventory/queries.js';
export { KINDS, RARITIES, KIND_ORDER, initialInventory, FEATURE, INVENTORY_FEATURES, gearOn, featureOn, COND_MAX, COND_LOG_MAX, condEvents, condOf, defaultDef, CARRY_MAX, packCarry } from './inventory/state.js';
export { itemText, legendEarned, MANY_SLOTS, MAX_MANY, baseSlot, slotLimits, canWear } from './inventory/validate.js';
export { promptNote, WALLET_NOTE, inventoryTail } from './inventory/prompt.js';

const E = STRINGS.editMessages;

export function validateInventory(slice) {
    if (!isPlainObject(slice)) return ['The inventory is not a record.'];
    const parts = ['defs', 'stacks', 'wallets', 'aliases'].filter(part => !isPlainObject(slice[part]));
    if (parts.length) return parts.map(part => `The inventory has no ${part} record.`);
    const { defs, stacks, wallets, aliases } = slice;
    const errors = [];
    for (const [key, def] of Object.entries(defs)) errors.push(...defErrors(key, def));
    const worn = new Set();
    for (const [key, stack] of Object.entries(stacks)) {
        if (!isPlainObject(stack)) {
            errors.push(`Item stack ${key} is not a record.`);
            continue;
        }
        const def = isPlainObject(defs[stack.def]) ? defs[stack.def] : null;
        const label = def?.name ?? key;
        if (stack.id !== key) errors.push(`Item stack ${key} is filed under the wrong ID.`);
        if (!isId(key, 'it')) errors.push(`"${key}" is not a well-formed item stack ID.`);
        if (!def) errors.push(`Item stack ${key} refers to an item definition that does not exist (${stack.def}).`);
        if (!isCount(stack.qty, 1)) errors.push(`${label} has quantity ${stack.qty}; a stack holds a whole number of at least 1 (an empty stack is removed).`);
        else if (def && def.stack === false && stack.qty !== 1) errors.push(`${label} does not stack, so each one is its own stack of 1.`);
        if (typeof stack.owner !== 'string' || !OWNER_RE.test(stack.owner)) errors.push(`${label} has an owner that is neither the party nor an actor ID.`);
        if (stack.equipped !== null) {
            if (!nonBlank(stack.equipped)) errors.push(`${label} has an equipped slot that is neither empty nor a name.`);
            else {
                if (def && def.kind !== 'equipment') errors.push(`${label} is worn in "${stack.equipped}" but is not equipment.`);
                const place = `${stack.owner}\u0000${stack.equipped}`;
                if (worn.has(place)) errors.push(`Two items are worn in the same slot "${stack.equipped}" by the same owner.`);
                worn.add(place);
            }
        }
        if (typeof stack.note !== 'string') errors.push(`${label} has a note that is not text.`);
        if (typeof stack.from !== 'string') errors.push(`${label} has an origin that is not a receipt ID.`);
        if (stack.cond !== undefined && !(Number.isSafeInteger(stack.cond) && stack.cond >= 0 && stack.cond <= COND_MAX)) {
            errors.push(`${label} has a condition of ${stack.cond}; it is a whole number from 0 to ${COND_MAX}.`);
        }
        if (stack.key !== undefined && stack.key !== true) errors.push(`${label} is marked as a key item with something other than true.`);
        if (stack.story !== undefined && stack.story !== true) errors.push(`${label} is marked as the story's with something other than true.`);
        if (stack.bound !== undefined && !(typeof stack.bound === 'string' && stack.bound !== 'party' && OWNER_RE.test(stack.bound))) errors.push(`${label} is bound to something that is not a party member's ID.`);
    }
    for (const [owner, wallet] of Object.entries(wallets)) {
        if (!OWNER_RE.test(owner)) errors.push(`A wallet belongs to "${owner}", who is neither the party nor an actor ID.`);
        if (!isPlainObject(wallet)) {
            errors.push(`The wallet of ${owner} is not a record.`);
            continue;
        }
        for (const [key, amount] of Object.entries(wallet)) {
            if (key !== WALLET_KEY) errors.push(`The wallet of ${owner} holds "${key}"; a wallet keeps one amount, under ${WALLET_KEY}.`);
            else if (!isCount(amount, 0)) errors.push(`The wallet of ${owner} holds ${amount}; money is a whole number of at least 0.`);
        }
    }
    for (const [key, id] of Object.entries(aliases)) {
        if (!key || key !== key.trim().toLowerCase()) errors.push(`The item name "${key}" is not written in lowercase.`);
        if (!isPlainObject(defs[id])) errors.push(`The item name "${key}" points to a definition that does not exist (${id}).`);
    }
    if (slice.loot !== undefined) errors.push(...lootErrors(slice.loot));
    if (slice.condLog !== undefined) errors.push(...condLogErrors(slice.condLog));
    if (slice.kept !== undefined) errors.push(...keptErrors(slice.kept));
    return errors;
}

// ---------- shared pieces of the handlers ----------

const told = ctx => ctx.cause !== 'story';

// The chat's currency comes from the reader's settings or the pack.
const currencyIn = ctx => resolveCurrency(ctx.settings());
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Taking from several stacks of one item: loose ones before worn ones, the party's first, then by ID.
const takeOrder = (a, b) => (a.equipped === null ? 0 : 1) - (b.equipped === null ? 0 : 1)
    || (a.owner === 'party' ? 0 : 1) - (b.owner === 'party' ? 0 : 1) || byId(a, b);

function stackIn(ctx, inv, id) {
    const stack = typeof id === 'string' ? inv.stacks[id] : null;
    if (!stack) ctx.fail('NOT_FOUND', 'That item is no longer in the inventory.');
    return stack;
}

// ---------- bound signature gear (`story-block.gear`, GEAR.md "Signature gear") ----------
//
// A cast member's signature pieces, granted on join, carry `bound: <actor id>`: they stay with that member. With the switch on, no command moves,
// unequips, sells, drops, uses up, edits, splits or merges such a stack ("Bound to Mara: Cane Sword stays with them."); wear and repair are the
// condition's and go on as ever. Switched off, the mark is only kept: every command acts as in 2.17.0.

/** The member a stack is bound to, or null (not bound, or the gear switch is off). */
const boundId = (ctx, stack) => (typeof stack?.bound === 'string' && stack.bound && gearOn(ctx) ? stack.bound : null);

// (the name by the party module's roster, else the party domain, else the ID)
function boundName(ctx, id) {
    try {
        const actors = ctx.query('party.actors');
        const found = (Array.isArray(actors) ? actors : []).find(entry => entry?.id === id && typeof entry.name === 'string' && entry.name.trim());
        if (found) return found.name.trim();
    } catch { /* no roster: the party domain's name */ }
    return ownerNameIn(ctx, id);
}

/** Refuses (REFUSED, "Bound to Mara: Cane Sword stays with them.") when `stack` is bound; nothing otherwise. */
function refuseBound(ctx, inv, stack) {
    const id = boundId(ctx, stack);
    if (id) ctx.fail('REFUSED', fill(E.bound, { name: boundName(ctx, id), item: inv.defs[stack.def]?.name ?? 'That piece' }));
}

/** `stacks` without the bound ones; refuses when it held some and every one of them is bound. */
function unbound(ctx, inv, stacks) {
    const free = stacks.filter(stack => !boundId(ctx, stack));
    if (stacks.length && !free.length) refuseBound(ctx, inv, stacks[0]);
    return free;
}

function count(ctx, value, fallback, what = 'quantity') {
    const n = value === undefined || value === null ? fallback : value;
    if (!isCount(n, 1)) ctx.fail('INVALID', `The ${what} must be a whole number of at least 1.`);
    return n;
}

function ownerArg(ctx, value, fallback = 'party') {
    const owner = value === undefined || value === null ? fallback : value;
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) ctx.fail('INVALID', 'Items and coins belong to the party or to one of its people.');
    return owner;
}

// An actor who can hold things now (B3-7): the party, or a member the party module lists
// (`party.actors` when a module answers it, else the `party` domain's actors). An `ac_` id nobody
// has is refused, so nothing is handed to someone who is not there.
function ownerKnown(ctx, owner) {
    if (owner === 'party') return true;
    try {
        const list = ctx.query('party.actors');
        if (Array.isArray(list)) return list.some(actor => actor?.id === owner);
    } catch { /* no module answers party.actors: the domain, if there is one */ }
    let party = null;
    try { party = ctx.read('party'); } catch { party = null; }
    return isPlainObject(party?.actors) && Object.hasOwn(party.actors, owner);
}

function receiverArg(ctx, value, fallback = 'party') {
    const owner = ownerArg(ctx, value, fallback);
    if (!ownerKnown(ctx, owner)) ctx.fail('REFUSED', `${owner} is not in the party, so nothing can be given to them.`);
    return owner;
}

function textArg(ctx, value, max, what) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') ctx.fail('INVALID', `The ${what} must be text.`);
    return trimText(value, max);
}

function shortOf(name, have) {
    return have === 0 ? `There is no ${name} left.` : `There is only ${itemText(name, have)} left.`;
}

function stacksOf(inv, defId, owner = null) {
    return Object.values(inv.stacks).filter(stack => stack.def === defId && (owner === null || stack.owner === owner)).sort(takeOrder);
}

function take(inv, stack, qty) {
    stack.qty -= qty;
    if (stack.qty === 0) delete inv.stacks[stack.id];
}

function takeAcross(inv, stacks, qty) {
    let left = qty;
    for (const stack of stacks) {
        const n = Math.min(left, stack.qty);
        take(inv, stack, n);
        left -= n;
        if (!left) break;
    }
}

// A key item (`key: true` on its stack): a stack kept apart from the rest of that item (an older chat's
// notable gift from the story, which the story no longer needs). It is used, worn, given and consumed like any other, but it has no cash value: a module
// that buys things back or counts what they are worth (for trade or crafting) counts it as 0.
// It never joins another stack, nor another stack it (looseMatch, inventory.merge), and the part of it
// that is given away or split off stays a key stack.
// The story's own (`story: true` on its stack, B-a2-2): what a story line (`+ item`) gave, or the reader
// took from a story's loot (`? loot`, inventory.lootTake, FB-2), whatever its def (a pack's item named in
// the story too). inventory.grant never sets it: no story line reaches it (modules and pack events call it
// with what their code chose) and it moves no stack. A
// module that buys things back holds what it pays for it to its worth at the sell rate (the module's
// trade). It stacks with the rest of that item; a stack it joins, or that joins it, is the story's too,
// and the part of it that is given away or split off stays the story's.
function addStack(ctx, inv, def, qty, owner, note, key = false, story = false) {
    const id = newId(ctx, 'it', taken => Boolean(inv.stacks[taken]));
    inv.stacks[id] = { id, def, qty, owner, equipped: null, note, from: typeof ctx.receiptId === 'string' ? ctx.receiptId : '', ...(key ? { key: true } : {}), ...(story ? { story: true } : {}) };
    return id;
}

// A loose stack to add to: the same def, owner and note, not worn, in the same condition (`cond`).
function looseMatch(inv, def, owner, note, except = null, cond = COND_MAX) {
    return Object.values(inv.stacks).sort(byId)
        .find(stack => stack.id !== except && stack.def === def && stack.owner === owner && stack.equipped === null && stack.note === note && condOf(stack, inv) === cond && stack.key !== true && stack.bound === undefined) ?? null;
}

/**
 * Puts `qty` of a def with an owner: onto a matching loose stack when it stacks, else new stacks (a key
 * item always its own). `story`: a story line gave it (addStack), and a stack it joins is the story's.
 */
function grantInto(ctx, inv, def, qty, owner, note, key = false, story = false) {
    if (key) {
        if (def.stack) return [addStack(ctx, inv, def.id, qty, owner, note, true, story)];
        if (qty > MAX_UNSTACKED) ctx.fail('INVALID', `${def.name} does not stack; at most ${MAX_UNSTACKED} can be given at once.`);
        return Array.from({ length: qty }, () => addStack(ctx, inv, def.id, 1, owner, note, true, story));
    }
    if (def.stack) {
        const same = looseMatch(inv, def.id, owner, note);
        if (same) {
            same.qty += qty;
            if (story) same.story = true;
            return [same.id];
        }
        return [addStack(ctx, inv, def.id, qty, owner, note, false, story)];
    }
    if (qty > MAX_UNSTACKED) ctx.fail('INVALID', `${def.name} does not stack; at most ${MAX_UNSTACKED} can be given at once.`);
    return Array.from({ length: qty }, () => addStack(ctx, inv, def.id, 1, owner, note, false, story));
}

function ambiguous(inv, name, ids) {
    const names = ids.map(id => `${inv.defs[id].name} (${id})`);
    return `"${name}" could mean ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}; the line needs the exact name.`;
}

/** The def a name means, which must exist and be unambiguous. */
function knownDef(ctx, inv, name) {
    const found = resolveDef(inv, name);
    if (found.status === 'ambiguous') ctx.fail('INVALID', ambiguous(inv, name, found.ids));
    if (found.status === 'none') ctx.fail('NOT_FOUND', `There is no ${name} in the inventory.`);
    return inv.defs[found.id];
}

const freeId = (inv, base) => {
    let id = base;
    for (let n = 2; inv.defs[id]; n += 1) id = `${base}-${n}`;
    return id;
};

// The most a pack's place allows the story's items to be (`loot: { maxRarity }` on the place the party is at, by name or alias), or null.
function placeCeiling(ctx) {
    try {
        const here = ctx.read('scene')?.place?.name;
        if (typeof here !== 'string' || !here.trim()) return null;
        const places = ctx.query('packs.content', { kind: 'places' });
        const key = aliasKey(here);
        const place = (Array.isArray(places) ? places : []).find(entry => [entry?.name, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])].some(other => typeof other === 'string' && aliasKey(other) === key));
        const top = place?.loot?.maxRarity;
        return RARITIES.includes(top) ? top : null;
    } catch { return null; }
}

// A new def through the `item.define(def, { note, owner })` hooks (each may mutate the def or
// return fields to merge), then stored with its name as an alias. `keep` = fields the caller set
// that the hooks may not change; the ID is never theirs to change, and equipment never stacks.
// A hook that throws leaves the def as it was before that hook and goes to the Problems list: one
// module's bug never stops the item being gained.
// The money scale the item.define hooks price a new thing with (MODULES §F104): the reader's, else the pack's, else 1.
function hookScale(env) {
    try {
        return economyOf(env.settings?.(), typeof env.economy === 'function' ? env.economy() : null).scale;
    } catch {
        return 1;
    }
}

function buildDef(def, env, about, keep = {}) {
    const id = def.id;
    // While gear is on, the kind word of a story line (`+ item Healing Draught | kind: consumable`): a new plain item takes the inventory kind it names (consumable, material, quest);
    // a gear word (weapon, cloak, ...) is not one and is read by the gear step below.
    const saidKind = STORY_KIND[String(about.words?.kind ?? '').normalize('NFKC').toLowerCase().trim().split(/[^a-z]+/).find(word => Object.hasOwn(STORY_KIND, word))];
    if (about.gear === true && saidKind && def.kind === 'goods') def.kind = saidKind;   // (only with gear on: gear off builds the def exactly as 2.17.0 did)
    // Gear (`story-block.gear`): the slot and rarity the line's words and the name give, before the modules' hooks.
    if (about.gear === true) {
        gearDefine(def, about.words ?? {}, {
            allowLegendary: about.legendary === true, ceiling: about.ceiling ?? null,
            onHeld: (wanted, given) => env.problem?.({ module: 'story-block', code: 'HELD', message: `${def.name} was written ${wanted}; the story's items reach ${given} here${about.legendary === true ? '' : ' (legendary needs a quest completed or a hard fight won in the same reply)'}.` }),
        });
    }
    const hooks = env.hookEntries?.('item.define') ?? env.hooks('item.define').map(fn => ({ moduleId: null, fn }));
    for (const { moduleId, fn } of hooks) {
        const before = clone(def);
        try {
            const out = fn(def, { note: about.note ?? '', owner: about.owner ?? 'party', scale: hookScale(env) });
            if (isPlainObject(out) && out !== def) Object.assign(def, out);
        } catch (error) {
            for (const key of Object.keys(def)) delete def[key];
            Object.assign(def, before);
            env.problem?.({ module: moduleId, code: 'FAILED', message: `item.define failed on "${def.name}": ${error?.message ?? error}. The item keeps the rules it had before.` });
        }
    }
    Object.assign(def, keep, { id });
    // A carry capacity only a pack's def keeps (whatever a hook wrote): the story never sets one.
    const carry = packCarry(id, def.carry);
    if (carry === null) delete def.carry;
    else def.carry = carry;
    // A gear bonus only a pack's def keeps, as for carry: the story never sets one.
    const bonus = packBonus(id, def.bonus);
    if (bonus === null) delete def.bonus;
    else def.bonus = bonus;
    // With gear on, a cart, barrow, wagon or sledge the story names adds the capacity of its kind (gear.js KIND_CARRY) while it is owned.
    if (about.gear === true && itemCarryOf(def.name)) def.carry = itemCarryOf(def.name);
    if (def.kind === 'equipment') def.stack = false;   // MODULES.md F6
    return def;
}

function addDef(inv, def, env, about, keep = {}) {
    buildDef(def, env, about, keep);
    inv.defs[def.id] = clone(def);
    inv.aliases[aliasKey(def.name)] ??= def.id;
    return inv.defs[def.id];
}

// Store a new definition, with generic item hooks when appropriate.
function registerNew(ctx, inv, def, env, about, { keep = {}, hooks = true } = {}) {
    return hooks ? addDef(inv, def, env, gearOn(ctx) ? { ...about, gear: true, legendary: legendaryEarned(ctx), ceiling: placeCeiling(ctx) } : about, keep) : storeDef(inv, def);
}

// A def stored as it is (its hooks, if any, have run).
function storeDef(inv, def) {
    inv.defs[def.id] = clone(def);
    inv.aliases[aliasKey(def.name)] ??= def.id;
    return inv.defs[def.id];
}

/**
 * The def a name means, created as `story/<slug>` with the §7 defaults when there is none. `keep` (a reader's add may give a kind and a
 * rarity) are fields a def made here keeps whatever the `item.define` hooks say; a def that already exists, or a pack's, is not changed by it.
 */
function defineByName(ctx, inv, written, env, about = {}, route = true, keep = {}) {
    const name = cleanName(written);
    if (!name || name.length > MAX_NAME) ctx.fail('INVALID', `An item needs a name of 1 to ${MAX_NAME} characters.`);
    const found = resolveDef(inv, name);
    if (found.status === 'ambiguous') ctx.fail('INVALID', ambiguous(inv, name, found.ids));
    if (found.status === 'found') return { def: inv.defs[found.id], created: false };
    const packed = packDef(ctx, inv, name, env, route);
    if (packed) return packed;
    const def = defaultDef(freeId(inv, `story/${slugify(name)}`), name);
    return { def: registerNew(ctx, inv, def, env, about, { route, written: name, keep }), created: true };
}

// The `item.resolve(name)` hooks (packs, MODULES §E): a pack's def for a name the inventory does
// not know yet, taken as the pack wrote it (its numbers are the rules; item.define does not run),
// with the written name kept as an alias. The first hook that answers wins.
function peekPackDef(env, name) {
    for (const hook of env.hooks('item.resolve')) {
        let found;
        try { found = hook(name); } catch { found = null; }
        if (isPlainObject(found) && typeof found.id === 'string' && DEF_ID.test(found.id) && cleanName(found.name)) return found;
    }
    return null;
}

function packDef(ctx, inv, name, env, route = true) {
    for (const hook of env.hooks('item.resolve')) {
        let found;
        try { found = hook(name); } catch { found = null; }
        if (!isPlainObject(found) || typeof found.id !== 'string' || !DEF_ID.test(found.id) || !cleanName(found.name)) continue;
        const known = inv.defs[found.id];
        const def = known ?? defaultDef(found.id, cleanName(found.name));
        if (!known) {
            for (const field of Object.keys(def)) if (field !== 'id' && found[field] !== undefined && found[field] !== null) def[field] = clone(found[field]);
            const carry = packCarry(def.id, found.carry);
            if (carry !== null) def.carry = carry;
            const bonus = packBonus(def.id, found.bonus);
            if (bonus !== null) def.bonus = bonus;
            if (def.kind === 'equipment') def.stack = false;   // MODULES.md F6
            registerNew(ctx, inv, def, env, {}, { route, hooks: false, template: def.id });
        }
        inv.aliases[aliasKey(name)] ??= def.id;
        return { def: inv.defs[def.id], created: !known };
    }
    return null;
}

/**
 * A full def handed to inventory.grant (MODULES.md F5): an existing def with that ID wins;
 * otherwise it is added (defaults for missing fields, `story/<slug>` when it has no ID) and passed
 * through the hooks, keeping the caller's own rarity and value.
 */
function defineGiven(ctx, inv, given, env, about) {
    if (typeof given.id === 'string' && inv.defs[given.id]) {
        return { def: inv.defs[given.id], created: false };
    }
    const name = cleanName(given.name);
    if (!name || name.length > MAX_NAME) ctx.fail('INVALID', `An item needs a name of 1 to ${MAX_NAME} characters.`);
    if (given.id !== undefined && (typeof given.id !== 'string' || !DEF_ID.test(given.id))) {
        ctx.fail('INVALID', `"${given.id}" is not a well-formed item definition ID (namespace/slug).`);
    }
    const id = given.id ?? freeId(inv, `story/${slugify(name)}`);
    const def = defaultDef(id, name);
    for (const field of Object.keys(def)) if (field !== 'id' && field !== 'name' && given[field] !== undefined) def[field] = clone(given[field]);
    const keep = {};
    for (const field of ['rarity', 'value']) if (given[field] !== undefined) keep[field] = given[field];
    // A pack item's carry capacity comes with it (a pack shop's stock bought through a module).
    if (packCarry(id, given.carry) !== null) keep.carry = given.carry;
    if (packBonus(id, given.bonus) !== null) keep.bonus = given.bonus;
    return { def: registerNew(ctx, inv, def, env, about, { keep, written: name }), created: true };
}

function receive(ctx, env, { owner, amount, note }) {
    const inv = ctx.draft('inventory');
    const currency = currencyIn(ctx);
    const wallet = (inv.wallets[owner] ??= {});
    const now = (wallet[WALLET_KEY] ?? 0) + amount;
    if (!Number.isSafeInteger(now)) ctx.fail('INVALID', 'That is more money than can be counted.');
    wallet[WALLET_KEY] = now;
    const who = capitalize(ownerNameIn(ctx, owner));
    return {
        summary: `${who} receives ${formatAmount(amount, currency)}${note ? ` — ${note}` : ''} (now ${formatAmount(now, currency)}).`,
        data: { owner, amount, now, note },
        narrate: told(ctx),
    };
}

function pay(ctx, env, { owner, amount, note }) {
    const inv = ctx.draft('inventory');
    const currency = currencyIn(ctx);
    const have = inv.wallets[owner]?.[WALLET_KEY] ?? 0;
    const who = capitalize(ownerNameIn(ctx, owner));
    if (have < amount) ctx.fail('NOT_ENOUGH', `${who} has only ${formatAmount(have, currency)}; ${formatAmount(amount, currency)} is needed.`);
    inv.wallets[owner][WALLET_KEY] = have - amount;
    return {
        summary: `${who} pays ${formatAmount(amount, currency)}${note ? ` — ${note}` : ''} (${formatAmount(have - amount, currency)} left).`,
        data: { owner, amount, now: have - amount, note },
        narrate: told(ctx),
    };
}

// ---------- equipment: who can wear what ----------

function readParty(ctx) {
    try {
        return ctx.read('party');
    } catch {
        return null;
    }
}

// ---------- equipment through the rules module ----------
//
function joinNames(names) {
    return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---------- gear condition (`cond`) ----------

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
function wear(ctx, payload) {
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
function gearWear(ctx, payload) {
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
function itemEquip(ctx, payload) {
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
function stow(ctx, payload) {
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
function restore(ctx, payload) {
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
function release(ctx, payload) {
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
function repair(ctx, payload) {
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

function storyWear(ctx, inv, def, written, why) {
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
function storyRepair(ctx, inv, def, written) {
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

// ---------- loot to pick from (`story-block.loot`) ----------

// `? loot Rusty Key, Lantern Oil x2, Torn Map — on the cellar shelf | qty: 1`: what lies there, offered
// on the reply's card as chips; the reader takes the ones they want (inventory.lootTake). The offer is
// read as a `+ item` line would be, so the chips show what can be taken; things the party already carries (tolerant
// names) are left out. One offer per reply, keyed by the reply's record ID (`loot[<sid>]`, scratch like
// perReply); a second loot line in the reply adds to it. A reply keeps the LOOT_KEEP newest offers.
export const LOOT_ITEMS = 8;
export const LOOT_KEEP = 5;
// The guards of the loot blocks (Story Block's own, asked through the core module's replayGuard): a take's (lootTakeGuard),
// and the offer's, reply-bound, so it holds while its reply is in the chat (asked, it only checks its own shape).
export const LOOT_GUARD = 'loot.take';
export const LOOT_OFFER = 'loot.offer';
export const LOOT_KINDS = Object.freeze([LOOT_OFFER, LOOT_GUARD]);
const LOOT_OWNER = 'story-block';
const MAX_WHERE = 120;

function lootErrors(loot) {
    if (!isPlainObject(loot)) return ['The loot on offer is not a record.'];
    const errors = [];
    for (const [key, offer] of Object.entries(loot)) {
        if (!isPlainObject(offer)) {
            errors.push(`The loot of reply ${key} is not a record.`);
            continue;
        }
        if (offer.sid !== key) errors.push(`The loot of reply ${key} is filed under the wrong reply.`);
        if (typeof offer.where !== 'string' || typeof offer.claim !== 'string' || !Number.isSafeInteger(offer.n)) errors.push(`The loot of reply ${key} is missing where it lies, its claim or its order.`);
        const list = lootItems(offer);
        if (!list || !list.length || list.length > LOOT_ITEMS
            || list.some(item => !isPlainObject(item) || !nonBlank(item.name) || item.name.length > MAX_NAME || !isCount(item.qty, 1)
                || (item.coin !== undefined && !isCount(item.coin, 1)))) {
            errors.push(`The loot of reply ${key} needs 1 to ${LOOT_ITEMS} things, each with a name and a positive quantity.`);
        }
    }
    return errors;
}

// An offer's things in order, or null when they are not kept as they should be. They are a record keyed
// "0", "1", … (not a list): a later line of the same reply adds keys, which replay fits like any other
// per-reply bookkeeping (a list append inside a scratch field would not be).
function lootItems(offer) {
    const items = offer?.items;
    if (!isPlainObject(items)) return null;
    const keys = Object.keys(items);
    if (keys.some((key, at) => key !== String(at))) return null;
    return keys.map(key => items[key]);
}

// "Lantern Oil x2", "Lantern Oil ×2" → { name, qty }: a count of any length is a count, never part of
// the name); without one, `fallback`. Money ("1000 gold", "Gold x500",
// "gold") → { money: amount }.
function lootPart(text, fallback, currency) {
    const counted = /^(.*?)\s*[x×]\s*(\d+)$/i.exec(text);
    const number = digits => Math.min(Number(digits), Number.MAX_SAFE_INTEGER);
    const { name, qty } = counted && counted[1].trim() ? { name: counted[1].trim(), qty: number(counted[2]) } : { name: text, qty: fallback };
    // A coin's name counts in the smallest unit: "3 silver" is 30 when silver is worth 10 (money.js coinValue).
    if (isCurrencyName(cleanName(name), currency)) return { name, money: number(qty * coinValue(cleanName(name), currency)) };
    const leading = /^(\d[\d,]*)\s+(.+)$/.exec(name);
    if (leading && isCurrencyName(cleanName(leading[2]), currency)) return { name: leading[2], money: number(Number(leading[1].replace(/,/g, '')) * coinValue(cleanName(leading[2]), currency)) };
    return { name, qty };
}

/** Whether the party (anyone in it) already carries the item a name means, by the tolerant lookup. */
function owned(inv, name) {
    const found = resolveDef(inv, name);
    return found.status === 'found' && Object.values(inv.stacks).some(stack => stack.def === found.id);
}

/** `? loot A, B x2, C — where | qty: n` (see above). */
export function captureLoot(ctx, line, env) {
    if (!featureOn(ctx, FEATURE.loot)) ctx.fail('FEATURE_OFF', 'Loot to pick from is turned off in the Features.');
    if (line?.op !== '?') ctx.fail('INVALID', `"${line?.op} loot" is not a change the inventory understands; write ? loot Thing, Other Thing — where it lies.`);
    const sid = ctx.carrier?.sid;
    if (ctx.cause !== 'story' || typeof sid !== 'string' || !sid) ctx.fail('REFUSED', 'Loot is laid out by a reply\'s change lines only.');
    const inv = ctx.draft('inventory');
    const fallback = lineQty(ctx, line, 1);
    if (fallback < 1) ctx.fail('INVALID', 'A quantity of loot must be at least 1.');
    const parts = String(line.name ?? '').split(/[,;]/).map(part => part.trim()).filter(Boolean);
    if (!parts.length) ctx.fail('INVALID', 'A loot line needs the things that lie there: ? loot Rusty Key, Lantern Oil — where.');
    const before = isPlainObject(inv.loot) && isPlainObject(inv.loot[sid]) ? inv.loot[sid] : null;
    const items = before ? clone(lootItems(before) ?? []) : [];
    const notes = [];
    const currency = currencyIn(ctx);
    // New definitions are worked out on a copy; the real ones are made only for what the reader takes.
    const scratch = { ...inv, defs: { ...inv.defs }, aliases: { ...inv.aliases } };
    for (const part of parts) {
        const { name: written, qty, money } = lootPart(part, fallback, currency);
        const name = cleanName(written);
        if (!name) continue;
        // Money in a loot line is a coin offer in that loot, counted for the reply now (as a
        // `+ coin` line would be) and paid into the wallet on Take: never an item, never left out unsaid.
        if (money !== undefined) {
            const purse = items.find(item => item.coin !== undefined);
            if (!purse && items.length >= LOOT_ITEMS) {
                notes.push(`One reply may lay out at most ${LOOT_ITEMS} things to pick from; ${formatAmount(money, currency)} was left out.`);
                continue;
            }
            if (money < 1) { notes.push(`${name}: an amount of money is more than nothing.`); continue; }
            const held = storyCoin(ctx, inv, money);
            if (purse) {
                purse.coin += held.amount;
                purse.name = formatAmount(purse.coin, currency);
            } else items.push({ name: formatAmount(held.amount, currency), qty: 1, coin: held.amount });
            continue;
        }
        if (items.length >= LOOT_ITEMS) {
            notes.push(`One reply may lay out at most ${LOOT_ITEMS} things to pick from; ${name} and the rest were left out.`);
            break;
        }
        if (name.length > MAX_NAME) { notes.push(`An item needs a name of 1 to ${MAX_NAME} characters; one was left out.`); continue; }
        if (owned(inv, name)) { notes.push(`${name} is already carried, so it is not offered.`); continue; }
        if (qty < 1) { notes.push(`${name}: a quantity of loot is at least 1.`); continue; }
        let held;
        let def;
        try {
            ({ def } = defineByName(ctx, scratch, name, env, { owner: 'party' }, false));
            if (items.some(item => aliasKey(item.name) === aliasKey(def.name) || resolveDef(scratch, item.name).id === def.id)) { notes.push(`${def.name} is offered once.`); continue; }
            held = storyItems(def, qty, false, 'offered');
        } catch (error) {
            if (typeof error?.code !== 'string') throw error;
            notes.push(error.message);
            continue;
        }
        items.push({ name: def.name, qty: held.qty });
        if (held.problem) notes.push(held.problem);
    }
    if (JSON.stringify(items) === JSON.stringify(lootItems(before) ?? [])) ctx.fail('REFUSED', notes.join(' ') || 'There is nothing in that loot to pick up.');
    if (!isPlainObject(inv.loot)) inv.loot = {};
    const others = Object.keys(inv.loot).filter(key => key !== sid)
        .sort((a, b) => (inv.loot[b]?.n ?? 0) - (inv.loot[a]?.n ?? 0) || (a < b ? -1 : 1));
    for (const key of others.slice(LOOT_KEEP - 1)) delete inv.loot[key];
    const here = trimText(line.text ?? '', MAX_WHERE);
    const where = before && before.where !== here ? trimText([before.where, here].filter(Boolean).join('; '), MAX_WHERE) : here;
    inv.loot[sid] = { sid, n: Number.isSafeInteger(ctx.rev) ? ctx.rev : 0, where, claim: `loot:${sid}`, items: { ...items } };
    // The offer is the reply's own (REPLAY.md "Reply-bound guards"): it goes with its reply, also when deleting the earliest
    // replies carries the rest of what they did forward, and a take of it (lootTakeGuard) goes with it.
    const offered = { kind: LOOT_OFFER, sid };
    ctx.replayGuard({ owner: LOOT_OWNER, version: 2, epoch: ctx.epoch, rulesHash: null, inputHash: ctx.hash(offered), predicate: offered, replyBound: true });
    const list = items.map(item => itemText(item.name, item.qty));
    return {
        summary: `Loot to pick from${where ? ` (${where})` : ''}: ${list.join(', ')}. The reader picks what to take (this reply's card, or To pick up in the Inventory).`,
        data: { sid, where, items: clone(items) },
        narrate: false,
        ...(notes.length ? { problem: notes.join(' ') } : {}),
    };
}

// `inventory.lootTake { sid, pick: [index…] }` (the reader's "Take selected" on the reply's card):
// once per reply's offer (claim `loot:<sid>`), the picked things the party does not carry yet go to the
// party's bag, as the offer held them. The reader's own take: past the carry limit it is refused.
// The take is a guarded block (REPLAY.md, predicate `loot.take`): what a reply laid out goes away with it, so
// the take applies, with its claim, only while that reply's offer still lays out what was taken (lootTakeGuard).
function lootTake(ctx, payload, env) {
    if (!featureOn(ctx, FEATURE.loot)) ctx.fail('FEATURE_OFF', 'Loot to pick from is turned off in the Features.');
    const inv = ctx.draft('inventory');
    const sid = payload.sid;
    const offer = typeof sid === 'string' && isPlainObject(inv.loot) && Object.hasOwn(inv.loot, sid) && isPlainObject(inv.loot[sid]) ? inv.loot[sid] : null;
    if (!offer) ctx.fail('NOT_FOUND', 'That loot is no longer there to take.');
    const things = lootItems(offer) ?? [];
    const picks = Array.isArray(payload.pick) ? payload.pick.map(at => (typeof at === 'string' && /^\d+$/.test(at) ? Number(at) : at)) : [];
    if (!picks.length || picks.length > LOOT_ITEMS || picks.some(at => !Number.isSafeInteger(at) || at < 0 || at >= things.length)) {
        ctx.fail('INVALID', 'Pick at least one of the things on offer to take.');
    }
    if (!ctx.claim(offer.claim || `loot:${sid}`)) ctx.fail('REFUSED', 'That loot has already been taken: each reply\'s loot is taken once.');
    const skipped = [];
    const wanted = [];
    const over = [];
    let coin = 0;
    for (const at of [...new Set(picks)].sort((a, b) => a - b)) {
        const item = things[at];
        if (item.coin !== undefined) { coin += item.coin; continue; }
        if (owned(inv, item.name)) { skipped.push(item.name); continue; }
        const { def, created } = defineByName(ctx, inv, item.name, env, { owner: 'party' });
        // The offer was held to what one grant can give as it read the item then; a pack enabled since (or an
        // offer an older version saved) can make it a thing that does not stack: what fits is taken, the rest stays.
        const qty = def.stack ? item.qty : Math.min(item.qty, MAX_UNSTACKED);
        if (qty < item.qty) over.push({ name: def.name, qty: item.qty - qty });
        wanted.push({ def, qty, created, offered: item.name });
    }
    if (!wanted.length && !coin) ctx.fail('REFUSED', `${joinNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} already carried.`);
    if (wanted.length) readerCarry(ctx, wanted.map(entry => ({ defId: entry.def.id, qty: entry.qty })), 'party');
    // What the take needs of the offer, decided now and kept on the block: the offer's names and how many of each were taken.
    const predicate = { kind: LOOT_GUARD, sid, claim: offer.claim || `loot:${sid}`, items: wanted.map(entry => ({ name: entry.offered, qty: entry.qty })), coin };
    ctx.replayGuard({ owner: LOOT_OWNER, version: 2, epoch: ctx.epoch, rulesHash: null, inputHash: ctx.hash(predicate), predicate });
    // FB-2: what the story offered is the story's own (`story: true`, as a `+ item` line's), whatever its
    // def (a pack's item named in the `? loot` line).
    const stacks = wanted.flatMap(entry => grantInto(ctx, inv, entry.def, entry.qty, 'party', '', false, true));
    // The money was counted for its reply when the loot was read: it is paid as offered.
    const currency = currencyIn(ctx);
    if (coin) receive(ctx, env, { owner: 'party', amount: coin, note: 'loot' });
    const where = offer.where ? ` (${offer.where})` : '';
    const left = skipped.length ? `; ${joinNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} already carried` : '';
    const took = [...wanted.map(entry => itemText(entry.def.name, entry.qty)), ...(coin ? [formatAmount(coin, currency)] : [])];
    const behind = over.length ? ` ${joinNames(over.map(entry => itemText(entry.name, entry.qty)))} ${over.length === 1 && over[0].qty === 1 ? 'is' : 'are'} left where ${over.length === 1 ? 'it' : 'they'} lay: a thing that does not stack is given at most ${MAX_UNSTACKED} at once.` : '';
    return {
        summary: `The party takes ${joinNames(took)}${where}${left}.${behind}`,
        data: { sid, taken: wanted.map(entry => ({ def: entry.def.id, qty: entry.qty })), coin, skipped, stacks, ...(over.length ? { left: over } : {}),
            v2: { result: { taken: predicate.items, coin } } },
        narrate: told(ctx),
        ...(behind ? { problem: behind.trim() } : {}),
    };
}

// The guard of a take, as the core module's replayGuard asks it (domains/index.js) on the state before the take's block,
// on a rebuild, a reload, a delete, a swipe and a Re-read alike. Pure: the state before the block and the guard's own
// predicate, nothing else. The take holds while the reply's offer is there under the same claim and lays out, by the
// tolerant name, at least as many of each thing as was taken (and at least the coin taken). The names are matched as the
// inventory looks a name up (resolveDef over the offer's things: the exact name first, then singular and plural, the
// name without portion words, then the word-order key), so "Torches" still offers what "Torch" took; a name that matches
// none of them, or two, or the thing another taken name matches, does not hold. A Re-read that leaves the
// offer as it was, or still offering what was taken, keeps the take; a deleted reply, or a Re-read that drops a taken
// thing or lowers it below what was taken, turns the take off with its claim (the block stays stored, inactive, and the
// Problems say why). The changes it made were decided when the reader took, and are replayed as they were. The offer's
// reply-bound guard (`loot.offer`) is answered here too.

// The taken things (`wanted`, [{ name, qty }]) the offer's things no longer lay out: for each, the one thing of the offer its
// name means by the inventory's own lookup (an offer as a slice of defs keyed by position, each named and aliased by its own
// name), with at least as many; a name that means none, or more than one, or a thing an earlier taken name took, is gone.
function offeredFor(things, wanted) {
    const defs = {};
    const aliases = {};
    things.forEach((item, at) => {
        if (!isPlainObject(item) || item.coin !== undefined || !nonBlank(item.name)) return;
        defs[String(at)] = { name: item.name };
        aliases[aliasKey(item.name)] ??= String(at);
    });
    const used = new Set();
    return wanted.filter(want => {
        const found = resolveDef({ defs, aliases }, want.name);
        if (found.status !== 'found' || used.has(found.id)) return true;
        used.add(found.id);
        const qty = things[Number(found.id)].qty;
        return !(Number.isSafeInteger(qty) && qty >= want.qty);
    });
}
export function lootTakeGuard({ state, hash }, { guard }) {
    const predicate = guard?.predicate;
    const damaged = { ok: false, reason: 'its loot guard is damaged' };
    if (predicate?.kind === LOOT_OFFER) {
        return guard.owner === LOOT_OWNER && guard.version === 2 && guard.replyBound === true && typeof predicate.sid === 'string'
            && Object.keys(predicate).length === 2 && hash(predicate) === guard.inputHash ? { ok: true } : damaged;
    }
    if (guard?.owner !== LOOT_OWNER || guard.version !== 2 || !isPlainObject(predicate) || predicate.kind !== LOOT_GUARD
        || typeof predicate.sid !== 'string' || typeof predicate.claim !== 'string' || !isCount(predicate.coin, 0)
        || !Array.isArray(predicate.items) || predicate.items.some(item => !isPlainObject(item) || !nonBlank(item.name) || !isCount(item.qty, 1))) return damaged;
    if (hash(predicate) !== guard.inputHash) return damaged;
    const loot = state?.domains?.inventory?.loot;
    const offer = isPlainObject(loot) && Object.hasOwn(loot, predicate.sid) && isPlainObject(loot[predicate.sid]) ? loot[predicate.sid] : null;
    if (!offer || (offer.claim || `loot:${predicate.sid}`) !== predicate.claim) return { ok: false, reason: 'the loot it took is no longer on offer' };
    const things = lootItems(offer) ?? [];
    const gone = offeredFor(things, predicate.items);
    const purse = things.find(item => isPlainObject(item) && item.coin !== undefined)?.coin;
    const short = predicate.coin > 0 && !(Number.isSafeInteger(purse) && purse >= predicate.coin);
    if (gone.length || short) {
        const names = [...gone.map(want => itemText(want.name, want.qty)), ...(short ? ['the money'] : [])];
        return { ok: false, reason: `the loot on offer no longer holds ${joinNames(names)} it took` };
    }
    return { ok: true };
}

// ---------- commands ----------

// Commands that make something out of nothing (items, money) run for the story, the host, or another
// module's command (ctx.caller); a 'ui' command at the top is refused with `why`.
function byModule(ctx, why) {
    if (!(ctx.caller || ctx.cause === 'story' || ctx.cause === 'system')) ctx.fail('REFUSED', why);
}

// ---------- hand-set gear: the starting kit (docs/v2/GEAR.md "Your own gear") ----------
//
// With Gear in fights on, the reader's "+ Add item" and the Edit of a piece they added can set Kind, Slot, Rarity and a Bonus. The full
// setup (Rarity, Bonus) is the starting kit's: allowed only while the chat has no message from the reader yet (a swipe of the greeting keeps it
// open; `env.readers()` counts the reader's messages on the line of history and `env.greetingOnly()` is false once anything but the greeting is there, so only a rewind back to the greeting opens it again). After that Rarity
// stays Common with no Bonus. A def the reader made is marked `hand: true`; the story's, a pack's and a bound piece's are not theirs to change.
/** Whether the starting kit is open: the chat is at its first message (only the opening greeting: no message from the reader and no reply after it). Unknown counts as closed. */
export function kitOpen(env) {
    try { return env?.readers?.() === 0 && env?.greetingOnly?.() !== false; } catch { return false; }
}

const article = word => (/^[aeiou]/i.test(word) ? 'An' : 'A');

// The stats a reader typed: { STAT: n } for the seven stats, whole numbers of at least 1, at most GEAR.maxStats different ones. `{}` for none.
function handStats(ctx, raw) {
    if (raw === undefined || raw === null) return {};
    if (!isPlainObject(raw)) ctx.fail('INVALID', fill(E.kitStats, { max: GEAR.maxStats }));
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        const stat = String(key).trim().toUpperCase();
        if (!GEAR.stats.includes(stat) || !Number.isSafeInteger(value) || value < 1 || Object.hasOwn(out, stat)) ctx.fail('INVALID', fill(E.kitStats, { max: GEAR.maxStats }));
        out[stat] = value;
    }
    if (Object.keys(out).length > GEAR.maxStats) ctx.fail('INVALID', fill(E.kitStats, { max: GEAR.maxStats }));
    return out;
}

// The points a rarity allows: the refusal is the sentence the form shows ("A rare piece gives at most 2 points.").
function holdBudget(ctx, rarity, stats) {
    const total = Object.values(stats).reduce((sum, n) => sum + n, 0);
    const max = GEAR.budget[rarity] ?? 0;
    if (total <= max) return;
    ctx.fail('REFUSED', max === 0 ? E.kitNoBonus : fill(E.kitBudget, { a: article(rarity), rarity, max, points: max === 1 ? 'point' : 'points' }));
}

// A slot the reader chose: one of the eight places (or its base word), → the place key; null for none.
function handSlot(ctx, raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const word = typeof raw === 'string' ? slotWordOf(raw) : null;
    if (!word || !GEAR.places.includes(placeOf(word))) ctx.fail('INVALID', fill(E.kitSlot, { slots: GEAR.places.join(', ') }));
    return word;
}

/**
 * "+ Add item" with Kind = Equipment names a definition that already exists and is not equipment (or is the reader's own equipment with no slot): the
 * reader's choice wins and the definition is made equipment in this same add (its own recorded op, so a replay does the same), only when nobody but
 * the reader has a claim on it:
 *  - never a pack's definition (`pack.…`), a bound piece's, or anything with a stack the story gave (`story: true`);
 *  - a definition marked `hand` (made by a reader's add): also while the reader's own stacks of it are held (each of one, as equipment does not stack);
 *  - any other `story/` definition (older saves did not mark the reader's): only while no stack of it is left, as when the reader has deleted it.
 * Anything else is refused with a sentence that says what to do.
 */
function remakeAsEquipment(ctx, inv, def, keep, slot) {
    const fixable = def.kind !== 'equipment' || (!def.slot && Boolean(slot));
    if (!fixable) return;
    const stacks = Object.values(inv.stacks).filter(stack => stack.def === def.id);
    const theirs = def.id.startsWith('story/') && !stacks.some(stack => stack.story === true || stack.bound !== undefined)
        && (def.hand === true ? stacks.every(stack => stack.qty === 1) : stacks.length === 0);
    if (!theirs) ctx.fail('REFUSED', fill(E.kitExisting, { name: def.name, kind: def.kind }));
    const place = keep.slot ?? def.slot ?? gearSlotOf(null, def.name);
    Object.assign(inv.defs[def.id], { kind: 'equipment', stack: false, slot: place ?? null, stats: keep.stats ?? {}, hand: true });
    def.kind = 'equipment'; def.stack = false; def.slot = place ?? null; def.stats = keep.stats ?? {};
}

// Where a piece of `slot` goes on `owner`: an accessory takes the place named when it is free, else the other one when that is free
// (a second accessory goes to Accessory 2), else the place named. Other slots are their own place.
function handPlace(inv, owner, stackId, slot) {
    if (baseSlot(slot) !== 'accessory') return slot;
    const free = key => !Object.values(inv.stacks).some(other => other.owner === owner && other.id !== stackId && other.equipped === key);
    const named = slot === 'accessory' ? 'accessory-1' : slot;
    return [named, ...['accessory-1', 'accessory-2'].filter(key => key !== named)].find(free) ?? named;
}


// The reader's Edit of a piece they added by hand (gear on): `kind`, `slot` (a place, or '' for none), `rarity` and `stats`. Only a def with `hand: true` and no
// story-given stack; a pack's or the story's keeps its words. Rarity and Bonus are the starting kit's: changing them is refused once the reader has sent a message.
// A piece made Equipment later is Common with no Bonus; one made something else gives up its slot (and is taken off).
function handEdit(ctx, env, inv, stack, payload) {
    if (!gearOn(ctx)) ctx.fail('REFUSED', E.gearOff);
    const def = inv.defs[stack.def];
    refuseBound(ctx, inv, stack);
    if (def.id.startsWith('pack.')) ctx.fail('REFUSED', E.kitPack);
    if (!handDef(inv, def)) ctx.fail('REFUSED', E.kitStory);
    const kind = payload.kind ?? def.kind;
    if (!KINDS.includes(kind)) ctx.fail('INVALID', fill(E.itemKind, { kinds: KINDS.join(', ') }));
    if (payload.rarity !== undefined && payload.rarity !== null && !RARITIES.includes(payload.rarity)) ctx.fail('INVALID', fill(E.itemRarity, { rarities: RARITIES.join(', ') }));
    const becomes = kind === 'equipment' && def.kind !== 'equipment';
    const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    const stats = payload.stats === undefined ? null : handStats(ctx, payload.stats);
    const rarityAsked = payload.rarity !== undefined && payload.rarity !== null && (becomes ? payload.rarity !== 'common' : payload.rarity !== def.rarity);
    const statsAsked = stats !== null && (becomes ? Object.keys(stats).length > 0 : !same(stats, statsFor(def)));
    if ((rarityAsked || statsAsked) && !kitOpen(env)) ctx.fail('REFUSED', E.kitClosed);
    if (kind !== 'equipment' && (payload.slot || (stats && Object.keys(stats).length))) ctx.fail('INVALID', E.gearNeedsEquipment);
    const open = kitOpen(env);
    const rarity = becomes ? (open ? payload.rarity ?? 'common' : 'common') : kind === 'equipment' ? payload.rarity ?? def.rarity : def.rarity;
    const nextStats = kind !== 'equipment' ? {} : becomes ? (open && stats ? stats : {}) : stats ?? statsOf(def.stats);
    if (kind === 'equipment') holdBudget(ctx, rarity, nextStats);
    const slot = kind !== 'equipment' ? null : payload.slot === undefined ? slotWordOf(def.slot) : handSlot(ctx, payload.slot);
    const pieces = Object.values(inv.stacks).filter(item => item.def === def.id);
    if (becomes) {
        const extra = pieces.reduce((sum, item) => sum + item.qty - 1, 0);
        if (pieces.length + extra > MAX_UNSTACKED) ctx.fail('INVALID', fill(E.kitMany, { max: MAX_UNSTACKED }));
        for (const item of pieces) {
            for (let n = 1; n < item.qty; n += 1) addStack(ctx, inv, def.id, 1, item.owner, item.note, item.key === true, false);
            item.qty = 1;
        }
    }
    // A piece that no longer fits where it is worn is taken off.
    for (const item of pieces) {
        if (item.equipped !== null && (kind !== 'equipment' || !slot || baseSlot(item.equipped) !== baseSlot(slot))) item.equipped = null;
    }
    def.kind = kind;
    def.rarity = rarity;
    def.slot = slot ? baseSlot(slot) : null;
    def.stats = nextStats;
    def.stack = kind !== 'equipment';
}

// A reader edit is never a story line or a nested module call.
function byReader(ctx) {
    if (ctx.cause !== 'ui' || ctx.caller !== null) ctx.fail('REFUSED', E.onlyReader);
}

export const INVENTORY_EDIT_GUARD = 'inventory.reader-edit';
const editStack = stack => ({ id: stack.id, def: stack.def, owner: stack.owner });
const editPieces = (inventory, target) => Object.values(inventory?.stacks ?? {})
    .filter(stack => stack.def === target.def && stack.owner === target.owner)
    .map(stack => ({ id: stack.id, equipped: stack.equipped }));

// Saved ops cannot choose a different stack on replay. Witness the same name lookup and
// compatibility decision made when the reader added or renamed an item, without including
// unrelated inventory or a destination count that counter replay can safely rebase.
const editCompatibility = (inv, stack) => stack ? {
    id: stack.id, def: stack.def, owner: stack.owner, note: stack.note,
    equipped: stack.equipped, condition: condOf(stack, inv), key: stack.key === true,
} : null;
function addDecision(inv, payload, defId) {
    const name = cleanName(payload.name), owner = payload.owner ?? 'party';
    const note = payload.note == null ? '' : trimText(payload.note, MAX_NOTE);
    const def = inv.defs[defId];
    const destination = def?.stack ? looseMatch(inv, defId, owner, note) : null;
    return { resolution: resolveDef(inv, name), def: def ? { id: def.id, stack: def.stack } : null,
        destination: editCompatibility(inv, destination) };
}
function renameDecision(inv, stack, payload) {
    const name = cleanName(payload.name), original = inv.defs[stack.def], found = resolveDef(inv, name);
    const note = payload.note === undefined ? stack.note : payload.note == null ? '' : trimText(payload.note, MAX_NOTE);
    const source = { ...editCompatibility(inv, stack), note };
    if (found.status === 'found' && found.id !== original.id) {
        const targetDef = inv.defs[found.id];
        const target = stacksOf(inv, found.id).find(other => targetDef.stack && source.owner === other.owner
            && source.equipped === other.equipped && source.note === other.note && source.condition === condOf(other, inv)
            && source.key === (other.key === true));
        return { resolution: found, original: { name: original.name, stack: original.stack }, source,
            sourceQty: stack.qty, sourceStory: stack.story === true, targetStackable: targetDef.stack,
            destination: editCompatibility(inv, target) };
    }
    if (name === original.name) return { resolution: found, original: { name: original.name, stack: original.stack } };
    const shared = Object.values(inv.stacks).some(other => other.id !== stack.id && other.def === original.id);
    if (shared || original.id.startsWith('pack.')) {
        return { resolution: found, original, shared, newDef: freeId(inv, `story/${slugify(name)}`) };
    }
    const aliases = Object.keys(inv.aliases).filter(key => inv.aliases[key] === original.id).sort();
    return { resolution: found, original: { name: original.name, stack: original.stack }, shared, aliases };
}

// A reader action is a guarded ordinary command. If a later Re-read makes its saved ops
// invalid, the existing replay machinery can leave just this action off and report it.
function guardReaderEdit(ctx, action, target = null, pieces = null, decision = null) {
    if (ctx.cause !== 'ui' || ctx.caller !== null || typeof ctx.replayGuard !== 'function' || !ctx.source) return;
    const predicate = { kind: INVENTORY_EDIT_GUARD, action, ...(target ? { target } : {}), ...(pieces ? { pieces: ctx.hash(pieces) } : {}),
        ...(decision ? { decision: { ...decision, witness: ctx.hash(decision.witness) } } : {}) };
    ctx.replayGuard({ owner: 'story-block', version: 2, epoch: ctx.epoch, rulesHash: null,
        inputHash: ctx.hash({ predicate, source: ctx.source }), predicate });
}

export function inventoryEditGuard({ state, hash }, { guard, source, operation }) {
    const p = guard?.predicate;
    const bad = { ok: false, reason: E.itemEditDamaged };
    if (guard?.owner !== 'story-block' || guard.version !== 2 || guard.rulesHash !== null
        || !isPlainObject(p) || p.kind !== INVENTORY_EDIT_GUARD
        || !['inventory.add', 'inventory.edit', 'inventory.drop'].includes(p.action)
        || operation?.type !== p.action || Object.keys(p).some(key => !['kind', 'action', 'target', 'pieces', 'decision'].includes(key))
        || hash({ predicate: p, source }) !== guard.inputHash) return bad;
    const inventory = state?.domains?.inventory;
    if (p.decision !== undefined) {
        const d = p.decision, payload = operation?.payload;
        if (!isPlainObject(d) || !inventory || !isPlainObject(payload) || typeof payload.name !== 'string'
            || typeof d.witness !== 'string' || !/^[a-f0-9]{64}$/.test(d.witness)) return bad;
        let witness;
        if (p.action === 'inventory.add' && Object.keys(d).length === 2 && typeof d.def === 'string') {
            witness = addDecision(inventory, payload, d.def);
        } else if (p.action === 'inventory.edit' && Object.keys(d).length === 1 && inventory.stacks?.[payload.stack]
            && inventory.defs?.[inventory.stacks[payload.stack].def]) {
            witness = renameDecision(inventory, inventory.stacks[payload.stack], payload);
        } else return bad;
        if (hash(witness) !== d.witness) return { ok: false, reason: E.itemDecisionChanged };
    }
    // Earlier saved guards did not have a decision witness; keep their existing replay behavior.
    if (p.action === 'inventory.add') return p.target === undefined && p.pieces === undefined ? { ok: true } : bad;
    if (!isPlainObject(p.target) || Object.keys(p.target).length !== 3
        || typeof p.target.id !== 'string' || p.target.id !== operation?.payload?.stack
        || typeof p.target.def !== 'string' || typeof p.target.owner !== 'string') return bad;
    const stack = inventory?.stacks?.[p.target.id];
    if (!stack || stack.def !== p.target.def || stack.owner !== p.target.owner || !inventory?.defs?.[stack.def]) {
        return { ok: false, reason: E.itemEditGone };
    }
    if (p.pieces !== undefined && (p.action !== 'inventory.edit' || operation?.payload?.group !== true
        || !(Array.isArray(p.pieces) || (typeof p.pieces === 'string' && /^[a-f0-9]{64}$/.test(p.pieces))))) return bad;
    const piecesHash = Array.isArray(p.pieces) ? hash(p.pieces) : p.pieces;
    if (p.pieces !== undefined && hash(editPieces(inventory, p.target)) !== piecesHash) {
        return { ok: false, reason: E.itemPiecesChanged };
    }
    return { ok: true };
}

// What the narrator is told after an edit's line under [Happened] (a receipt's `data.told`, added by prompt.js; the reader's
// card does not show it). A starting purse or kit (a saved character's, from the wizard: `starting: true`) and the reader's own
// corrections are the state as it stands, so the narrator must not read them as money or things that moved in the story.
export const TOLD = Object.freeze({
    startPurse: 'Starting purse, set before the story began: not money paid or received in the story.',
    startKit: 'Starting kit, set before the story began: not found, bought or used in the story.',
    editPurse: 'The reader\'s own correction: the purse is this now, not money paid or received in the story.',
    editKit: 'The reader\'s own correction: the party has this now, not found, bought or used in the story.',
});

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

        'wallet.set'(ctx, payload = {}) {
            byReader(ctx);
            const owner = receiverArg(ctx, payload.owner);
            if (!isCount(payload.amount, 0)) ctx.fail('INVALID', E.purseAmount);
            const inv = ctx.draft('inventory');
            const wallet = (inv.wallets[owner] ??= {});
            const from = wallet[WALLET_KEY] ?? 0;
            wallet[WALLET_KEY] = payload.amount;
            return { summary: fill(E.purseSet, { amount: formatAmount(payload.amount, currencyIn(ctx)) }),
                data: { edit: true, from, to: payload.amount, told: payload.starting === true ? TOLD.startPurse : TOLD.editPurse }, narrate: true };
        },

        // { owner, amount, note? }, amount in whole units of the one currency. Like inventory.grant, not
        // from a button on its own: the story, the host, or another module's command through ctx.call
        // (a shop's trade.buy pays; a reward's quest.finish receives).
        'wallet.pay'(ctx, payload = {}) {
            byModule(ctx, 'Money cannot be paid from a button on its own; it is paid by the story or by another module\'s action.');
            return pay(ctx, env, {
                owner: ownerArg(ctx, payload.owner),
                amount: count(ctx, payload.amount, undefined, 'amount'),
                note: textArg(ctx, payload.note, 120, 'note'),
            });
        },

        // `story: true` (a module's call): money the story alone vouched for (a quest reward the story
        // wrote). It is paid in full (there is no per-reply limit) and counted for the reply: during a
        // capture the reply being read; outside one (a click after the reply, RX-E-2) the reply the click is
        // stored on, the head carrier (ctx.reply), so `inventory.storyBudget` can tell a reply's coin lines
        // from the payouts after it. Without the flag, a module's payout is not counted.
        'wallet.receive'(ctx, payload = {}) {
            byModule(ctx, 'Money cannot be handed out from a button; it comes from the story or from another module\'s action.');
            if (payload.story !== undefined && typeof payload.story !== 'boolean') ctx.fail('INVALID', 'story must be true or false.');
            const args = {
                owner: receiverArg(ctx, payload.owner),
                amount: count(ctx, payload.amount, undefined, 'amount'),
                note: textArg(ctx, payload.note, 120, 'note'),
            };
            return payload.story === true && ctx.caller ? receiveStory(ctx, env, args, true) : receive(ctx, env, args);
        },

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

// ---------- capture (§4.4): runs as a story command ----------

// What one reply's story lines give. The story decides what it pays: there is no per-reply cap on coin,
// items or goods (only a thing that does not stack, a stack per piece, is held to MAX_UNSTACKED a line).
// Code's own payouts (a module's wallet.receive or inventory.grant through ctx.call) are not counted
// here, except a payout a module says the story alone vouched for (`wallet.receive { story: true }`), during
// the reply's capture or by a click after it (counted against the reply the click is stored on, ctx.reply;
// RX-E-2). `inventory.storyBudget` tells a module what has been given (createInventoryQueries).
// What was given is still counted, for modules that tell a reply whose coin lines paid from one whose
// quest payouts did: the inventory slice keeps `perReply[<sid>]` = { coin, vouched?, debit? }, under the
// reply's record ID (ctx.carrier.sid, which stays with the reply when earlier messages are deleted), so it
// rolls back with the reply and starts again on the next one or another swipe. A reply adds its own entry
// and drops the others; `perReply` is the domain's `scratch` (ops.js): on replay a drop of an entry already
// gone (its reply deleted) is passed over, so no reply's gains hang on another's. An older chat's entries
// also hold `worth`, `made`, `items` and `notable`: they are ignored, and a stored reply replays as it was
// written (its ops hold what it gave).
// A click's vouched payout (a2-3) adds its own key instead, `storyClicks[<sid>][<receipt id>] = paid`
// (scratch too, add-only, on the same carrier), and never writes the reply's entry: a swipe or delete of
// the reply takes it back with the reply. The reply's money given is its entry's `coin` plus its clicks.

// The money scale (MODULES §F104): how many of the chat's coins one coin of the built-in defaults is worth.
// Defaults are gold-scale; a pack whose currency is copper-like says `economy: { scale }`. The scale only
// multiplies built-in default numbers, never what a pack or the reader wrote.
export const ECONOMY_SCALE = Object.freeze({ min: 0.001, max: 1000 });

const scaleIn = value => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN;
    return Number.isFinite(n) && n >= ECONOMY_SCALE.min && n <= ECONOMY_SCALE.max ? n : null;
};

/**
 * `{ scale, source }`: the reader's `economyScale` setting when it is a number from 0.001 to 1000
 * (`source: 'settings'`; 0 or blank: use the pack's), else the enabled pack's `economy.scale`
 * (`'pack'`), else 1 (`'default'`). `packEconomy` is packs.economy's answer ({ scale } or null).
 */
export function economyOf(settings, packEconomy = null) {
    const set = scaleIn(settings?.economyScale);
    if (set !== null) return { scale: set, source: 'settings' };
    const pack = scaleIn(packEconomy?.scale);
    if (pack !== null) return { scale: pack, source: 'pack' };
    return { scale: 1, source: 'default' };
}

/** A built-in default amount in the chat's coins: × scale, rounded, at least 1. */
export function scaledDefault(amount, scale = 1) {
    return Math.max(1, Math.round(amount * (scaleIn(scale) ?? 1)));
}

const tallied = value => (isCount(value, 0) ? value : 0);

// The reply a tally is kept for: during a story capture its carrier's record ID; for a module's vouched
// payout outside one (a click), the reply its changes are stored on (ctx.reply, the head carrier). null
// when nothing is counted: a module's own call it does not vouch for, or a command with no reply.
function tallyId(ctx, vouched = false) {
    if (ctx.caller && !vouched) return null;
    const id = ctx.cause === 'story' ? ctx.carrier?.sid ?? ctx.carrier?.key : null;
    const out = id ?? (vouched && ctx.caller ? ctx.reply?.sid : null);
    return typeof out === 'string' && out ? out : null;
}

// What reply `id` has given so far: its stored entry, or null.
function storedTally(inv, id) {
    return id && isPlainObject(inv?.perReply) && Object.hasOwn(inv.perReply, id) && isPlainObject(inv.perReply[id]) ? inv.perReply[id] : null;
}

// A copy of the tally for this reply (a fresh one when none is stored); null when nothing is counted
// (tallyId). A module's own call is counted only when it says the story vouched for it (`vouched`).
// Kept with keepTally.
function tallyOf(ctx, inv, vouched = false) {
    const id = tallyId(ctx, vouched);
    if (!id) return null;
    const stored = storedTally(inv, id);
    const tally = { id, coin: tallied(stored?.coin) };
    // Of `coin`, what modules' vouched payouts gave (quest rewards), kept only once there is some.
    if (tallied(stored?.vouched)) tally.vouched = tallied(stored.vouched);
    // Money the reply's lines took (`- coin`), kept only once there is some (a rules module's debit cap).
    if (tallied(stored?.debit)) tally.debit = tallied(stored.debit);
    return tally;
}

// This reply's entry, alone: other replies' entries (and an older shape's fields) go, their clicks too.
function keepTally(inv, { id, ...tally }) {
    if (!isPlainObject(inv.perReply)) inv.perReply = {};
    for (const key of Object.keys(inv.perReply)) if (key !== id) delete inv.perReply[key];
    inv.perReply[id] = tally;
    if (isPlainObject(inv.storyClicks)) for (const key of Object.keys(inv.storyClicks)) if (key !== id) delete inv.storyClicks[key];
}

// What the clicks after reply `id` paid (storyClicks).
function clicksOf(inv, id) {
    const log = isPlainObject(inv?.storyClicks) && Object.hasOwn(inv.storyClicks, id) ? inv.storyClicks[id] : null;
    return isPlainObject(log) ? Object.values(log).reduce((sum, paid) => sum + tallied(paid), 0) : 0;
}

// A click's vouched payout: its own key under the reply (add-only), the reply's entry left as it is.
// Other replies' entries go here too (pruned by key), as keepTally drops them.
function keepClick(ctx, inv, id, paid) {
    if (isPlainObject(inv.perReply)) for (const key of Object.keys(inv.perReply)) if (key !== id) delete inv.perReply[key];
    if (!isPlainObject(inv.storyClicks)) inv.storyClicks = {};
    for (const key of Object.keys(inv.storyClicks)) if (key !== id) delete inv.storyClicks[key];
    if (!isPlainObject(inv.storyClicks[id])) inv.storyClicks[id] = {};
    const key = String(ctx.receiptId ?? 'click');
    inv.storyClicks[id][key] = tallied(inv.storyClicks[id][key]) + paid;
}

// A story line's money, counted for the reply (nothing is held back): { amount }. Counted only for a story
// line and a module's vouched payout (tallyOf).
function storyCoin(ctx, inv, amount, vouched = false) {
    const tally = tallyOf(ctx, inv, vouched);
    if (!tally) return { amount };
    // A click (a module's vouched payout outside a capture) is kept as its own key (keepClick).
    if (vouched && ctx.cause !== 'story') {
        keepClick(ctx, inv, tally.id, amount);
    } else {
        tally.coin = Math.min(Number.MAX_SAFE_INTEGER, tally.coin + amount);
        if (vouched) tally.vouched = Math.min(Number.MAX_SAFE_INTEGER, (tally.vouched ?? 0) + amount);
        keepTally(inv, tally);
    }
    return { amount };
}

// `qty` of a def a story line gives: all of it, except a thing that does not stack, which is held to what one
// line can give (each piece is a stack of its own, grantInto), so a loot offer is always one its Take can
// give: { qty, problem }. `more`: a raised count (`~ item … | qty:`); `verb`: how the Problems list says it.
function storyItems(def, qty, more = false, verb = 'given') {
    const given = def.stack ? qty : Math.min(qty, MAX_UNSTACKED);
    return {
        qty: given,
        problem: given < qty ? `${itemText(def.name, qty)}${more ? ' more' : ''} was written, but ${def.name} does not stack and at most ${MAX_UNSTACKED} can be given at once; ${given} were ${verb}.` : null,
    };
}

// The carry limit, when a module keeps one (`items.carry`, MODULES §F39): whether `owner` can take on
// `add` ([{ defId, qty }]; `move` for a hand-over between the party's own) → { ok, message }, or null
// when no module answers (no limit).
function carryFits(ctx, add, owner, move = false) {
    const fits = carryAnswer((name, args) => ctx.query(name, args), { owner, add, ...(move ? { move: true } : {}) }, gearOn(ctx));
    if (!isPlainObject(fits)) return null;
    const message = typeof fits.message === 'string' && fits.message ? fits.message : 'There is no room to carry that.';
    return { ok: fits.ok !== false, message };
}

// The reader's own takes and hand-overs (MODULES §F39): over the limit they are refused, nothing moves.
function readerCarry(ctx, add, owner, move = false) {
    const fits = carryFits(ctx, add, owner, move);
    if (fits && !fits.ok) ctx.fail('REFUSED', fits.message);
}

// What the story gives past the carry limit (`story-block.encumbrance`): kept, and the party is
// encumbered (derived from the load: inventory.encumbrance), so `true` comes back; with the feature
// off the line is refused with the module's reason, as F39 has it. No module answering: no limit.
function storyCarry(ctx, def, qty, owner) {
    const fits = carryFits(ctx, [{ defId: def.id, qty }], owner);
    if (!fits || fits.ok) return false;
    if (!featureOn(ctx, FEATURE.encumbrance)) ctx.fail('REFUSED', fits.message);
    return true;
}

const ENCUMBERED_NOTE = ' The party now carries more than it can and is encumbered until something is put down.';

function lineQty(ctx, line, fallback) {
    const written = labelOf(line, 'qty', 'quantity', 'count');
    if (written === null) return fallback;
    const n = parseCount(written);
    if (n === null) ctx.fail('INVALID', `"${written}" is not a quantity.`);
    return n;
}

// A consumable the story says was used (MODULES §F96): `- item Potion | used: yes`, or a used-word in
// the line or the reply, and no word that says it went another way.
export const USED_WORDS = /\b(?:used|uses|drank|drinks|drunk|ate|eats|eaten|applied|applies|quaffed|swallowed|consumed)\b/i;
export const GONE_WORDS = /\b(?:lost|loses|sold|sells|gave|given|gives|dropped|stolen|traded|handed|broke|broken|spilled|spilt)\b/i;

/** Whether a `- item` line says the thing was used (not lost, sold, given…): see USED_WORDS. */
export function usedByLine(line, replyText = '') {
    const labels = Object.entries(line?.labels ?? {}).map(([name, value]) => `${name} ${value}`).join(' ');
    const own = `${line?.text ?? ''} ${labels}`;
    if (GONE_WORDS.test(own)) return false;
    if (/^(?:yes|true|1)$/i.test(String(line?.labels?.used ?? '').trim())) return true;
    return USED_WORDS.test(own) || USED_WORDS.test(String(replyText ?? ''));
}

// A used consumable goes to the module that answers `item.use` (its effect is that module's rules):
// `item.use { name, on, qty, story: true }`. Null when no module answers it (the line then takes the
// thing away, as before); a refusal there refuses the line, so the thing stays.
function useInStory(ctx, line, def, qty) {
    const on = labelOf(line, 'on', 'who', 'by');
    let out;
    try {
        out = ctx.call('item.use', { name: def.name, ...(on ? { on } : {}), qty, story: true });
    } catch (error) {
        if (error?.code === 'UNKNOWN_COMMAND' && String(error.message).includes('"item.use"')) return null;
        throw error;
    }
    const data = isPlainObject(out?.data) ? out.data : {};
    return {
        summary: typeof out?.summary === 'string' && out.summary ? out.summary : `${itemText(def.name, qty)} used.`,
        data: { ...clone(data), def: def.id, qty, used: true },
        narrate: typeof out?.narrate === 'boolean' ? out.narrate : false,
    };
}

// The stats a line names (`| DEX: +2 | STR: 1`): { DEX: 2, STR: 1 } for the whole numbers above 0; gearDefine holds them to the rarity's budget.
function statWords(line) {
    const out = {};
    for (const stat of GEAR.stats) {
        const written = labelOf(line, stat.toLowerCase());
        const n = written === null ? NaN : Number(/^\s*\+?(\d{1,3})\s*$/.exec(written)?.[1]);
        if (Number.isSafeInteger(n) && n > 0) out[stat] = n;
    }
    return out;
}

// With gear on, a gained item's `equipped: <slot>` puts it on: the slot is the word's (weapon, body, off-hand, head, cloak, feet, accessory),
// one item per slot per owner, so what was in it is put away. Equipment only; a word that is no slot, or one the item does not fit, is passed over.
// (the story's gains go to the party's bag, where nothing is bound: a bound piece is a member's, so it is never the one put away here)
function equipFromLine(inv, def, stackIds, word) {
    if (word === null || def.kind !== 'equipment' || !stackIds?.length) return null;
    const named = slotWordOf(word);
    const own = slotWordOf(def.slot);
    if (!named || (own && baseSlot(named) !== baseSlot(own))) return null;
    const id = [...stackIds].reverse().find(sid => inv.stacks[sid] && inv.stacks[sid].equipped === null);
    if (!id) return null;
    const stack = inv.stacks[id];
    let where = placeOf(named);
    if (named === 'accessory') {
        const taken = key => Object.values(inv.stacks).some(other => other.owner === stack.owner && other.id !== stack.id && other.equipped === key);
        where = ['accessory-1', 'accessory-2'].find(key => !taken(key)) ?? 'accessory-1';
    }
    const occupant = Object.values(inv.stacks).find(other => other.id !== stack.id && other.owner === stack.owner && other.equipped === where);
    if (occupant) occupant.equipped = null;
    stack.equipped = where;
    return `${def.name} is equipped (${where}).`;
}

/** `+ item Name | qty | note`, `- item Name | qty`, `~ item Name | note | qty | name` (a rename). */
export function captureItem(ctx, line, env) {
    const inv = ctx.draft('inventory');
    const name = cleanName(line?.name);
    if (!name) ctx.fail('INVALID', 'An item line needs the item\'s name.');
    const text = String(line.text ?? '').trim();
    // An "item" named as money (the currency, a coin, "Silver Coins", "3 silver coins") goes to the
    // wallet, as the coin and loot lines read the same words (B-a1-7).
    const currency = currencyIn(ctx);
    if (isCurrencyName(name, currency) || countedMoney(name, currency)) return itemAsCoin(ctx, line, env, currency);
    if (line.op === '+') {
        const qty = lineQty(ctx, line, 1);
        if (qty < 1) ctx.fail('INVALID', 'A gained item needs a quantity of at least 1.');
        const note = trimText(labelOf(line, 'note') ?? text, MAX_NOTE);
        const { def, created } = defineByName(ctx, inv, name, env, { note, owner: 'party', words: { kind: labelOf(line, 'kind'), slot: labelOf(line, 'slot') ?? labelOf(line, 'equipped', 'equip', 'worn'), rarity: labelOf(line, 'rarity', 'quality'), stats: statWords(line) } });
        const held = storyItems(def, qty);
        // Asked before the stacks change: `add` is weight on top of what is carried now.
        const heavy = storyCarry(ctx, def, held.qty, 'party');
        // Given by a story line: the story's own whatever its def (B-a2-2), for what it sells for.
        const stacks = grantInto(ctx, inv, def, held.qty, 'party', note, false, true);
        const worn = gearOn(ctx) ? equipFromLine(inv, def, stacks, labelOf(line, 'equipped', 'equip', 'worn')) : null;
        return {
            summary: `The party gains ${itemText(def.name, held.qty)}.${worn ? ` ${worn}` : ''}${heavy ? ENCUMBERED_NOTE : ''}`,
            data: { def: def.id, qty: held.qty, owner: 'party', stacks, created, from: labelOf(line, 'from') ?? '', ...(heavy ? { encumbered: true } : {}) },
            narrate: false,
            ...(held.problem ? { problem: held.problem } : {}),
        };
    }
    if (line.op === '-') {
        const def = knownDef(ctx, inv, name);
        const qty = lineQty(ctx, line, 1);
        if (qty < 1) ctx.fail('INVALID', 'A lost item needs a quantity of at least 1.');
        if (def.kind === 'consumable' && usedByLine(line, ctx.chat?.reply)) {
            const used = useInStory(ctx, line, def, qty);
            if (used) return used;
        }
        const held = unbound(ctx, inv, stacksOf(inv, def.id));
        const have = held.reduce((sum, stack) => sum + stack.qty, 0);
        if (!have) ctx.fail('NOT_FOUND', `There is no ${def.name} in the inventory.`);
        if (have < qty) ctx.fail('NOT_ENOUGH', shortOf(def.name, have));
        takeAcross(inv, held, qty);
        return {
            summary: `Lost ${itemText(def.name, qty)} (${have - qty} left).`,
            data: { def: def.id, qty, left: have - qty },
            narrate: false,
        };
    }
    if (line.op === '~') {
        const def = knownDef(ctx, inv, name);
        const changes = [];
        const worn = labelOf(line, 'wear');
        if (worn !== null) changes.push(storyWear(ctx, inv, def, worn, trimText(text, MAX_NOTE)).replace(/\.$/, ''));
        // With gear on, the story's repair word mends a piece (one condition word up) or restores it (back to Good).
        const mended = gearOn(ctx) ? labelOf(line, 'repair', 'repaired', 'mend') : null;
        if (mended !== null) changes.push(storyRepair(ctx, inv, def, mended).replace(/\.$/, ''));
        const rename = labelOf(line, 'name', 'rename');
        if (rename !== null && cleanName(rename) && cleanName(rename) !== def.name) {
            const lots = stacksOf(inv, def.id);
            if (lots.length) refuseBound(ctx, inv, lots.find(lot => boundId(ctx, lot)) ?? lots[0]);
            const next = cleanName(rename);
            const key = aliasKey(next);
            const taken = (inv.aliases[key] && inv.aliases[key] !== def.id)
                || Object.values(inv.defs).some(other => other.id !== def.id && aliasKey(other.name) === key);
            if (taken) ctx.fail('REFUSED', `"${next}" is already the name of another item.`);
            if (next.length > MAX_NAME) ctx.fail('INVALID', `An item needs a name of 1 to ${MAX_NAME} characters.`);
            const old = def.name;
            inv.aliases[aliasKey(old)] ??= def.id;
            inv.aliases[key] = def.id;
            def.name = next;
            changes.push(`${old} is now called ${next}`);
        }
        // With a wear label the text says how it happened, not a new note.
        const note = labelOf(line, 'note') ?? (worn === null && mended === null ? text || null : null);
        const qty = labelOf(line, 'qty', 'quantity', 'count') === null ? null : lineQty(ctx, line, null);
        let problem = null;
        let heavy = false;
        if (note !== null || qty !== null) {
            const held = stacksOf(inv, def.id);
            if (!held.length) ctx.fail('NOT_FOUND', `There is no ${def.name} in the inventory.`);
            if (held.length > 1) ctx.fail('INVALID', `There are several lots of ${def.name}; the line cannot say which one changed.`);
            const stack = held[0];
            if (qty !== null) refuseBound(ctx, inv, stack);
            if (note !== null) {
                stack.note = trimText(note, MAX_NOTE);
                changes.push(`${def.name}: ${stack.note || 'note cleared'}`);
            }
            if (qty !== null) {
                if (qty > 1 && !def.stack) ctx.fail('REFUSED', `${def.name} does not stack.`);
                if (qty === 0) delete inv.stacks[stack.id];
                else if (qty > stack.qty) {
                    // A raised count is a gain (r2-1): held to the carry limit.
                    const held = storyItems(def, qty - stack.qty, true);
                    // Asked before the count moves: `add` is weight on top of what is carried now.
                    if (storyCarry(ctx, def, held.qty, stack.owner)) heavy = true;
                    stack.qty += held.qty;
                    problem = held.problem;
                } else stack.qty = qty;
                changes.push(`${def.name} now ${qty === 0 ? 0 : stack.qty}`);
            }
        }
        if (!changes.length) ctx.fail('INVALID', `The line changes nothing about ${def.name}.`);
        return {
            summary: `${changes.join('; ')}.${heavy ? ENCUMBERED_NOTE : ''}`,
            data: { def: def.id, ...(heavy ? { encumbered: true } : {}) },
            narrate: false,
            ...(problem ? { problem } : {}),
        };
    }
    return ctx.fail('INVALID', `"${line.op} item" is not a change the inventory understands; use +, - or ~.`);
}

// `+ item Marks | qty: 44`, `- item mark`: the party's wallet, as `+ coin 44` / `- coin 1` would.
function itemAsCoin(ctx, line, env, currency) {
    if (line.op !== '+' && line.op !== '-') {
        ctx.fail('INVALID', `${currency.plural} are money, not an item; write + coin or - coin with the amount.`);
    }
    const count = lineQty(ctx, line, 1);
    if (count < 1) ctx.fail('INVALID', 'An amount of money must be more than nothing.');
    // `+ item Silver | qty: 3` is 3 silver: counted in the smallest unit (money.js coinValue); `+ item 3
    // silver coins` too (the number in the name times the quantity).
    const counted = countedMoney(cleanName(line?.name), currency);
    const amount = counted ? count * counted.count * counted.value : count * Math.max(1, coinValue(cleanName(line?.name), currency));
    if (!Number.isSafeInteger(amount)) ctx.fail('INVALID', 'That amount is too large.');
    const who = labelOf(line, line.op === '+' ? 'from' : 'to');
    const note = who ? `${line.op === '+' ? 'from' : 'to'} ${trimText(who, 80)}` : '';
    return line.op === '+'
        ? receiveStory(ctx, env, { owner: 'party', amount, note })
        : payStory(ctx, env, { owner: 'party', amount, note });
}

// A story line's money, counted for the reply (storyCoin); `vouched` for a module's payout
// that the story alone vouched for (wallet.receive { story: true }).
function receiveStory(ctx, env, { owner, amount, note }, vouched = false) {
    storyCoin(ctx, ctx.draft('inventory'), amount, vouched);
    return receive(ctx, env, { owner, amount, note });
}

// A story payment can spend up to what the wallet holds.
function payStory(ctx, env, { owner, amount, note }) {
    return pay(ctx, env, { owner, amount, note });
}

/** `+ coin 30 | from: who`, `- coin 5 | to: who`: the party's wallet; only the number counts. */
export function captureCoin(ctx, line, env) {
    const written = labelOf(line, 'amount') ?? String(line?.name ?? '');
    if (line?.op !== '+' && line?.op !== '-') {
        ctx.fail('INVALID', `"${line?.op} coin" is not a change the wallet understands; use + coin or - coin.`);
    }
    // With coins, "3 silver" is read in the smallest unit here, before it is counted for the reply.
    const parsed = parseAmount(written, currencyIn(ctx));
    if (parsed.error) ctx.fail('INVALID', parsed.error);
    const who = labelOf(line, line.op === '+' ? 'from' : 'to');
    const note = who ? `${line.op === '+' ? 'from' : 'to'} ${trimText(who, 80)}` : '';
    return line.op === '+'
        ? receiveStory(ctx, env, { owner: 'party', amount: parsed.amount, note })
        : payStory(ctx, env, { owner: 'party', amount: parsed.amount, note });
}

// ---------- queries (read-only, plain copies) ----------

/**
 * The inventory queries; `env.settings()` gives the currency for `inventory.currency` and the reader's
 * money scale, `env.economy()` the enabled pack's ({ scale } or null) for `inventory.economy`.
 */
export const createInventoryQueries = env => ({
    // { scale, source: 'pack' | 'settings' | 'default' } (MODULES §F104): multiply built-in money defaults by scale.
    'inventory.economy': () => {
        let pack = null;
        try { pack = typeof env.economy === 'function' ? env.economy() : null; } catch { /* no packs: none */ }
        return economyOf(env.settings(), pack);
    },
    // { name, plural, short }: the chat's one currency (MODULES.md F1); name singular ("mark").
    // The reader's currency, the pack's, or gold.
    'inventory.currency': () => resolveCurrency(env.settings()),
    // Each row's `carry` (the capacity the thing adds, PACKS.md "Carry capacity") is the carry module's
    // (`items.carry` → bonuses by stack: a pack's `carry` or the reader's own) when one answers, else the def's.
    // [def copies], ID-sorted: every definition the inventory holds (default) or those of `ids` that it
    // has; unknown IDs are left out, malformed arguments give []. It reads the definitions as the asking
    // transaction has them (drafts included), makes nothing and does not depend on a pack being installed:
    // a pack's item registered by the rules module stays here after the pack is removed.
    'inventory.definitions': (state, args) => definitionsOf(state?.domains?.inventory, args),
    'inventory.items': (state, args = {}, tools) => listItems(state?.domains?.inventory, args?.owner ?? null, carryBonuses(tools), gearIsOn(env), boundNames(state, tools, env)),
    'inventory.counts': state => {
        const inventory = state?.domains?.inventory, stacks = Object.values(inventory?.stacks ?? {}), totals = new Map();
        for (const stack of stacks) {
            const key = JSON.stringify([stack.def, stack.owner]);
            totals.set(key, (totals.get(key) ?? 0) + stack.qty);
        }
        return Object.fromEntries(stacks.map(stack => [stack.id, inventory.defs?.[stack.def]?.stack === false
            ? totals.get(JSON.stringify([stack.def, stack.owner])) : stack.qty]));
    },
    // { budget, paid, left, vouched }: the story money (`+ coin` lines and modules' `wallet.receive { story:
    // true }`) the current reply has given (RX-E-2); `vouched` is the part of `paid` that modules' vouched
    // payouts gave (quest rewards), so a module can tell a reply whose money its own payouts gave from one
    // whose coin lines did. There is no per-reply limit (the story decides what it pays), so `budget` and
    // `left` are always null; they stay in the answer for modules written when a limit could be set. The
    // current reply is the one the asking command is stored on (tools.reply: a capture's carrier, else the
    // head carrier); with none known, nothing is counted as given yet.
    'inventory.storyBudget': (state, args, tools) => {
        const stored = storedTally(state?.domains?.inventory, tools?.reply?.sid);
        const clicks = tools?.reply?.sid ? clicksOf(state?.domains?.inventory, tools.reply.sid) : 0;
        const paid = tallied(stored?.coin) + clicks;
        return { budget: null, paid, left: null, vouched: Math.min(paid, tallied(stored?.vouched) + clicks) };
    },
    'inventory.wallet': (state, args = {}) => ({ ...(state?.domains?.inventory?.wallets?.[args?.owner ?? 'party'] ?? {}) }),
    // { status: 'found' | 'ambiguous' | 'none', defs: [def copies], stacks: [items of the found def] }
    'inventory.find': (state, args = {}, tools) => {
        const inventory = state?.domains?.inventory;
        const found = resolveDef(inventory, args?.name ?? '');
        return {
            status: found.status,
            defs: found.ids.map(id => clone(inventory.defs[id])),
            stacks: found.status === 'found' ? listItems(inventory, null, null, gearIsOn(env), boundNames(state, tools, env)).filter(item => item.def === found.id) : [],
        };
    },
    'inventory.equipment': (state, args, tools) => equipmentView(state, tools),
    // The loot laid out and not taken yet, newest first: [{ sid, where, n, items: [{ name, qty }] }].
    'inventory.loot': Object.assign((state) => {
        const inventory = state?.domains?.inventory;
        const claims = state?.meta?.claims ?? {};
        return Object.values(isPlainObject(inventory?.loot) ? inventory.loot : {})
            .filter(offer => isPlainObject(offer) && typeof offer.sid === 'string' && !Object.hasOwn(claims, offer.claim || `loot:${offer.sid}`) && lootItems(offer)?.length)
            .sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || (a.sid < b.sid ? -1 : 1))
            .map(offer => ({ sid: offer.sid, where: offer.where, n: offer.n, items: clone(lootItems(offer)) }));
    }, { feature: FEATURE.loot }),
    // { stack } → { stack, cond, events: [{ key, d, n }] } (the events as they apply), or null.
    'inventory.condition': (state, args = {}) => {
        const inventory = state?.domains?.inventory;
        const stack = typeof args?.stack === 'string' && isPlainObject(inventory?.stacks?.[args.stack]) ? inventory.stacks[args.stack] : null;
        return stack ? { stack: stack.id, cond: condOf(stack, inventory), events: condEvents(inventory, stack.id) } : null;
    },
    'inventory.legendEarned': Object.assign((_state, _args, tools) => legendEarned(tools), { feature: FEATURE.gear }),
    'inventory.encumbrance': Object.assign((state, args, tools) => encumbrance(state, tools, gearIsOn(env)), { feature: FEATURE.encumbrance }),
    // `story-block.gear`: { owner } → { on, owner, weapon, armour, shield: { name, bonus, cond, broken } | null, carry: { load, capacity,
    // encumbered, penalty } } (part 2's rolls read it), and `gear.carry`, `items.carry`'s answer when no carry module gives one.
    ...createGearQueries({
        on: () => gearIsOn(env), kit: () => kitOpen(env), empty: () => { try { return env?.chatEmpty?.() === true; } catch { return false; } },
        condOf, carryOf: defCarry, penalty: ENCUMBERED_PENALTY, feature: FEATURE.gear,
        names: (state, tools, id) => gearWearers(state, tools, env).names.get(id) ?? (id === 'party' ? 'The party' : String(id)),
        owners: (state, tools) => gearWearers(state, tools, env).owners,
    }),
});

// ---------- prompt view (§5) ----------
