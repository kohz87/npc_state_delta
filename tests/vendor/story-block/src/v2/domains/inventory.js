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
import { WALLET_KEY, coinValue, countedMoney, currencyOf, formatAmount, formatWallet, isCurrencyName, parseAmount } from './money.js';
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

// The optional mechanics this domain owns (MODULES §F100), declared by the core module. A host without
// the Features API ignores the list and every check below takes them as on.
export const FEATURE = Object.freeze({ loot: 'story-block.loot', encumbrance: 'story-block.encumbrance' });
export const INVENTORY_FEATURES = Object.freeze([
    Object.freeze({
        id: FEATURE.loot, label: 'Pick what you take', default: true,
        describe: 'The story can lay out loot (? loot A, B, C — where); the reply\'s card shows it as chips and you take the ones you want.',
    }),
    Object.freeze({
        id: FEATURE.encumbrance, label: 'Encumbered', default: true,
        describe: 'What the story gives past the carry limit is kept, and the party is encumbered (a check penalty) until something is put down. Your own buys and takes are still refused.',
    }),
]);

/** Whether a feature is on for this handler (or view): on when the host has no Features API. */
export function featureOn(ctx, id) {
    try {
        return typeof ctx?.feature === 'function' ? ctx.feature(id) !== false : true;
    } catch {
        return true;
    }
}

// A stack's condition (gear wear): 0 (broken) to 100 (as new). It is never stored as the truth: each
// wear or repair is an event of its own, `condLog[<stack>]['<sid>#<n>'] = { d, n }` (d: the change asked
// for, −100…100; n: the rev it was written at), keyed by the reply that wrote it and only added (SPEC
// §2.2). The condition is 100 (or an older chat's plain `stack.cond`, read as where it starts) folded
// through the events in rev order, held to 0…100 at each step. Deleting a reply from the middle then
// takes exactly its events away, and nothing can go out of range. `condLog` is scratch, like perReply:
// on replay a missing piece of it is made and a drop of something gone is passed over.
export const COND_MAX = 100;
// The events one stack keeps before they are folded into one (the stack's own history is then the fold).
export const COND_LOG_MAX = 40;
const clampCond = value => Math.max(0, Math.min(COND_MAX, value));

