// The inventory domain's stack and definition handling (moved out of domains/inventory.js unchanged; inventory.js re-exports every public
// name): finding and taking stacks, the bound-gear guards, the definition builders and the money receive/pay handlers.

import { ownerNameIn, OWNER_RE, isPlainObject, newId, clone, capitalize } from '../common.js';
import { trimText, resolveDef, aliasKey, cleanName, slugify } from '../names.js';
import { resolveCurrency, WALLET_KEY, formatAmount } from '../money.js';
import { DEF_ID } from '../../check.js';
import { gearDefine, packBonus, itemCarryOf } from '../gear.js';
import { STRINGS, fill } from '../../strings.js';
import { gearOn, isCount, COND_MAX, condOf, MAX_UNSTACKED, RARITIES, STORY_KIND, packCarry, MAX_NAME, defaultDef } from './state.js';
import { itemText, legendaryEarned } from './validate.js';

export const E = STRINGS.editMessages;

export const told = ctx => ctx.cause !== 'story';

// The chat's currency comes from the reader's settings or the pack.
export const currencyIn = ctx => resolveCurrency(ctx.settings());
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Taking from several stacks of one item: loose ones before worn ones, the party's first, then by ID.
const takeOrder = (a, b) => (a.equipped === null ? 0 : 1) - (b.equipped === null ? 0 : 1)
    || (a.owner === 'party' ? 0 : 1) - (b.owner === 'party' ? 0 : 1) || byId(a, b);

export function stackIn(ctx, inv, id) {
    const stack = typeof id === 'string' ? inv.stacks[id] : null;
    if (!stack) ctx.fail('NOT_FOUND', 'That item is no longer in the inventory.');
    return stack;
}

/** The member a stack is bound to, or null (not bound, or the gear switch is off). */
export const boundId = (ctx, stack) => (typeof stack?.bound === 'string' && stack.bound && gearOn(ctx) ? stack.bound : null);

// (the name by the party module's roster, else the party domain, else the ID)
export function boundName(ctx, id) {
    try {
        const actors = ctx.query('party.actors');
        const found = (Array.isArray(actors) ? actors : []).find(entry => entry?.id === id && typeof entry.name === 'string' && entry.name.trim());
        if (found) return found.name.trim();
    } catch { /* no roster: the party domain's name */ }
    return ownerNameIn(ctx, id);
}

/** Refuses (REFUSED, "Bound to Mara: Cane Sword stays with them.") when `stack` is bound; nothing otherwise. */
export function refuseBound(ctx, inv, stack) {
    const id = boundId(ctx, stack);
    if (id) ctx.fail('REFUSED', fill(E.bound, { name: boundName(ctx, id), item: inv.defs[stack.def]?.name ?? 'That piece' }));
}

/** `stacks` without the bound ones; refuses when it held some and every one of them is bound. */
export function unbound(ctx, inv, stacks) {
    const free = stacks.filter(stack => !boundId(ctx, stack));
    if (stacks.length && !free.length) refuseBound(ctx, inv, stacks[0]);
    return free;
}

export function count(ctx, value, fallback, what = 'quantity') {
    const n = value === undefined || value === null ? fallback : value;
    if (!isCount(n, 1)) ctx.fail('INVALID', `The ${what} must be a whole number of at least 1.`);
    return n;
}

export function ownerArg(ctx, value, fallback = 'party') {
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

export function receiverArg(ctx, value, fallback = 'party') {
    const owner = ownerArg(ctx, value, fallback);
    if (!ownerKnown(ctx, owner)) ctx.fail('REFUSED', `${owner} is not in the party, so nothing can be given to them.`);
    return owner;
}

export function textArg(ctx, value, max, what) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') ctx.fail('INVALID', `The ${what} must be text.`);
    return trimText(value, max);
}

export function shortOf(name, have) {
    return have === 0 ? `There is no ${name} left.` : `There is only ${itemText(name, have)} left.`;
}

export function stacksOf(inv, defId, owner = null) {
    return Object.values(inv.stacks).filter(stack => stack.def === defId && (owner === null || stack.owner === owner)).sort(takeOrder);
}

export function take(inv, stack, qty) {
    stack.qty -= qty;
    if (stack.qty === 0) delete inv.stacks[stack.id];
}

export function takeAcross(inv, stacks, qty) {
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
export function addStack(ctx, inv, def, qty, owner, note, key = false, story = false) {
    const id = newId(ctx, 'it', taken => Boolean(inv.stacks[taken]));
    inv.stacks[id] = { id, def, qty, owner, equipped: null, note, from: typeof ctx.receiptId === 'string' ? ctx.receiptId : '', ...(key ? { key: true } : {}), ...(story ? { story: true } : {}) };
    return id;
}

// A loose stack to add to: the same def, owner and note, not worn, in the same condition (`cond`).
export function looseMatch(inv, def, owner, note, except = null, cond = COND_MAX) {
    return Object.values(inv.stacks).sort(byId)
        .find(stack => stack.id !== except && stack.def === def && stack.owner === owner && stack.equipped === null && stack.note === note && condOf(stack, inv) === cond && stack.key !== true && stack.bound === undefined) ?? null;
}

/**
 * Puts `qty` of a def with an owner: onto a matching loose stack when it stacks, else new stacks (a key
 * item always its own). `story`: a story line gave it (addStack), and a stack it joins is the story's.
 */
export function grantInto(ctx, inv, def, qty, owner, note, key = false, story = false) {
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

export function ambiguous(inv, name, ids) {
    const names = ids.map(id => `${inv.defs[id].name} (${id})`);
    return `"${name}" could mean ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}; the line needs the exact name.`;
}

/** The def a name means, which must exist and be unambiguous. */
export function knownDef(ctx, inv, name) {
    const found = resolveDef(inv, name);
    if (found.status === 'ambiguous') ctx.fail('INVALID', ambiguous(inv, name, found.ids));
    if (found.status === 'none') ctx.fail('NOT_FOUND', `There is no ${name} in the inventory.`);
    return inv.defs[found.id];
}

export const freeId = (inv, base) => {
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
    // With gear on, a cart, barrow, sledge, carriage, coach, barge or wagon the story names adds the capacity of its kind (gear.js KIND_CARRY) while it is owned.
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
export function storeDef(inv, def) {
    inv.defs[def.id] = clone(def);
    inv.aliases[aliasKey(def.name)] ??= def.id;
    return inv.defs[def.id];
}

/**
 * The def a name means, created as `story/<slug>` with the §7 defaults when there is none. `keep` (a reader's add may give a kind and a
 * rarity) are fields a def made here keeps whatever the `item.define` hooks say; a def that already exists, or a pack's, is not changed by it.
 */
export function defineByName(ctx, inv, written, env, about = {}, route = true, keep = {}) {
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
export function peekPackDef(env, name) {
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
export function defineGiven(ctx, inv, given, env, about) {
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

export function receive(ctx, env, { owner, amount, note }) {
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

export function pay(ctx, env, { owner, amount, note }) {
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
