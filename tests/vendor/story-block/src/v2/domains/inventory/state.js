// The inventory domain's shape (moved out of domains/inventory.js unchanged; inventory.js re-exports every public name): the item kinds
// and rarities, the empty inventory, the optional mechanics the domain owns and how to ask whether one is on, an item's condition
// and its log, the default definition, the carry constants, and the shape checks for a definition and a kept stack. Pure.

import { isPlainObject, OWNER_RE } from '../common.js';
import { DEF_ID } from '../../check.js';
import { GEAR } from '../gear.js';

export const KINDS = Object.freeze(['goods', 'material', 'consumable', 'equipment', 'quest', 'money']);
export const RARITIES = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);
// The order kinds are listed in (prompt view and tab): what the story turns on first.
/** The words of a story line's `kind:` that name an inventory kind. */
export const STORY_KIND = Object.freeze({ consumable: 'consumable', potion: 'consumable', draught: 'consumable', elixir: 'consumable', food: 'consumable', drink: 'consumable', material: 'material', ingredient: 'material', quest: 'quest' });
export const KIND_ORDER = Object.freeze(['quest', 'equipment', 'consumable', 'material', 'goods', 'money']);

export const MAX_NAME = 120;
export const MAX_NOTE = 300;
export const MAX_UNSTACKED = 50;

export function initialInventory() {
    return { defs: {}, stacks: {}, wallets: {}, aliases: {} };
}

// The optional mechanics this domain owns (MODULES §F100), declared by the core module. A host without
// the Features API ignores the list and every check below takes them as on.
export const FEATURE = Object.freeze({ loot: 'story-block.loot', encumbrance: 'story-block.encumbrance', gear: 'story-block.gear' });
export const INVENTORY_FEATURES = Object.freeze([
    Object.freeze({
        id: FEATURE.loot, label: 'Pick what you take', default: true, presets: Object.freeze({ lean: false }),
        describe: 'The story can lay out loot (? loot A, B, C — where); the reply\'s card shows it as chips and you take the ones you want.',
    }),
    Object.freeze({
        id: FEATURE.encumbrance, label: 'Encumbered', default: true, presets: false,
        describe: 'What the story gives past the carry limit is kept, and the party is encumbered (a check penalty) until something is put down. Your own buys and takes are still refused.',
    }),
    Object.freeze({
        id: FEATURE.gear, label: 'Gear in fights', default: false, presets: false,
        describe: 'Worn gear adds a few points to the stats by rarity and wears down; what a member can carry follows their strength (and the party is encumbered past it).',
    }),
]);

// The gear switch lives in Settings → RPG and counts only while the RPG is on.
const RPG_FEATURE = 'story-block.rpg';
/** The module whose `rpg.resolve` rolls the dice: the only caller `gear.wear { recorded: true }` accepts. */
export const RPG_MODULE = 'story-block';

/** Whether the gear feature is on for this handler (or view): off unless the host says so (off by default, and only while the RPG is on). */
export function gearOn(ctx) {
    try {
        return typeof ctx?.feature === 'function' && ctx.feature(FEATURE.gear) === true && ctx.feature(RPG_FEATURE) === true;
    } catch {
        return false;
    }
}

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
export function condWrite(ctx, inv, stack, d) {
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

export function condLogErrors(condLog) {
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

export const isCount = (value, min) => Number.isSafeInteger(value) && value >= min;
export const nonBlank = value => typeof value === 'string' && value.trim() !== '';

export function defErrors(key, def) {
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
    if (def.bonus !== undefined && !(isCount(def.bonus, 0) && def.bonus <= GEAR.bonusMax)) errors.push(`${label} has a gear bonus of ${def.bonus}; it is a whole number from 0 to ${GEAR.bonusMax}.`);
    return errors;
}

// The carry capacity a def may add (PACKS.md "Carry capacity"): only a pack's item has one, so the story's
// words never make or raise it (WAVE rule 1); a carry module (`items.carry`) reads it.
export const CARRY_MAX = 1000;
export const packCarry = (id, value) => (typeof id === 'string' && id.startsWith('pack.') && isCount(value, 1) && value <= CARRY_MAX ? value : null);

/** §2.5 validator for the inventory slice: [] when fine, else plain sentences. */
// `kept[<member>]`: the bound pieces of a member who left the party, set aside until they come back (`inventory.stow` / `inventory.restore`):
// [{ def, qty, equipped, note, cond?, key?, story? }].
export function keptErrors(kept) {
    if (!isPlainObject(kept)) return ['The kept gear is not a record.'];
    const errors = [];
    for (const [owner, list] of Object.entries(kept)) {
        if (!OWNER_RE.test(owner) || owner === 'party') errors.push(`Kept gear belongs to "${owner}", who is not a party member's ID.`);
        if (!Array.isArray(list)) { errors.push(`The gear kept for ${owner} is not a list.`); continue; }
        for (const entry of list) {
            if (!isPlainObject(entry) || typeof entry.def !== 'string' || !isCount(entry.qty, 1) || !(entry.equipped === null || nonBlank(entry.equipped)) || typeof entry.note !== 'string'
                || (entry.by !== undefined && typeof entry.by !== 'string') || (entry.cond !== undefined && !(Number.isSafeInteger(entry.cond) && entry.cond >= 0 && entry.cond <= COND_MAX))) errors.push(`A piece kept for ${owner} is damaged.`);
        }
    }
    return errors;
}
