// The inventory domain's hand-set gear and the reader's edit guard (moved out of domains/inventory.js unchanged; inventory.js re-exports
// every public name): the starting kit, the stats and slot a reader sets, remaking a piece as equipment, and the replay guard of a reader edit.

import { isPlainObject } from '../common.js';
import { cleanName, trimText, resolveDef, slugify } from '../names.js';
import { GEAR, slotWordOf, placeOf, gearSlotOf, handDef, statsFor, statsOf } from '../gear.js';
import { fill } from '../../strings.js';
import { gearOn, KINDS, RARITIES, MAX_UNSTACKED, condOf, MAX_NOTE, READER_CARRY_MAX } from './state.js';
import { baseSlot } from './validate.js';
import { E, refuseBound, addStack, looseMatch, stacksOf, freeId } from './stacks.js';

// ---------- hand-set gear: the starting kit (docs/v2/GEAR.md "Your own gear") ----------
//
// With Gear in fights on, the reader's "+ Add item" and the Edit of a piece they added can set Kind, Slot, Rarity and a Bonus. The full
// setup (Rarity, Bonus) is the starting kit's: allowed only while the chat has no message from the reader yet (a swipe of the greeting keeps it
// open; `env.readers()` counts the reader's messages on the line of history and `env.greetingOnly()` is false once anything but the greeting is there, so only a rewind back to the greeting opens it again). After that Rarity
// stays Common (+1). A def the reader made is marked `hand: true`; the story's, a pack's and a bound piece's are not theirs to change.
/** Whether the starting kit is open: the chat is at its first message (only the opening greeting: no message from the reader and no reply after it). Unknown counts as closed. */
export function kitOpen(env) {
    try { return env?.readers?.() === 0 && env?.greetingOnly?.() !== false; } catch { return false; }
}

const article = word => (/^[aeiou]/i.test(word) ? 'An' : 'A');

// The stats a reader typed: { STAT: n } for the seven stats, whole numbers of at least 1, at most GEAR.maxStats different ones. `{}` for none.
export function handStats(ctx, raw) {
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
export function holdBudget(ctx, rarity, stats) {
    const total = Object.values(stats).reduce((sum, n) => sum + n, 0);
    const max = GEAR.budget[rarity] ?? 0;
    if (total <= max) return;
    ctx.fail('REFUSED', max === 0 ? E.kitNoBonus : fill(E.kitBudget, { a: article(rarity), rarity, max, points: max === 1 ? 'point' : 'points' }));
}

// A slot the reader chose: one of the eight places (or its base word), → the place key; null for none.
export function handSlot(ctx, raw) {
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
export function remakeAsEquipment(ctx, inv, def, keep, slot) {
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
export function handPlace(inv, owner, stackId, slot) {
    if (baseSlot(slot) !== 'accessory') return slot;
    const free = key => !Object.values(inv.stacks).some(other => other.owner === owner && other.id !== stackId && other.equipped === key);
    const named = slot === 'accessory' ? 'accessory-1' : slot;
    return [named, ...['accessory-1', 'accessory-2'].filter(key => key !== named)].find(free) ?? named;
}

// The reader's Edit of a piece they added by hand (gear on): `kind`, `slot` (a place, or '' for none), `rarity` and `stats`. Only a def with `hand: true` and no
// story-given stack; a pack's or the story's keeps its words. Rarity and Bonus are the starting kit's: changing them is refused once the reader has sent a message.
// A piece made Equipment later is Common; one made something else gives up its slot (and is taken off).
export function handEdit(ctx, env, inv, stack, payload) {
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
export function byReader(ctx) {
    if (ctx.cause !== 'ui' || ctx.caller !== null) ctx.fail('REFUSED', E.onlyReader);
}

/**
 * `inventory.carry { stack, carry }`: the reader sets what an item adds to carry capacity, 0 to 500 (0 removes it). It lands on the item's
 * definition, so every piece of it counts. Only the reader can: a story line never reaches this command (byReader), and a pack item keeps its own.
 */
export function setCarry(ctx, inv, payload) {
    byReader(ctx);
    const stack = inv.stacks[payload.stack];
    const def = stack && inv.defs[stack.def];
    if (!def) ctx.fail('NOT_FOUND', 'There is no such item.');
    if (def.id.startsWith('pack.')) ctx.fail('REFUSED', E.carryPack);
    if (def.kind === 'money') ctx.fail('REFUSED', E.carryMoney);
    const carry = payload.carry;
    if (!Number.isSafeInteger(carry) || carry < 0 || carry > READER_CARRY_MAX) ctx.fail('INVALID', fill(E.carryRange, { max: READER_CARRY_MAX }));
    if (carry === 0) delete def.carry;
    else def.carry = carry;
    return { summary: fill(E.itemSet, { detail: `${def.name}: carry ${carry}` }), data: { edit: true, stack: stack.id, def: def.id, carry }, narrate: true };
}

export const INVENTORY_EDIT_GUARD = 'inventory.reader-edit';
export const editStack = stack => ({ id: stack.id, def: stack.def, owner: stack.owner });
export const editPieces = (inventory, target) => Object.values(inventory?.stacks ?? {})
    .filter(stack => stack.def === target.def && stack.owner === target.owner)
    .map(stack => ({ id: stack.id, equipped: stack.equipped }));

// Saved ops cannot choose a different stack on replay. Witness the same name lookup and
// compatibility decision made when the reader added or renamed an item, without including
// unrelated inventory or a destination count that counter replay can safely rebase.
const editCompatibility = (inv, stack) => stack ? {
    id: stack.id, def: stack.def, owner: stack.owner, note: stack.note,
    equipped: stack.equipped, condition: condOf(stack, inv), key: stack.key === true,
} : null;
export function addDecision(inv, payload, defId) {
    const name = cleanName(payload.name), owner = payload.owner ?? 'party';
    const note = payload.note == null ? '' : trimText(payload.note, MAX_NOTE);
    const def = inv.defs[defId];
    const destination = def?.stack ? looseMatch(inv, defId, owner, note) : null;
    return { resolution: resolveDef(inv, name), def: def ? { id: def.id, stack: def.stack } : null,
        destination: editCompatibility(inv, destination) };
}
// `withStory` (a rename saved now carries `decision.story: 1`): the witness also holds whether the stack merged into is the story's, since the merge sets the
// result's "from the story" flag from both stacks. A rename saved before has no such mark and is witnessed as it was.
export function renameDecision(inv, stack, payload, withStory = false) {
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
            destination: editCompatibility(inv, target), ...(withStory ? { destinationStory: target?.story === true } : {}) };
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
export function guardReaderEdit(ctx, action, target = null, pieces = null, decision = null) {
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
        } else if (p.action === 'inventory.edit' && (Object.keys(d).length === 1 || (Object.keys(d).length === 2 && d.story === 1)) && inventory.stacks?.[payload.stack]
            && inventory.defs?.[inventory.stacks[payload.stack].def]) {
            witness = renameDecision(inventory, inventory.stacks[payload.stack], payload, d.story === 1);
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