/** A stack's condition events in the order they apply: [{ key, d, n }]. */
export function condEvents(inventory, stackId) {
    const log = isPlainObject(inventory?.condLog) && typeof stackId === 'string' && Object.hasOwn(inventory.condLog, stackId) ? inventory.condLog[stackId] : null;
    if (!isPlainObject(log)) return [];
    return Object.entries(log)
        .filter(([, event]) => isPlainObject(event) && Number.isSafeInteger(event.d) && Number.isSafeInteger(event.n))
        .map(([key, event]) => ({ key, d: event.d, n: event.n }))
        .sort((a, b) => a.n - b.n || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A stack's condition, 0…100: where it starts (100, or an older plain `cond`) folded through its events. */
export function condOf(stack, inventory = null) {
    let cond = Number.isSafeInteger(stack?.cond) ? clampCond(stack.cond) : COND_MAX;
    for (const event of condEvents(inventory, stack?.id)) cond = clampCond(cond + event.d);
    return cond;
}

// Adds one condition event (`d`) to a stack, as this reply's (or this receipt's) own key, and returns
// the condition now. Back at 100 the stack's events (and an older plain `cond`) are dropped by key; past
// COND_LOG_MAX events they are folded into one. Logs of stacks no longer there are dropped too (a stack a
// deleted reply had dropped, back on replay, starts as new then).
function condWrite(ctx, inv, stack, d) {
    if (!isPlainObject(inv.condLog)) inv.condLog = {};
    for (const id of Object.keys(inv.condLog)) if (!isPlainObject(inv.stacks[id])) delete inv.condLog[id];
    if (!isPlainObject(inv.condLog[stack.id])) inv.condLog[stack.id] = {};
    const log = inv.condLog[stack.id];
    const owner = typeof ctx.carrier?.sid === 'string' && ctx.carrier.sid ? ctx.carrier.sid : String(ctx.receiptId ?? 'rc');
    let k = 1;
    while (Object.hasOwn(log, `${owner}#${k}`)) k += 1;
    const n = Number.isSafeInteger(ctx.rev) ? ctx.rev : 0;
    log[`${owner}#${k}`] = { d, n };
    const now = condOf(stack, inv);
    // Only keys go, never the records that hold them: a record a later reply finds missing is written
    // whole, and replayed after a middle delete that whole write would put back or drop other replies'
    // events. (A stack's whole log goes only once the stack itself is gone.)
    if (now === COND_MAX) {
        for (const key of Object.keys(log)) delete log[key];
        delete stack.cond;
    } else if (Object.keys(log).length > COND_LOG_MAX) {
        const start = Number.isSafeInteger(stack.cond) ? clampCond(stack.cond) : COND_MAX;
        for (const key of Object.keys(log)) delete log[key];
        log[`${owner}#${k}`] = { d: now - start, n };
    }
    return now;
}

function condLogErrors(condLog) {
    if (!isPlainObject(condLog)) return ['The condition log is not a record.'];
    const errors = [];
    for (const [stackId, log] of Object.entries(condLog)) {
        if (!isPlainObject(log)) { errors.push(`The condition log of ${stackId} is not a record.`); continue; }
        for (const [key, event] of Object.entries(log)) {
            if (!isPlainObject(event) || !Number.isSafeInteger(event.d) || Math.abs(event.d) > COND_MAX || !Number.isSafeInteger(event.n)) {
                errors.push(`The condition event ${key} of ${stackId} needs a change from -${COND_MAX} to ${COND_MAX} and its rev.`);
            }
        }
    }
    return errors;
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
    if (def.carry !== undefined && !(isCount(def.carry, 1) && def.carry <= CARRY_MAX)) errors.push(`${label} adds a carry capacity of ${def.carry}; it is a whole number from 1 to ${CARRY_MAX}.`);
    return errors;
}

// The carry capacity a def may add (PACKS.md "Carry capacity"): only a pack's item has one, so the story's
// words never make or raise it (WAVE rule 1); a carry module (RPG Battle's items.carry) reads it.
export const CARRY_MAX = 1000;
const packCarry = (id, value) => (typeof id === 'string' && id.startsWith('pack.') && isCount(value, 1) && value <= CARRY_MAX ? value : null);

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
        if (stack.cond !== undefined && !(Number.isSafeInteger(stack.cond) && stack.cond >= 0 && stack.cond <= COND_MAX)) {
            errors.push(`${label} has a condition of ${stack.cond}; it is a whole number from 0 to ${COND_MAX}.`);
        }
        if (stack.key !== undefined && stack.key !== true) errors.push(`${label} is marked as a key item with something other than true.`);
        if (stack.story !== undefined && stack.story !== true) errors.push(`${label} is marked as the story's with something other than true.`);
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

// A key item (`key: true` on its stack): the one notable item a reply's story gives outside its goods
// budget (storyItems), a stack kept apart from the rest of that item. It is used, worn, given and consumed like any other, but it has no cash value: a module
// that buys things back or counts what they are worth (RPG Battle's trade and crafting) counts it as 0.
// It never joins another stack, nor another stack it (looseMatch, inventory.merge), and the part of it
// that is given away or split off stays a key stack.
// The story's own (`story: true` on its stack, B-a2-2): what a story line (`+ item`) gave, or the reader
// took from a story's loot (`? loot`, inventory.lootTake, FB-2), whatever its def (a pack's item named in
// the story too). inventory.grant never sets it: no story line reaches it (modules and pack events call it
// with what their code chose) and it moves no stack. Its worth was counted in that reply's goods budget, so a
// module that buys things back holds what it pays for it to its worth at the sell rate (RPG Battle's
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
        .find(stack => stack.id !== except && stack.def === def && stack.owner === owner && stack.equipped === null && stack.note === note && condOf(stack, inv) === cond && stack.key !== true) ?? null;
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

function addDef(inv, def, env, about, keep = {}) {
    const id = def.id;
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
            const carry = packCarry(def.id, found.carry);
            if (carry !== null) def.carry = carry;
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
    // A pack item's carry capacity comes with it (a pack shop's stock bought through a module).
    if (packCarry(id, given.carry) !== null) keep.carry = given.carry;
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

// ---------- equipment: who can wear what, and "Equip on…" (MODULES §F99) ----------

// Slots that hold several pieces, each copy under its own key (`accessory-1`, `accessory-2`, as RPG
// Battle's item.equip keys them), with the count when no module says otherwise. Every other slot holds
// one piece. The counts come from the `items.slots` query (RPG Battle's rules: { accessory, worn }, or
// `accessories`), held to 0…MAX_MANY.
export const MANY_SLOTS = Object.freeze({ accessory: 2, worn: 1 });
export const MAX_MANY = 3;

/** The slot a worn stack's key stands for: `accessory-2` → `accessory`. */
export const baseSlot = key => (typeof key === 'string' ? key.trim().replace(/-\d+$/, '') : null);
const keyNumber = key => Number(/-(\d+)$/.exec(String(key ?? ''))?.[1] ?? 0);

function asking(query, name, args) {
    try {
        return query(name, args);
    } catch {
        return undefined;
    }
}

/** The slot counts in force: { accessory, worn } from `items.slots`, else MANY_SLOTS. */
export function slotLimits(query) {
    const given = asking(query, 'items.slots', {});
    const pick = name => {
        const n = isPlainObject(given) ? given[name] ?? given[`${name === 'accessory' ? 'accessories' : `${name}s`}`] : undefined;
        return Number.isSafeInteger(n) ? Math.max(0, Math.min(MAX_MANY, n)) : MANY_SLOTS[name];
    };
    return { accessory: pick('accessory'), worn: pick('worn') };
}

// The party's members, in the party module's order: `party.actors` when a module answers it, else the
// `party` domain's actors (its `order` first). → [{ id, name }]
function membersOf(query, party) {
    const listed = asking(query, 'party.actors', {});
    const raw = Array.isArray(listed)
        ? listed
        : [...(Array.isArray(party?.order) ? party.order : []), ...Object.keys(isPlainObject(party?.actors) ? party.actors : {}).sort()]
            .filter((id, at, all) => all.indexOf(id) === at && isPlainObject(party.actors[id]))
            .map(id => ({ ...party.actors[id], id }));
    const seen = new Set();
    return raw.filter(actor => typeof actor?.id === 'string' && OWNER_RE.test(actor.id) && actor.id !== 'party' && !seen.has(actor.id) && seen.add(actor.id))
        .map(actor => ({ id: actor.id, name: trimText(typeof actor.name === 'string' && actor.name.trim() ? actor.name : actor.id, 60) }));
}

// The main character's id (`party.pc`, else the party domain's `pc`), or null: what the shared bag wears
// is theirs (RPG Battle's rule).
function pcOf(query, party) {
    const pc = asking(query, 'party.pc', {});
    const id = typeof pc?.id === 'string' ? pc.id : typeof party?.pc === 'string' ? party.pc : null;
    return id && OWNER_RE.test(id) && id !== 'party' ? id : null;
}

const wearerOf = (stack, pc) => (stack.owner === 'party' ? pc ?? 'party' : stack.owner);

/**
 * Can `actor` wear `def`? Equipment with a slot, a slot this chat's rules count (an accessory when
 * accessories count), and what a module answering `items.canWear({ actor, defId })` says
 * ({ ok: false, message } refuses). → { ok, message }
 */
export function canWear(query, def, actor, limits, who = actor) {
    if (def?.kind !== 'equipment') return { ok: false, message: `${def?.name ?? 'That'} is not equipment; it cannot be worn or wielded.` };
    if (!nonBlank(def.slot)) return { ok: false, message: `${def.name} has no slot to be worn in.` };
    const base = baseSlot(def.slot);
    if (Object.hasOwn(MANY_SLOTS, base) && limits[base] === 0) {
        return { ok: false, message: `In this chat's rules no ${base === 'accessory' ? 'accessories' : 'worn pieces'} count, so ${def.name} cannot be worn.` };
    }
    const said = asking(query, 'items.canWear', { actor, defId: def.id });
    if (isPlainObject(said) && said.ok === false) {
        return { ok: false, message: typeof said.message === 'string' && said.message ? said.message : `${capitalize(who)} cannot wear ${def.name}.` };
    }
    return { ok: true, message: '' };
}

function readParty(ctx) {
    try {
        return ctx.read('party');
    } catch {
        return null;
    }
}

// `inventory.equipOn { stack, actor }`: one step, the piece goes to that member and on (MODULES §F99).
// What sits in its slot goes back into that member's own carry: for a slot of one piece the piece
// there (a two-handed weapon also puts away the off-hand; an off-hand is refused while a two-handed
// weapon is held); for accessories and worn pieces, once the count is full, the oldest one (the lowest
// key: keys are renumbered in the order the pieces went on, the new one last). A piece someone else
// wears comes off them first. Handing it over follows the carry limit like any hand-over, and so does
// what goes back into their carry (refused with the reason when it does not fit).
function equipOn(ctx, payload) {
    const inv = ctx.draft('inventory');
    const stack = stackIn(ctx, inv, payload.stack);
    const def = inv.defs[stack.def];
    const actor = payload.actor;
    if (typeof actor !== 'string' || !OWNER_RE.test(actor) || actor === 'party') ctx.fail('INVALID', 'Say which member of the party should wear it.');
    if (!ownerKnown(ctx, actor)) ctx.fail('REFUSED', `${actor} is not in the party, so nothing can be given to them.`);
    const query = (name, args) => ctx.query(name, args);
    const who = ownerNameIn(ctx, actor);
    const able = canWear(query, def, actor, slotLimits(query), who);
    if (!able.ok) ctx.fail('REFUSED', able.message);
    const pc = pcOf(query, readParty(ctx));
    if (stack.equipped !== null && wearerOf(stack, pc) === actor) ctx.fail('REFUSED', `${capitalize(who)} already wears ${def.name}.`);
    const from = stack.owner;
    if (from !== actor) readerCarry(ctx, [{ defId: def.id, qty: stack.qty }], actor, true);

    const slot = def.slot.trim();
    const base = baseSlot(slot);
    const worn = Object.values(inv.stacks).filter(other => other.id !== stack.id && other.equipped !== null && wearerOf(other, pc) === actor);
    const off = [];
    let key = slot;
    if (Object.hasOwn(MANY_SLOTS, base)) {
        const limit = slotLimits(query)[base];
        const same = worn.filter(other => baseSlot(other.equipped) === base).sort((a, b) => keyNumber(a.equipped) - keyNumber(b.equipped) || byId(a, b));
        while (same.length >= limit) off.push(same.shift());
        for (const other of off) other.equipped = null;
        same.forEach((other, at) => { other.equipped = `${base}-${at + 1}`; });
        key = `${base}-${same.length + 1}`;
    } else {
        const named = id => inv.defs[id] ?? null;
        if (base === 'offhand') {
            const held = worn.find(other => baseSlot(other.equipped) === 'weapon' && named(other.def)?.tags?.includes('two-handed'));
            if (held) ctx.fail('REFUSED', `${named(held.def).name} is two-handed: put it away before taking up ${def.name}.`);
        }
        off.push(...worn.filter(other => baseSlot(other.equipped) === base));
        if (base === 'weapon' && def.tags?.includes('two-handed')) off.push(...worn.filter(other => baseSlot(other.equipped) === 'offhand'));
        for (const other of off) other.equipped = null;
    }
    // Back into the wearer's own carry (a piece of the shared bag the main character wore too). C3-7:
    // that is a hand-over too, so the carry limit counts it along with the new piece.
    const coming = off.filter(other => other.owner !== actor);
    if (coming.length) {
        const add = [...(from !== actor ? [{ defId: def.id, qty: stack.qty }] : []), ...coming.map(other => ({ defId: other.def, qty: other.qty }))];
        const fits = carryFits(ctx, add, actor, true);
        if (fits && !fits.ok) {
            const names = joinNames(coming.map(other => inv.defs[other.def]?.name ?? other.id));
            ctx.fail('REFUSED', `${capitalize(who)} cannot take ${def.name} with ${names} going back into ${who}'s own pack: ${fits.message}`);
        }
    }
    for (const other of off) other.owner = actor;
    stack.owner = actor;
    stack.equipped = key;
    const away = off.map(other => inv.defs[other.def]?.name ?? other.id);
    const fromText = from !== actor ? ` from ${ownerNameIn(ctx, from)}` : '';
    const awayText = away.length ? `; ${joinNames(away)} ${away.length === 1 ? 'goes' : 'go'} back into ${who}'s pack` : '';
    return {
        summary: `${capitalize(who)} equips ${def.name}${fromText} (${key})${awayText}.`,
        data: { stack: stack.id, def: def.id, actor, from, slot: key, replaced: off.map(other => other.id), replacedNames: away },
        narrate: told(ctx),
    };
}

function joinNames(names) {
    return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---------- gear condition (`cond`, for RPG Battle's wear rules) ----------

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
// module answering `item.wear` (RPG Battle's gear rules: bands, refinement, its own claim) the line goes
// there as `item.wear { name, wear, why, story: true }`; without one Story Block wears the stack itself
// by STORY_WEAR, once per piece per reply. Words and numbers are RPG Battle's (items/condition.js), so
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
    const now = condWrite(ctx, inv, stack, -STORY_WEAR[word]);
    return now === 0 ? `${def.name} is broken` : `${def.name} is ${{ scuff: 'scuffed', tear: 'damaged', ruin: 'badly damaged' }[word]} (${now}/100)`;
}

// ---------- loot to pick from (`story-block.loot`) ----------

// `? loot Rusty Key, Lantern Oil x2, Torn Map — on the cellar shelf | qty: 1`: what lies there, offered
// on the reply's card as chips; the reader takes the ones they want (inventory.lootTake). The offer is
// held to the reply's story limits when it is read (each thing as a `+ item` line would be, never the
// notable one), so the chips show what can be taken; things the party already carries (tolerant
// names) are left out. One offer per reply, keyed by the reply's record ID (`loot[<sid>]`, scratch like
// perReply); a second loot line in the reply adds to it. A reply keeps the LOOT_KEEP newest offers.
export const LOOT_ITEMS = 8;
export const LOOT_KEEP = 5;
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
            || list.some(item => !isPlainObject(item) || !nonBlank(item.name) || item.name.length > MAX_NAME || !isCount(item.qty, 1) || item.qty > STORY_ITEM_QTY
                || (item.coin !== undefined && !isCount(item.coin, 1)))) {
            errors.push(`The loot of reply ${key} needs 1 to ${LOOT_ITEMS} things, each with a name and a quantity of 1 to ${STORY_ITEM_QTY}.`);
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
// the name (held to the story limits after); without one, `fallback`. Money ("1000 gold", "Gold x500",
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
    if (fallback < 1 || fallback > STORY_ITEM_QTY) ctx.fail('INVALID', `A quantity of loot is 1 to ${STORY_ITEM_QTY}.`);
    const parts = String(line.name ?? '').split(/[,;]/).map(part => part.trim()).filter(Boolean);
    if (!parts.length) ctx.fail('INVALID', 'A loot line needs the things that lie there: ? loot Rusty Key, Lantern Oil — where.');
    const before = isPlainObject(inv.loot) && isPlainObject(inv.loot[sid]) ? inv.loot[sid] : null;
    const items = before ? clone(lootItems(before) ?? []) : [];
    const notes = [];
    const currency = currencyOf(ctx.settings());
    // New definitions are worked out on a copy (their value is what the story limits need); the real
    // ones are made only for what the reader takes.
    const scratch = { ...inv, defs: { ...inv.defs }, aliases: { ...inv.aliases } };
    for (const part of parts) {
        const { name: written, qty, money } = lootPart(part, fallback, currency);
        const name = cleanName(written);
        if (!name) continue;
        // Money in a loot line is a coin offer in that loot, held to the reply's coin budget now (as a
        // `+ coin` line would be) and paid into the wallet on Take: never an item, never left out unsaid.
        if (money !== undefined) {
            const purse = items.find(item => item.coin !== undefined);
            if (!purse && items.length >= LOOT_ITEMS) {
                notes.push(`One reply may lay out at most ${LOOT_ITEMS} things to pick from; ${formatAmount(money, currency)} was left out.`);
                continue;
            }
            if (money < 1) { notes.push(`${name}: an amount of money is more than nothing.`); continue; }
            let held;
            try { held = storyCoin(ctx, inv, money, currency); } catch (error) {
                if (typeof error?.code !== 'string') throw error;
                notes.push(error.message);
                continue;
            }
            if (held.problem) notes.push(held.problem);
            if (!held.amount) continue;
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
            let created;
            ({ def, created } = defineByName(ctx, scratch, name, env, { owner: 'party' }));
            if (items.some(item => aliasKey(item.name) === aliasKey(def.name) || resolveDef(scratch, item.name).id === def.id)) { notes.push(`${def.name} is offered once.`); continue; }
            held = storyItems(ctx, inv, def, qty, created, false, false);
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
    let coin = 0;
    for (const at of [...new Set(picks)].sort((a, b) => a - b)) {
        const item = things[at];
        if (item.coin !== undefined) { coin += item.coin; continue; }
        if (owned(inv, item.name)) { skipped.push(item.name); continue; }
        const { def } = defineByName(ctx, inv, item.name, env, { owner: 'party' });
        wanted.push({ def, qty: item.qty });
    }
    if (!wanted.length && !coin) ctx.fail('REFUSED', `${joinNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} already carried.`);
    if (wanted.length) readerCarry(ctx, wanted.map(entry => ({ defId: entry.def.id, qty: entry.qty })), 'party');
    // FB-2: what the story offered is the story's own (`story: true`, as a `+ item` line's), whatever its
    // def (a pack's item named in the `? loot` line): its worth was held to that reply's goods budget.
    const stacks = wanted.flatMap(entry => grantInto(ctx, inv, entry.def, entry.qty, 'party', '', false, true));
    // The money was held to its reply's coin budget when the loot was read: it is paid as held.
    const currency = currencyOf(ctx.settings());
    if (coin) receive(ctx, env, { owner: 'party', amount: coin, note: 'loot' });
    const where = offer.where ? ` (${offer.where})` : '';
    const left = skipped.length ? `; ${joinNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} already carried` : '';
    const took = [...wanted.map(entry => itemText(entry.def.name, entry.qty)), ...(coin ? [formatAmount(coin, currency)] : [])];
    return {
        summary: `The party takes ${joinNames(took)}${where}${left}.`,
        data: { sid, taken: wanted.map(entry => ({ def: entry.def.id, qty: entry.qty })), coin, skipped, stacks },
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
        // wrote). It is held to the same per-reply coin budget as the story's own coin lines, but never
        // refused: past the budget what is left is paid, which may be nothing; `data.amount` is what was
        // paid and `problem` (a LIMITED note) says why. During a capture it counts against the reply being
        // read; outside one (a click after the reply, RX-E-2) against the reply the click is stored on,
        // the head carrier (ctx.reply), so one reply's `+ coin` lines and the clicks after it share one
        // budget. Without the flag, a module's payout is not counted.
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

        // { stack, actor }: move a piece to a member and put it on, in one step (MODULES §F99).
        'inventory.equipOn': (ctx, payload = {}) => equipOn(ctx, payload),
        // { stack, amount }: gear condition down / up, for another module's rules only (ctx.caller).
        'inventory.wear': (ctx, payload = {}) => wear(ctx, payload),
        'inventory.repair': (ctx, payload = {}) => repair(ctx, payload),
        // { sid, pick: [index…] }: the reader takes what they picked of a reply's loot.
        'inventory.lootTake': Object.assign((ctx, payload = {}) => lootTake(ctx, payload, env), { feature: FEATURE.loot }),
    };
}

// ---------- capture (§4.4): runs as a story command ----------

// What one reply's story lines may make out of nothing (B1-2). Code's own payouts (a module's
// wallet.receive or inventory.grant through ctx.call) are not counted here, except a payout a module
// says the story alone vouched for (`wallet.receive { story: true }`, below), during the reply's capture
// or by a click after it (counted against the reply the click is stored on, ctx.reply; RX-E-2).
// `inventory.storyBudget` tells a module what is left (createInventoryQueries).
// * Coin: `storyCoinPerReply` in Story Block's settings, or with 0 (the default) the top reward of the
//   quest rank for the player character's level (`quest.ranks` and `party.pc`, when modules answer),
//   else 1000 × that level. Past it a line is paid what is left, and the Problems list says so.
// * Items: at most STORY_ITEM_QTY of one item per reply, however many lines name it (so a line repeated
//   is counted together), and goods worth at most STORY_WORTH_TIMES × the coin budget in all (each
//   def's `value` × the count given), so many kinds of item cannot add up to more than the coin limit.
//   Past either, a line gives what is left, and the Problems list says so. A `~ item … | qty:` that
//   raises a count is a gain, counted the same way; lowering one is free.
// * A notable item: the first `+ item` line of a reply whose one item is worth more than the goods
//   budget has left (so none of it would fit) gives one of it outside the worth tally, when it is worth
//   at most STORY_NOTABLE_TIMES × the goods budget (a count over 1 is clamped to 1: the rest is over
//   the goods budget). "The old man
//   hands you a potion" is a normal story moment even when that potion is worth more than a reply's
//   goods. One per reply: a later line over the budget is held as above. An item worth more than the
//   notable limit on its own is not notable, and is refused as above.
//   The notable item is given as a key item, a stack of its own (`key: true`, see addStack): usable,
//   never sold.
// * New kinds: at most STORY_NEW_DEFS item definitions made by one reply's story lines; past that a
//   line naming something new is refused.
// The tally is kept in the inventory slice under the reply's record ID (`perReply[<sid>]` =
// { coin, worth, made, items, notable, vouched }, ctx.carrier.sid, which stays with the reply when earlier messages are
// deleted), so it rolls back with the reply and starts again on the next one or another swipe. A reply
// adds its own entry and drops the others; `perReply` is the domain's `scratch` (ops.js): on replay a
// drop of an entry already gone (its reply deleted) is passed over, so no reply's gains hang on another's.
// A click's vouched payout (a2-3) adds its own key instead, `storyClicks[<sid>][<receipt id>] = paid`
// (scratch too, add-only, on the same carrier), and never writes the reply's entry: a swipe or delete of
// the reply takes it back with the reply, a Continue's lines count on from it, and a Re-read, whose
// capture runs on the state before the reply, counts it from the reply as it stood (ctx.standing), so
// the re-read lines and the clicks kept after them share one budget. The reply's money given is its
// entry's `coin` plus its clicks.
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

// `ctx` needs settings() and query(); a query passes its own (createInventoryQueries).
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
    const tally = { id, coin: tallied(stored?.coin), worth: tallied(stored?.worth), made: tallied(stored?.made), items: {}, ...(stored?.notable === true ? { notable: true } : {}) };
    // Of `coin`, what modules' vouched payouts gave (quest rewards), kept only once there is some.
    if (tallied(stored?.vouched)) tally.vouched = tallied(stored.vouched);
    for (const [def, n] of Object.entries(isPlainObject(stored?.items) ? stored.items : {})) if (isCount(n, 0)) tally.items[def] = n;
    return tally;
}

// This reply's entry, alone: other replies' entries (and an older shape's fields) go, their clicks too.
function keepTally(inv, { id, ...tally }) {
    if (!isPlainObject(inv.perReply)) inv.perReply = {};
    for (const key of Object.keys(inv.perReply)) if (key !== id) delete inv.perReply[key];
    inv.perReply[id] = tally;
    if (isPlainObject(inv.storyClicks)) for (const key of Object.keys(inv.storyClicks)) if (key !== id) delete inv.storyClicks[key];
}

// What the clicks after reply `id` paid of its budget (storyClicks): from `inv`, or in a Re-read's capture
// (whose state is the one before the reply) from the reply as it stood (`standing`, ctx.standing).
function clicksOf(inv, id, standing = null) {
    const own = isPlainObject(inv?.storyClicks) && Object.hasOwn(inv.storyClicks, id) ? inv.storyClicks[id] : null;
    const stood = standing?.domains?.inventory?.storyClicks;
    const log = own ?? (isPlainObject(stood) && Object.hasOwn(stood, id) ? stood[id] : null);
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

// `amount` held to what this reply may still give: { amount, problem }.
function storyCoin(ctx, inv, amount, currency, vouched = false) {
    const tally = tallyOf(ctx, inv, vouched);
    if (!tally) return { amount, problem: null };
    const budget = storyCoinBudget(ctx);
    // A click (a module's vouched payout outside a capture) is kept as its own key (keepClick).
    const click = vouched && ctx.cause !== 'story';
    const left = Math.max(0, budget - tally.coin - clicksOf(inv, tally.id, ctx.standing ?? null));
    // A module's vouched payout is never refused (its caller cannot catch a sub-command's failure): it
    // is paid what is left, which may be nothing, and told so.
    if (!left && !vouched) ctx.fail('REFUSED', `This reply has already given all the money one reply may give (${formatAmount(budget, currency)}); the rest was not paid.`);
    const paid = Math.min(amount, left);
    if (click) {
        if (paid) keepClick(ctx, inv, tally.id, paid);
    } else {
        tally.coin += paid;
        if (vouched && paid) tally.vouched = (tally.vouched ?? 0) + paid;
        keepTally(inv, tally);
    }
    return {
        amount: paid,
        problem: paid < amount ? `${formatAmount(amount, currency)} was written, but one reply may give at most ${formatAmount(budget, currency)}; ${formatAmount(paid, currency)} was paid.` : null,
    };
}

// `qty` of a def held to what this reply may still give (of that item, in worth, and, when the def is
// new, in kinds): { qty, problem, notable }. Refused when nothing may be given. Only a `+ item` line
// (not `more`, a raised count) may be the reply's notable item.
function storyItems(ctx, inv, def, qty, created = false, more = false, notableOk = !more) {
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
        if (!fits && notableOk && !tally.notable && value <= gift) {
            // The reply's notable item: not counted in the worth tally, held to its own limit.
            // One item (approved "one notable item per reply"): what else the line wrote is over the goods
            // budget (none of it fits), so it is not given, and the Problems list says so.
            notable = true;
            tally.notable = true;
            if (given > 1) {
                given = 1;
                limits.push(`only one key item beyond goods worth ${formatAmount(cap, currency)} in all`);
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
        problem: given < qty ? `${itemText(def.name, qty)}${more ? ' more' : ''} was written, but one reply may give ${limits.join(' and ')}; ${given} ${given === 1 ? 'was' : 'were'} given${notable ? ' as a key item' : ''}.` : null,
    };
}

// The carry limit, when a module keeps one (`items.carry`, MODULES §F39): whether `owner` can take on
// `add` ([{ defId, qty }]; `move` for a hand-over between the party's own) → { ok, message }, or null
// when no module answers (no limit).
function carryFits(ctx, add, owner, move = false) {
    let fits = null;
    try {
        fits = ctx.query('items.carry', { owner, add, ...(move ? { move: true } : {}) });
    } catch {
        return null;
    }
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
    // An "item" named as money (the currency, a coin, "Silver Coins", "3 silver coins") goes to the
    // wallet, as the coin and loot lines read the same words (B-a1-7).
    const currency = currencyOf(ctx.settings());
    if (isCurrencyName(name, currency) || countedMoney(name, currency)) return itemAsCoin(ctx, line, env, currency);
    if (line.op === '+') {
        const qty = lineQty(ctx, line, 1);
        if (qty < 1) ctx.fail('INVALID', 'A gained item needs a quantity of at least 1.');
        const note = trimText(labelOf(line, 'note') ?? text, MAX_NOTE);
        const { def, created } = defineByName(ctx, inv, name, env, { note, owner: 'party' });
        const held = storyItems(ctx, inv, def, qty, created);
        // Asked before the stacks change: `add` is weight on top of what is carried now.
        const heavy = storyCarry(ctx, def, held.qty, 'party');
        // The notable item is given as a key item, a stack of its own (addStack): usable, never sold.
        // Given by a story line: the story's own whatever its def (B-a2-2), for what it sells for.
        const stacks = grantInto(ctx, inv, def, held.qty, 'party', note, held.notable, true);
        return {
            summary: (held.notable
                ? `The party gains ${itemText(def.name, held.qty)}, given as a key item (outside this reply's goods budget; it can't be sold).`
                : `The party gains ${itemText(def.name, held.qty)}.`) + (heavy ? ENCUMBERED_NOTE : ''),
            data: { def: def.id, qty: held.qty, owner: 'party', stacks, created, from: labelOf(line, 'from') ?? '', ...(held.notable ? { notable: true, key: true } : {}), ...(heavy ? { encumbered: true } : {}) },
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
        const worn = labelOf(line, 'wear');
        if (worn !== null) changes.push(storyWear(ctx, inv, def, worn, trimText(text, MAX_NOTE)).replace(/\.$/, ''));
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
        // With a wear label the text says how it happened, not a new note.
        const note = labelOf(line, 'note') ?? (worn === null ? text || null : null);
        const qty = labelOf(line, 'qty', 'quantity', 'count') === null ? null : lineQty(ctx, line, null);
        let problem = null;
        let heavy = false;
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
    // With coins, "3 silver" is read in the smallest unit here, before the reply's budget holds it.
    const parsed = parseAmount(written, currencyOf(ctx.settings()));
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
/** The carry capacity each stack adds, by stack id, as the carry module reports it (`items.carry` → `bonuses`), or null. */
export function carryBonuses(tools) {
    let view = null;
    try { view = typeof tools?.query === 'function' ? tools.query('items.carry', {}) : null; } catch { view = null; }
    if (!isPlainObject(view) || !Array.isArray(view.bonuses)) return null;
    const out = {};
    for (const entry of view.bonuses) if (typeof entry?.stack === 'string' && isCount(entry.carry, 1)) out[entry.stack] = Math.min(CARRY_MAX, entry.carry);
    return out;
}

export function listItems(inventory, owner = null, carry = null) {
    const defs = inventory?.defs ?? {};
    return Object.values(inventory?.stacks ?? {})
        .filter(stack => defs[stack.def] && (owner === null || stack.owner === owner))
        .map(stack => {
            const def = defs[stack.def];
            return {
                stack: stack.id, def: def.id, name: def.name, kind: def.kind, rarity: def.rarity, value: def.value,
                slot: def.slot, qty: stack.qty, owner: stack.owner, equipped: stack.equipped, note: stack.note, from: stack.from,
                ...(condOf(stack, inventory) < COND_MAX ? { cond: condOf(stack, inventory) } : {}),
                ...(stack.key === true ? { key: true } : {}),
                ...(stack.story === true ? { story: true } : {}),
                ...(carryOfStack(stack, def, carry) ? { carry: carryOfStack(stack, def, carry) } : {}),
            };
        })
        .sort((a, b) => ownerRank(a.owner) - ownerRank(b.owner) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0)
            || kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name, 'en', { numeric: true })
            || (a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0));
}

// What a stack adds to carrying: the carry module's word for it when one answers, else its pack def's `carry`.
const carryOfStack = (stack, def, carry) => (carry ? carry[stack.id] ?? null : packCarry(def.id, def.carry));

// A query's own way to ask other queries (tools.query over the same state); throws when there is none.
const asker = tools => (name, args) => {
    if (typeof tools?.query !== 'function') throw new Error(`No query "${name}" can be asked here.`);
    return tools.query(name, args);
};

/**
 * What the Inventory screen's Equipped section and pickers need (MODULES §F99), from the state:
 * { members: [{ id, name }], worn: [{ id, name, items: [item] }] (each wearer's pieces, by slot key),
 *   wearers: { [stack]: [{ id, name }] } (who may put on each piece of equipment, not its wearer),
 *   givers: { [stack]: [{ id, name }] } (where Give may hand each stack: the party's bag and members,
 *   not its owner), limits: { accessory, worn }, detail: bool (RPG Battle's item detail is there) }.
 */
export function equipmentView(state, tools) {
    const query = asker(tools);
    const inventory = state?.domains?.inventory;
    const party = state?.domains?.party ?? null;
    const members = membersOf(query, party);
    const pc = pcOf(query, party);
    const limits = slotLimits(query);
    const items = listItems(inventory);
    const names = new Map(members.map(member => [member.id, member.name]));
    const wearer = item => (item.owner === 'party' ? pc ?? 'party' : item.owner);
    const worn = [];
    for (const id of [...members.map(member => member.id), 'party']) {
        const pieces = items.filter(item => item.equipped !== null && wearer(item) === id)
            .sort((a, b) => (a.equipped < b.equipped ? -1 : a.equipped > b.equipped ? 1 : 0));
        if (pieces.length) worn.push({ id, name: names.get(id) ?? 'The party', items: pieces.map(item => ({ ...item, cond: item.cond ?? null })) });
    }
    const wearers = {};
    const givers = {};
    const bag = { id: 'party', name: 'the party\'s bag' };
    for (const item of items) {
        const def = inventory.defs[item.def];
        if (def.kind === 'equipment') {
            wearers[item.stack] = members.filter(member => !(item.equipped !== null && wearer(item) === member.id)
                && canWear(query, def, member.id, limits, member.name).ok);
        }
        givers[item.stack] = [bag, ...members].filter(target => target.id !== item.owner);
    }
    let detail = false;
    try {
        query('rpg-battle.itemDetail', { stack: '' });
        detail = true;
    } catch { detail = false; }
    return { members, worn, wearers, givers, limits, detail };
}

// The encumbered condition (`story-block.encumbrance`): derived from the load the carry module reports
// (`items.carry` without `add`: { on, people: [{ id, name, load, capacity }], load, capacity }), never
// stored, so it lifts by itself once something is put down. Who is over their own capacity is named
// (through the party module's members); a party over its whole capacity is the party.
export const ENCUMBERED_PENALTY = -2;
export const ENCUMBERED_STATS = Object.freeze(['AGI', 'DEX']);

/**
 * → { on, encumbered, party, who: [{ id, name, load, capacity }], load, capacity, penalty, stats }:
 * `penalty` (ENCUMBERED_PENALTY while encumbered, else 0) is what the checks module adds to checks of
 * `stats`; Story Block only tells the story.
 */
export function encumbrance(state, tools) {
    const none = { on: false, encumbered: false, party: false, who: [], load: 0, capacity: 0, penalty: 0, stats: [...ENCUMBERED_STATS] };
    let view = null;
    try { view = asker(tools)('items.carry', {}); } catch { view = null; }
    if (!isPlainObject(view) || view.on === false) return none;
    const num = value => (Number.isFinite(value) ? value : 0);
    const who = (Array.isArray(view.people) ? view.people : [])
        .filter(person => isPlainObject(person) && num(person.load) > num(person.capacity))
        .map(person => ({ id: String(person.id ?? ''), name: trimText(person.name || person.id || 'someone', 40), load: num(person.load), capacity: num(person.capacity) }));
    const party = num(view.load) > num(view.capacity);
    const encumbered = party || who.length > 0;
    return {
        on: true, encumbered, party, who, load: num(view.load), capacity: num(view.capacity),
        penalty: encumbered ? ENCUMBERED_PENALTY : 0, stats: [...ENCUMBERED_STATS],
    };
}

/** The encumbered tail line, or none: [] | [line]. */
export function encumbranceTail(found) {
    if (!found?.encumbered) return [];
    const who = found.who.length
        ? found.who.map(person => `${person.name} (${person.load}/${person.capacity})`).join(', ')
        : `the party (${found.load}/${found.capacity})`;
    return [`Encumbered (carrying more than they can): ${who}; ${found.stats.join(' and ')} checks ${found.penalty} until something is put down.`];
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
    // Each row's `carry` (the capacity the thing adds, PACKS.md "Carry capacity") is the carry module's
    // (`items.carry` → bonuses by stack: a pack's `carry` or the reader's own) when one answers, else the def's.
    'inventory.items': (state, args = {}, tools) => listItems(state?.domains?.inventory, args?.owner ?? null, carryBonuses(tools)),
    // { budget, paid, left, vouched }: the story money (`+ coin` lines and modules' `wallet.receive { story:
    // true }`) the current reply may give, has given and has left (RX-E-2); `vouched` is the part of
    // `paid` that modules' vouched payouts gave (quest rewards), so a module can tell a reply whose
    // budget its own payouts used from one whose coin lines did. The budget is the reader's
    // `storyCoinPerReply`, else the party rank's top (storyCoinBudget). The current reply is the one
    // the asking command is stored on (tools.reply: a capture's carrier, else the head carrier); with
    // none known, nothing is counted as given yet.
    'inventory.storyBudget': (state, args, tools) => {
        const budget = storyCoinBudget({ settings: () => env.settings(), query: (name, more) => tools.query(name, more) });
        const stored = storedTally(state?.domains?.inventory, tools?.reply?.sid);
        const clicks = tools?.reply?.sid ? clicksOf(state?.domains?.inventory, tools.reply.sid) : 0;
        const paid = Math.min(budget, tallied(stored?.coin) + clicks);
        return { budget, paid, left: Math.max(0, budget - paid), vouched: Math.min(paid, tallied(stored?.vouched) + clicks) };
    },
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
    'inventory.encumbrance': Object.assign((state, args, tools) => encumbrance(state, tools), { feature: FEATURE.encumbrance }),
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
