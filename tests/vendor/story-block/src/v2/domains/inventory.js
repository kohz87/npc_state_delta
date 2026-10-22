// The `inventory` domain (§7): item definitions, stacks, wallets and the alias index, with
// its validator, commands, capture kinds `item` and `coin`, queries and prompt view. Pure.
//
// Handlers follow §3.2: synchronous, everything through ctx (read/draft/call/claim/rng/fail).
// A stack whose count reaches 0 is removed, never kept at 0 (§2.5). Numbers are set by code:
// a change line proposes, these functions decide. Payloads, codes and money follow MODULES.md F:
// a rule refusal is REFUSED, a malformed payload INVALID; a wallet is { coin: n } in the smallest unit.

import {
    OWNER_RE, isPlainObject, clone, labelOf, parseCount, newId, ownerName, ownerNameIn, capitalize,
} from './common.js';
import { aliasKey, cleanName, resolveDef, slugify, trimText } from './names.js';
import { WALLET_KEY, currencyOf, formatAmount, formatWallet, isCurrencyName, parseAmount } from './money.js';
import { DEF_ID, isId } from '../check.js';

export const KINDS = Object.freeze(['goods', 'material', 'consumable', 'equipment', 'quest', 'money']);
export const RARITIES = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);
// The order kinds are listed in (prompt view and tab): what the story turns on first.
export const KIND_ORDER = Object.freeze(['quest', 'equipment', 'consumable', 'material', 'goods', 'money']);

const MAX_NAME = 120;
const MAX_NOTE = 300;
const MAX_UNSTACKED = 50;

export function initialInventory() {
    return { defs: {}, stacks: {}, wallets: {}, aliases: {} };
}

/** A story-introduced item's definition before the `item.define` hooks (§7 defaults). */
export function defaultDef(id, name) {
    return {
        id, name, kind: 'goods', rarity: 'common', value: 0, stack: true, slot: null,
        stats: {}, effect: {}, tags: [], note: '',
    };
}

const isCount = (value, min) => Number.isSafeInteger(value) && value >= min;
const nonBlank = value => typeof value === 'string' && value.trim() !== '';

function defErrors(key, def) {
    if (!isPlainObject(def)) return [`Item definition ${key} is not a record.`];
    const label = nonBlank(def.name) ? def.name : key;
    const errors = [];
    if (def.id !== key) errors.push(`Item definition ${key} is filed under the wrong ID.`);
    if (!DEF_ID.test(key)) errors.push(`"${key}" is not a well-formed item definition ID (namespace/slug).`);
    if (!nonBlank(def.name) || def.name.length > MAX_NAME) errors.push(`Item definition ${key} needs a name of 1 to ${MAX_NAME} characters.`);
    if (!KINDS.includes(def.kind)) errors.push(`${label} has an unknown kind "${def.kind}".`);
    if (!RARITIES.includes(def.rarity)) errors.push(`${label} has an unknown rarity "${def.rarity}".`);
    if (!isCount(def.value, 0)) errors.push(`${label} has a value that is not a whole number of at least 0.`);
    if (typeof def.stack !== 'boolean') errors.push(`${label} must say whether it stacks (true or false).`);
    else if (def.kind === 'equipment' && def.stack) errors.push(`${label} is equipment, which never stacks.`);
    if (def.slot !== null && !nonBlank(def.slot)) errors.push(`${label} has a slot that is neither empty nor a name.`);
    if (!isPlainObject(def.stats)) errors.push(`${label} has stats that are not a record.`);
    if (!isPlainObject(def.effect)) errors.push(`${label} has an effect that is not a record.`);
    if (!Array.isArray(def.tags) || def.tags.some(tag => typeof tag !== 'string')) errors.push(`${label} has tags that are not a list of words.`);
    if (typeof def.note !== 'string') errors.push(`${label} has a note that is not text.`);
    return errors;
}

/** §2.5 validator for the inventory slice: [] when fine, else plain sentences. */
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
    return errors;
}

// ---------- shared pieces of the handlers ----------

const told = ctx => ctx.cause !== 'story';
export const itemText = (name, qty) => (qty === 1 ? name : `${name} ×${qty}`);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Taking from several stacks of one item: loose ones before worn ones, the party's first, then by ID.
const takeOrder = (a, b) => (a.equipped === null ? 0 : 1) - (b.equipped === null ? 0 : 1)
    || (a.owner === 'party' ? 0 : 1) - (b.owner === 'party' ? 0 : 1) || byId(a, b);

function stackIn(ctx, inv, id) {
    const stack = typeof id === 'string' ? inv.stacks[id] : null;
    if (!stack) ctx.fail('NOT_FOUND', 'That item is no longer in the inventory.');
    return stack;
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

function addStack(ctx, inv, def, qty, owner, note) {
    const id = newId(ctx, 'it', taken => Boolean(inv.stacks[taken]));
    inv.stacks[id] = { id, def, qty, owner, equipped: null, note, from: typeof ctx.receiptId === 'string' ? ctx.receiptId : '' };
    return id;
}

function looseMatch(inv, def, owner, note, except = null) {
    return Object.values(inv.stacks).sort(byId)
        .find(stack => stack.id !== except && stack.def === def && stack.owner === owner && stack.equipped === null && stack.note === note) ?? null;
}

/** Puts `qty` of a def with an owner: onto a matching loose stack when it stacks, else new stacks. */
function grantInto(ctx, inv, def, qty, owner, note) {
    if (def.stack) {
        const same = looseMatch(inv, def.id, owner, note);
        if (same) {
            same.qty += qty;
            return [same.id];
        }
        return [addStack(ctx, inv, def.id, qty, owner, note)];
    }
    if (qty > MAX_UNSTACKED) ctx.fail('INVALID', `${def.name} does not stack; at most ${MAX_UNSTACKED} can be given at once.`);
    return Array.from({ length: qty }, () => addStack(ctx, inv, def.id, 1, owner, note));
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

// A new def through the `item.define(def, { note, owner })` hooks (each may mutate the def or
// return fields to merge), then stored with its name as an alias. `keep` = fields the caller set
// that the hooks may not change; the ID is never theirs to change, and equipment never stacks.
// A hook that throws leaves the def as it was before that hook and goes to the Problems list: one
// module's bug never stops the item being gained.
function addDef(inv, def, env, about, keep = {}) {
    const id = def.id;
    const hooks = env.hookEntries?.('item.define') ?? env.hooks('item.define').map(fn => ({ moduleId: null, fn }));
    for (const { moduleId, fn } of hooks) {
        const before = clone(def);
        try {
            const out = fn(def, { note: about.note ?? '', owner: about.owner ?? 'party' });
            if (isPlainObject(out) && out !== def) Object.assign(def, out);
        } catch (error) {
            for (const key of Object.keys(def)) delete def[key];
            Object.assign(def, before);
            env.problem?.({ module: moduleId, code: 'FAILED', message: `item.define failed on "${def.name}": ${error?.message ?? error}. The item keeps the rules it had before.` });
        }
    }
    Object.assign(def, keep, { id });
    if (def.kind === 'equipment') def.stack = false;   // MODULES.md F6
    inv.defs[id] = clone(def);
    inv.aliases[aliasKey(def.name)] ??= id;
    return inv.defs[id];
}

/** The def a name means, created as `story/<slug>` with the §7 defaults when there is none. */
function defineByName(ctx, inv, written, env, about = {}) {
    const name = cleanName(written);
    if (!name || name.length > MAX_NAME) ctx.fail('INVALID', `An item needs a name of 1 to ${MAX_NAME} characters.`);
    const found = resolveDef(inv, name);
    if (found.status === 'ambiguous') ctx.fail('INVALID', ambiguous(inv, name, found.ids));
    if (found.status === 'found') return { def: inv.defs[found.id], created: false };
    const packed = packDef(ctx, inv, name, env);
    if (packed) return packed;
    const def = defaultDef(freeId(inv, `story/${slugify(name)}`), name);
    return { def: addDef(inv, def, env, about), created: true };
}

// The `item.resolve(name)` hooks (packs, MODULES §E): a pack's def for a name the inventory does
// not know yet, taken as the pack wrote it (its numbers are the rules; item.define does not run),
// with the written name kept as an alias. The first hook that answers wins.
function packDef(ctx, inv, name, env) {
    for (const hook of env.hooks('item.resolve')) {
        let found;
        try { found = hook(name); } catch { found = null; }
        if (!isPlainObject(found) || typeof found.id !== 'string' || !DEF_ID.test(found.id) || !cleanName(found.name)) continue;
        const known = inv.defs[found.id];
        const def = known ?? defaultDef(found.id, cleanName(found.name));
        if (!known) {
            for (const field of Object.keys(def)) if (field !== 'id' && found[field] !== undefined && found[field] !== null) def[field] = clone(found[field]);
            if (def.kind === 'equipment') def.stack = false;   // MODULES.md F6
            inv.defs[def.id] = def;
            inv.aliases[aliasKey(def.name)] ??= def.id;
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
    if (typeof given.id === 'string' && inv.defs[given.id]) return { def: inv.defs[given.id], created: false };
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
    return { def: addDef(inv, def, env, about, keep), created: true };
}

function receive(ctx, env, { owner, amount, note }) {
    const inv = ctx.draft('inventory');
    const currency = currencyOf(ctx.settings());
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
    const currency = currencyOf(ctx.settings());
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

// ---------- commands ----------

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
            const stacks = grantInto(ctx, inv, def, qty, owner, note);
            return {
                summary: `${capitalize(ownerNameIn(ctx, owner))} gains ${itemText(def.name, qty)}.`,
                data: { def: def.id, qty, owner, stacks, created },
                narrate: told(ctx),
            };
        },

        'inventory.consume'(ctx, payload = {}) {
            const inv = ctx.draft('inventory');
            const qty = count(ctx, payload.qty, 1);
            let def;
            let stacks;
            if (payload.stack !== undefined) {
                const stack = stackIn(ctx, inv, payload.stack);
                def = inv.defs[stack.def];
                stacks = [stack];
            } else if (payload.def !== undefined) {
                def = typeof payload.def === 'string' ? inv.defs[payload.def] : null;
                if (!def) ctx.fail('NOT_FOUND', 'There is no such item.');
                stacks = stacksOf(inv, def.id, payload.owner === undefined ? null : ownerArg(ctx, payload.owner));
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
            const def = inv.defs[stack.def];
            if (payload.to === undefined || payload.to === null) ctx.fail('INVALID', 'Say who should get it.');
            const to = receiverArg(ctx, payload.to);
            const from = stack.owner;
            if (to === from) ctx.fail('REFUSED', `${def.name} is already with ${ownerNameIn(ctx, to)}.`);
            const qty = count(ctx, payload.qty, stack.qty);
            if (qty > stack.qty) ctx.fail('NOT_ENOUGH', shortOf(def.name, stack.qty));
            const target = def.stack ? looseMatch(inv, def.id, to, stack.note) : null;
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
                    moved = target.id;
                } else moved = addStack(ctx, inv, def.id, qty, to, note);
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
            const def = inv.defs[stack.def];
            const qty = count(ctx, payload.qty, stack.qty);
            if (qty > stack.qty) ctx.fail('NOT_ENOUGH', shortOf(def.name, stack.qty));
            const owner = stack.owner;
            take(inv, stack, qty);
            return {
                summary: `${capitalize(ownerNameIn(ctx, owner))} drops ${itemText(def.name, qty)}.`,
                data: { def: def.id, qty, owner, stack: stack.id },
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
            const occupant = Object.values(inv.stacks).find(other => other.id !== stack.id && other.owner === stack.owner && other.equipped === where);
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
            const def = inv.defs[stack.def];
            if (stack.qty < 2) ctx.fail('REFUSED', `There is only one ${def.name}; it cannot be split.`);
            const qty = payload.qty;
            if (!isCount(qty, 1) || qty >= stack.qty) ctx.fail('INVALID', `Split off between 1 and ${stack.qty - 1} ${def.name}.`);
            stack.qty -= qty;
            const made = addStack(ctx, inv, def.id, qty, stack.owner, stack.note);
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
            const def = inv.defs[stack.def];
            if (stack.id === into.id) ctx.fail('INVALID', 'A stack cannot be put together with itself.');
            if (stack.def !== into.def) ctx.fail('REFUSED', `${def.name} and ${inv.defs[into.def].name} are different items.`);
            if (!def.stack) ctx.fail('REFUSED', `${def.name} does not stack.`);
            if (stack.owner !== into.owner) ctx.fail('REFUSED', `These ${def.name} are held by different owners.`);
            if (stack.equipped !== into.equipped) ctx.fail('REFUSED', `One ${def.name} is worn and the other is not.`);
            if (stack.note !== into.note) ctx.fail('REFUSED', `These ${def.name} have different notes.`);
            into.qty += stack.qty;
            delete inv.stacks[stack.id];
            return {
                summary: `${def.name} put together (${into.qty}).`,
                data: { stack: stack.id, into: into.id, qty: into.qty },
                narrate: false,
            };
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

        // `story: true` (a module's call during a reply's capture): money the story alone vouched for (a
        // quest the story closed with nothing code could count). It is held to the same per-reply coin
        // budget as the story's own coin lines, but never refused: past the budget what is left is paid,
        // which may be nothing; `data.amount` is what was paid and `problem` (a LIMITED note) says why.
        // Outside a story capture, or without the flag, a module's payout is not counted.
        'wallet.receive'(ctx, payload = {}) {
            byModule(ctx, 'Money cannot be handed out from a button; it comes from the story or from another module\'s action.');
            if (payload.story !== undefined && typeof payload.story !== 'boolean') ctx.fail('INVALID', 'story must be true or false.');
            const args = {
                owner: receiverArg(ctx, payload.owner),
                amount: count(ctx, payload.amount, undefined, 'amount'),
                note: textArg(ctx, payload.note, 120, 'note'),
            };
            return payload.story === true && ctx.caller ? receiveStory(ctx, env, args, undefined, true) : receive(ctx, env, args);
        },
    };
}

// ---------- capture (§4.4): runs as a story command ----------

// What one reply's story lines may make out of nothing (B1-2). Code's own payouts (a module's
// wallet.receive or inventory.grant through ctx.call) are not counted here, except a payout a module
// says the story alone vouched for (`wallet.receive { story: true }`, below).
// * Coin: `storyCoinPerReply` in Story Block's settings, or with 0 (the default) the top reward of the
//   quest rank for the player character's level (`quest.ranks` and `party.pc`, when modules answer),
//   else 1000 × that level. Past it a line is paid what is left, and the Problems list says so.
// * Items: at most STORY_ITEM_QTY of one item per reply, however many lines name it (so a line repeated
//   is counted together), and goods worth at most STORY_WORTH_TIMES × the coin budget in all (each
//   def's `value` × the count given), so many kinds of item cannot add up to more than the coin limit.
//   Past either, a line gives what is left, and the Problems list says so. A `~ item … | qty:` that
//   raises a count is a gain, counted the same way; lowering one is free.
// * A notable item: the first `+ item` line of a reply whose one item is worth more than the goods
//   budget has left (so none of it would fit) is given outside the worth tally, up to
//   STORY_NOTABLE_TIMES × the goods budget (value × count; the count is clamped to fit). "The old man
//   hands you a potion" is a normal story moment even when that potion is worth more than a reply's
//   goods. One per reply: a later line over the budget is held as above. An item worth more than the
//   notable limit on its own is not notable, and is refused as above.
// * New kinds: at most STORY_NEW_DEFS item definitions made by one reply's story lines; past that a
//   line naming something new is refused.
// The tally is kept in the inventory slice under the reply's record ID (`perReply[<sid>]` =
// { coin, worth, made, items, notable }, ctx.carrier.sid, which stays with the reply when earlier messages are
// deleted), so it rolls back with the reply and starts again on the next one or another swipe. A reply
// adds its own entry and drops the others; `perReply` is the domain's `scratch` (ops.js): on replay a
// drop of an entry already gone (its reply deleted) is passed over, so no reply's gains hang on another's.
export const STORY_ITEM_QTY = 20;
export const STORY_COIN_PER_LEVEL = 1000;
export const STORY_WORTH_TIMES = 2;
export const STORY_NEW_DEFS = 10;
export const STORY_NOTABLE_TIMES = 5;

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

function storyCoinBudget(ctx) {
    const set = Number(ctx.settings()?.storyCoinPerReply);
    if (Number.isSafeInteger(set) && set > 0) return set;
    let level = 1;
    try {
        const pc = ctx.query('party.pc');
        if (Number.isSafeInteger(pc?.level) && pc.level > 0) level = pc.level;
    } catch { /* no party module: level 1 */ }
    const topFor = ranks => {
        const rank = Array.isArray(ranks) ? ranks.find(r => Array.isArray(r?.levels) && level >= r.levels[0] && level <= r.levels[1]) : null;
        const top = rank?.reward?.[1];
        return Number.isSafeInteger(top) && top > 0 ? top : null;
    };
    try {
        const top = topFor(ctx.query('quest.ranks'));
        if (top) return top;
    } catch { /* no quest module: the pack's own ladder, else by level */ }
    // Without a quest module, the first enabled pack's own rank ladder (as written, never scaled).
    try {
        const records = ctx.query('packs.content', { kind: 'ranks' });
        const first = Array.isArray(records) && records.length ? records[0]?.pack : null;
        const top = topFor(Array.isArray(records) ? records.filter(record => record?.pack === first) : null);
        if (top) return top;
    } catch { /* no packs part: by level */ }
    // The built-in fallback is gold-scale: the money scale brings it to the chat's coin.
    let scale = 1;
    try { scale = ctx.query('inventory.economy')?.scale ?? 1; } catch { /* no economy query: as written */ }
    return scaledDefault(STORY_COIN_PER_LEVEL * level, scale);
}

const tallied = value => (isCount(value, 0) ? value : 0);

// A copy of the tally for this reply (a fresh one when none is stored); null outside a story capture. A
// module's own call is counted only when it says the story vouched for it (`vouched`). Kept with keepTally.
function tallyOf(ctx, inv, vouched = false) {
    const id = ctx.carrier?.sid ?? ctx.carrier?.key;
    if (ctx.cause !== 'story' || typeof id !== 'string' || !id || (ctx.caller && !vouched)) return null;
    const stored = isPlainObject(inv.perReply) && Object.hasOwn(inv.perReply, id) && isPlainObject(inv.perReply[id]) ? inv.perReply[id] : null;
    const tally = { id, coin: tallied(stored?.coin), worth: tallied(stored?.worth), made: tallied(stored?.made), items: {}, ...(stored?.notable === true ? { notable: true } : {}) };
    for (const [def, n] of Object.entries(isPlainObject(stored?.items) ? stored.items : {})) if (isCount(n, 0)) tally.items[def] = n;
    return tally;
}

// This reply's entry, alone: other replies' entries (and an older shape's fields) go.
function keepTally(inv, { id, ...tally }) {
    if (!isPlainObject(inv.perReply)) inv.perReply = {};
    for (const key of Object.keys(inv.perReply)) if (key !== id) delete inv.perReply[key];
    inv.perReply[id] = tally;
}

// `amount` held to what this reply may still give: { amount, problem }.
function storyCoin(ctx, inv, amount, currency, vouched = false) {
    const tally = tallyOf(ctx, inv, vouched);
    if (!tally) return { amount, problem: null };
    const budget = storyCoinBudget(ctx);
    const left = Math.max(0, budget - tally.coin);
    // A module's vouched payout is never refused (its caller cannot catch a sub-command's failure): it
    // is paid what is left, which may be nothing, and told so.
    if (!left && !vouched) ctx.fail('REFUSED', `This reply has already given all the money one reply may give (${formatAmount(budget, currency)}); the rest was not paid.`);
    const paid = Math.min(amount, left);
    tally.coin += paid;
    keepTally(inv, tally);
    return {
        amount: paid,
        problem: paid < amount ? `${formatAmount(amount, currency)} was written, but one reply may give at most ${formatAmount(budget, currency)}; ${formatAmount(paid, currency)} was paid.` : null,
    };
}

// `qty` of a def held to what this reply may still give (of that item, in worth, and, when the def is
// new, in kinds): { qty, problem, notable }. Refused when nothing may be given. Only a `+ item` line
// (not `more`, a raised count) may be the reply's notable item.
function storyItems(ctx, inv, def, qty, created = false, more = false) {
    const tally = tallyOf(ctx, inv);
    if (!tally) return { qty, problem: null, notable: false };
    if (created) {
        if (tally.made >= STORY_NEW_DEFS) ctx.fail('REFUSED', `This reply has already brought ${STORY_NEW_DEFS} new kinds of item into the story, the most one reply may; ${def.name} was not added.`);
        tally.made += 1;
    }
    const had = tally.items[def.id] ?? 0;
    const left = Math.max(0, STORY_ITEM_QTY - had);
    if (!left) ctx.fail('REFUSED', `This reply has already given ${STORY_ITEM_QTY} ${def.name}, the most one reply may give of one item.`);
    let given = Math.min(qty, left);
    const limits = given < qty ? [`at most ${STORY_ITEM_QTY} of one item`] : [];
    const value = isCount(def.value, 1) ? def.value : 0;
    let notable = false;
    if (value) {
        const currency = currencyOf(ctx.settings());
        const cap = STORY_WORTH_TIMES * storyCoinBudget(ctx);
        const fits = Math.floor(Math.max(0, cap - tally.worth) / value);
        const gift = STORY_NOTABLE_TIMES * cap;
        if (!fits && !more && !tally.notable && value <= gift) {
            // The reply's notable item: not counted in the worth tally, held to its own limit.
            notable = true;
            tally.notable = true;
            const room = Math.floor(gift / value);
            if (room < given) {
                given = room;
                limits.push(`one notable item worth at most ${formatAmount(gift, currency)}`);
            }
        } else {
            if (!fits) {
                ctx.fail('REFUSED', `This reply has already given goods worth ${formatAmount(tally.worth, currency)}, and one ${def.name} is worth ${formatAmount(value, currency)}; one reply may give goods worth at most ${formatAmount(cap, currency)}.`);
            }
            if (fits < given) {
                given = fits;
                limits.push(`goods worth at most ${formatAmount(cap, currency)} in all`);
            }
            tally.worth += given * value;
        }
    }
    tally.items[def.id] = had + given;
    keepTally(inv, tally);
    return {
        qty: given,
        notable,
        problem: given < qty ? `${itemText(def.name, qty)}${more ? ' more' : ''} was written, but one reply may give ${limits.join(' and ')}; ${given} ${given === 1 ? 'was' : 'were'} given.` : null,
    };
}

// The carry limit, when a module keeps one (`items.carry`, MODULES §F39): adding `qty` of `def` to
// `owner` that would go over it is refused with the module's reason. No module answering: no limit.
function storyCarry(ctx, def, qty, owner) {
    let fits = null;
    try {
        fits = ctx.query('items.carry', { owner, add: [{ defId: def.id, qty }] });
    } catch {
        return;
    }
    if (fits && fits.ok === false) {
        ctx.fail('REFUSED', typeof fits.message === 'string' && fits.message ? fits.message : `There is no room to carry more ${def.name}.`);
    }
}

function lineQty(ctx, line, fallback) {
    const written = labelOf(line, 'qty', 'quantity', 'count');
    if (written === null) return fallback;
    const n = parseCount(written);
    if (n === null) ctx.fail('INVALID', `"${written}" is not a quantity.`);
    return n;
}

// A consumable the story says was used (MODULES §F96): `- item Potion | used: yes`, or a used-word in
// the line or the reply, and no word that says it went another way. Copied from RPG Battle's
// items/story-use.js (usedByLine), so both read a line the same way.
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

/** `+ item Name | qty | note`, `- item Name | qty`, `~ item Name | note | qty | name` (a rename). */
export function captureItem(ctx, line, env) {
    const inv = ctx.draft('inventory');
    const name = cleanName(line?.name);
    if (!name) ctx.fail('INVALID', 'An item line needs the item\'s name.');
    const text = String(line.text ?? '').trim();
    // An "item" named exactly the currency (singular or plural) is money: it goes to the wallet.
    const currency = currencyOf(ctx.settings());
    if (isCurrencyName(name, currency)) return itemAsCoin(ctx, line, env, currency);
    if (line.op === '+') {
        const qty = lineQty(ctx, line, 1);
        if (qty < 1) ctx.fail('INVALID', 'A gained item needs a quantity of at least 1.');
        const note = trimText(labelOf(line, 'note') ?? text, MAX_NOTE);
        const { def, created } = defineByName(ctx, inv, name, env, { note, owner: 'party' });
        const held = storyItems(ctx, inv, def, qty, created);
        const stacks = grantInto(ctx, inv, def, held.qty, 'party', note);
        return {
            summary: held.notable
                ? `The party gains ${itemText(def.name, held.qty)} (notable gift: ${def.name}, outside this reply's goods budget).`
                : `The party gains ${itemText(def.name, held.qty)}.`,
            data: { def: def.id, qty: held.qty, owner: 'party', stacks, created, from: labelOf(line, 'from') ?? '', ...(held.notable ? { notable: true } : {}) },
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
        const held = stacksOf(inv, def.id);
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
        const rename = labelOf(line, 'name', 'rename');
        if (rename !== null && cleanName(rename) && cleanName(rename) !== def.name) {
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
        const note = labelOf(line, 'note') ?? (text || null);
        const qty = labelOf(line, 'qty', 'quantity', 'count') === null ? null : lineQty(ctx, line, null);
        let problem = null;
        if (note !== null || qty !== null) {
            const held = stacksOf(inv, def.id);
            if (!held.length) ctx.fail('NOT_FOUND', `There is no ${def.name} in the inventory.`);
            if (held.length > 1) ctx.fail('INVALID', `There are several lots of ${def.name}; the line cannot say which one changed.`);
            const stack = held[0];
            if (note !== null) {
                stack.note = trimText(note, MAX_NOTE);
                changes.push(`${def.name}: ${stack.note || 'note cleared'}`);
            }
            if (qty !== null) {
                if (qty > 1 && !def.stack) ctx.fail('REFUSED', `${def.name} does not stack.`);
                if (qty === 0) delete inv.stacks[stack.id];
                else if (qty > stack.qty) {
                    // A raised count is a gain (r2-1): held to the reply's story limits and the carry limit.
                    const held = storyItems(ctx, inv, def, qty - stack.qty, false, true);
                    storyCarry(ctx, def, held.qty, stack.owner);
                    stack.qty += held.qty;
                    problem = held.problem;
                } else stack.qty = qty;
                changes.push(`${def.name} now ${qty === 0 ? 0 : stack.qty}`);
            }
        }
        if (!changes.length) ctx.fail('INVALID', `The line changes nothing about ${def.name}.`);
        return { summary: `${changes.join('; ')}.`, data: { def: def.id }, narrate: false, ...(problem ? { problem } : {}) };
    }
    return ctx.fail('INVALID', `"${line.op} item" is not a change the inventory understands; use +, - or ~.`);
}

// `+ item Marks | qty: 44`, `- item mark`: the party's wallet, as `+ coin 44` / `- coin 1` would.
function itemAsCoin(ctx, line, env, currency) {
    if (line.op !== '+' && line.op !== '-') {
        ctx.fail('INVALID', `${currency.plural} are money, not an item; write + coin or - coin with the amount.`);
    }
    const amount = lineQty(ctx, line, 1);
    if (amount < 1) ctx.fail('INVALID', 'An amount of money must be more than nothing.');
    const who = labelOf(line, line.op === '+' ? 'from' : 'to');
    const note = who ? `${line.op === '+' ? 'from' : 'to'} ${trimText(who, 80)}` : '';
    return line.op === '+'
        ? receiveStory(ctx, env, { owner: 'party', amount, note }, currency)
        : pay(ctx, env, { owner: 'party', amount, note });
}

// A story line's money, held to the reply's budget (storyCoin); `vouched` for a module's payout
// that the story alone vouched for (wallet.receive { story: true }).
function receiveStory(ctx, env, { owner, amount, note }, currency = currencyOf(ctx.settings()), vouched = false) {
    const held = storyCoin(ctx, ctx.draft('inventory'), amount, currency, vouched);
    const out = receive(ctx, env, { owner, amount: held.amount, note });
    return held.problem ? { ...out, problem: held.problem } : out;
}

/** `+ coin 30 | from: who`, `- coin 5 | to: who`: the party's wallet; only the number counts. */
export function captureCoin(ctx, line, env) {
    const written = labelOf(line, 'amount') ?? String(line?.name ?? '');
    if (line?.op !== '+' && line?.op !== '-') {
        ctx.fail('INVALID', `"${line?.op} coin" is not a change the wallet understands; use + coin or - coin.`);
    }
    const parsed = parseAmount(written);
    if (parsed.error) ctx.fail('INVALID', parsed.error);
    const who = labelOf(line, line.op === '+' ? 'from' : 'to');
    const note = who ? `${line.op === '+' ? 'from' : 'to'} ${trimText(who, 80)}` : '';
    return line.op === '+'
        ? receiveStory(ctx, env, { owner: 'party', amount: parsed.amount, note })
        : pay(ctx, env, { owner: 'party', amount: parsed.amount, note });
}

// ---------- queries (read-only, plain copies) ----------

const ownerRank = owner => (owner === 'party' ? 0 : 1);
const kindRank = kind => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length);

/** Stacks joined with their defs, the party's first, then by kind, name and ID. */
export function listItems(inventory, owner = null) {
    const defs = inventory?.defs ?? {};
    return Object.values(inventory?.stacks ?? {})
        .filter(stack => defs[stack.def] && (owner === null || stack.owner === owner))
        .map(stack => {
            const def = defs[stack.def];
            return {
                stack: stack.id, def: def.id, name: def.name, kind: def.kind, rarity: def.rarity, value: def.value,
                slot: def.slot, qty: stack.qty, owner: stack.owner, equipped: stack.equipped, note: stack.note, from: stack.from,
            };
        })
        .sort((a, b) => ownerRank(a.owner) - ownerRank(b.owner) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0)
            || kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name, 'en', { numeric: true })
            || (a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0));
}

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
    'inventory.currency': () => currencyOf(env.settings()),
    'inventory.items': (state, args = {}) => listItems(state?.domains?.inventory, args?.owner ?? null),
    'inventory.wallet': (state, args = {}) => ({ ...(state?.domains?.inventory?.wallets?.[args?.owner ?? 'party'] ?? {}) }),
    // { status: 'found' | 'ambiguous' | 'none', defs: [def copies], stacks: [items of the found def] }
    'inventory.find': (state, args = {}) => {
        const inventory = state?.domains?.inventory;
        const found = resolveDef(inventory, args?.name ?? '');
        return {
            status: found.status,
            defs: found.ids.map(id => clone(inventory.defs[id])),
            stacks: found.status === 'found' ? listItems(inventory).filter(item => item.def === found.id) : [],
        };
    },
});

// ---------- prompt view (§5) ----------

function itemPhrase(item) {
    const note = item.note ? ` (${trimText(item.note, 40)})` : '';
    return `${itemText(item.name, item.qty)}${note}`;
}

function owners(items) {
    return [...new Set(items.map(item => item.owner))];
}

const LINE_MAX = 200;

// Phrases packed into "Label: a, b, c" lines of at most LINE_MAX characters, using at most
// `room` characters in all (a newline counted per line): { lines, taken, used }.
function pack(label, phrases, room) {
    const lines = [];
    let current = '';
    let used = 0;
    let taken = 0;
    while (taken < phrases.length) {
        const piece = current ? `, ${phrases[taken]}` : `${label}: ${phrases[taken]}`;
        if (current && current.length + piece.length > LINE_MAX) {
            lines.push(current);
            used += current.length + 1;
            current = '';
            continue;
        }
        if (used + current.length + piece.length + 1 > room) break;
        current += piece;
        taken += 1;
    }
    if (current) {
        lines.push(current);
        used += current.length + 1;
    }
    return { lines, taken, used };
}

/**
 * The inventory's tail: what is worn and the wallet always; carried items in `lines` while
 * they fit in `chars` characters, the rest in `optional` (dropped first by the host) up to
 * `optionalChars`, then a count of what is left out.
 */
export function inventoryTail(state, { currency, chars, optionalChars }) {
    const inventory = state?.domains?.inventory;
    const items = listItems(inventory);
    const lines = [];
    const optional = [];
    for (const owner of owners(items.filter(item => item.equipped !== null))) {
        const worn = items.filter(item => item.owner === owner && item.equipped !== null)
            .map(item => `${itemText(item.name, item.qty)} [${item.equipped}]`);
        lines.push(`Equipped${owner === 'party' ? '' : ` (${ownerName(state, owner)})`}: ${worn.join(', ')}`);
    }
    const wallets = inventory?.wallets ?? {};
    const purse = [formatWallet(wallets.party, currency)];
    for (const owner of Object.keys(wallets).filter(key => key !== 'party').sort()) {
        if (Object.values(wallets[owner]).some(Boolean)) purse.push(`${ownerName(state, owner)} ${formatWallet(wallets[owner], currency)}`);
    }
    lines.push(`Wallet: ${purse.join('; ')}`);
    const carried = items.filter(item => item.equipped === null);
    if (!carried.length) {
        lines.push('Carried: nothing');
        return { lines, optional };
    }
    let room = chars - lines.reduce((sum, line) => sum + line.length + 1, 0);
    let spare = optionalChars;
    let left = 0;
    for (const owner of owners(carried)) {
        const label = owner === 'party' ? 'Carried' : `Carried (${ownerName(state, owner)})`;
        const phrases = carried.filter(item => item.owner === owner).map(itemPhrase);
        const main = pack(label, phrases, Math.max(0, room));
        lines.push(...main.lines);
        room -= main.used;
        const more = pack(`Also ${label.toLowerCase()}`, phrases.slice(main.taken), Math.max(0, spare));
        optional.push(...more.lines);
        spare -= more.used;
        left += phrases.length - main.taken - more.taken;
    }
    if (left) optional.push(`…and ${left} more item${left === 1 ? '' : 's'}.`);
    return { lines, optional };
}
