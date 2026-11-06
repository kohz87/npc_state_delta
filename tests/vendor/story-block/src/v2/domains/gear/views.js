// Gear's query answers and screen picture (moved out of domains/gear.js unchanged; gear.js re-exports every public
// name): what a wearer has on, the stats it gives, the carry card and the four gear queries, using supplied readers.

import { isPlainObject } from '../common.js';
import { readSheet } from '../../lean-rpg/read.js';
import { GEAR } from './stats.js';
import { statsFor, handDef, slotWordOf, placeOf } from './stats.js';
import { condWord } from './conditions.js';
import { carryPicture, carryAnswer, travelsWith, kindCarry, capacityFor, atLimit, loadLevel } from './carry.js';

const PLACES = GEAR.places;

/** What `owner` has on, by place: { weapon, body, 'off-hand', head, cloak, feet, 'accessory-1', 'accessory-2' } → { name, stats, cond, broken } | null. */
function wornBy(state, owner, condOf) {
    const inventory = state?.domains?.inventory;
    const defs = isPlainObject(inventory?.defs) ? inventory.defs : {};
    const worn = Object.values(isPlainObject(inventory?.stacks) ? inventory.stacks : {})
        .filter(stack => isPlainObject(stack) && stack.owner === owner && typeof stack.equipped === 'string' && isPlainObject(defs[stack.def]))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const out = {};
    for (const place of PLACES) {
        const stack = worn.find(other => other.equipped === place);
        if (!stack) { out[place] = null; continue; }
        const def = defs[stack.def];
        const cond = condOf(stack, inventory);
        out[place] = { name: def.name, stats: cond > 0 ? statsFor(def) : {}, cond, broken: cond <= 0 };
    }
    return out;
}

/** `statBonus(owner)` → { STR, VIT, AGI, DEX, INT, LUK, CHA } summed over what the owner wears, broken pieces left out. */
export function statBonus(state, owner, condOf) {
    const total = Object.fromEntries(GEAR.stats.map(stat => [stat, 0]));
    for (const piece of Object.values(wornBy(state, owner, condOf))) if (piece) for (const [stat, n] of Object.entries(piece.stats)) total[stat] += n;
    return total;
}

/**
 * `inventory.gear { owner }`: what `owner` has on, the stats it gives, and what they carry:
 * { on, owner, slots: { weapon, body, off-hand, head, cloak, feet, accessory-1, accessory-2 }: { name, stats, cond, broken } | null,
 *   statBonus: { STR…CHA }, carry: { load, capacity, encumbered, penalty, sources } }.
 * A broken piece (cond 0) gives no stats. Part 2 adds `statBonus` to the effective stats (held to GEAR.effectiveMax).
 */
export function gearAnswer(state, args, { condOf, carryOf, penalty, mounts }) {
    const owner = typeof args?.owner === 'string' && args.owner ? args.owner : 'party';
    const picture = carryPicture(state, { carryOf, mounts });
    const mine = owner === 'party' ? picture.shared : picture.people.find(person => person.id === owner) ?? { load: 0, capacity: capacityFor(null) };
    const over = atLimit(mine.load, mine.capacity);
    return {
        on: true, owner, slots: wornBy(state, owner, condOf), statBonus: statBonus(state, owner, condOf),
        carry: { load: mine.load, capacity: mine.capacity, encumbered: over, penalty: over ? penalty : 0, sources: picture.sources[owner] ?? [{ name: owner, carry: capacityFor(null) }] },
    };
}

// ---- The gear screens' picture (Inventory tab, the slot card on the Party tab): `gear.view`.
/** "+2 DEX", "+1 STR +1 DEX": what stats give, in the order of the seven stats; '' for none. */
export const bonusText = stats => GEAR.stats.filter(stat => Number.isSafeInteger(stats?.[stat]) && stats[stat] > 0).map(stat => `+${stats[stat]} ${stat}`).join(' ');

// How full a condition bar is drawn for each word (Good full, Broken empty).
const FILL = Object.freeze({ good: 1, worn: 0.66, torn: 0.33, broken: 0 });


/**
 * `gear.view { owner?, who?, own? }`: everything the gear screens draw, in one answer (null while the feature is off):
 * { on, owner, carry: { load, capacity, pct, level: normal | heavy | over, lose, breakdown, away },
 *   rows: { [stack]: { bonus, cond, word, broken, place, by, byId } } (every stack: the stat bonus text, the condition word good | worn | torn | broken,
 *   where it is worn and by whom), owners: [{ value, label }] (who can wear: the main character first), slots: { [place]: { stack, name, rarity, bonus, cond, word, broken } | null } (what `owner` has on) }.
 * `names(id)` is how an owner is called ("Astra"); `owners` the wearers it offers. `who` (a name) picks the owner by name, `own` the main character's.
 */
export function gearView(state, args, { condOf, carryOf, penalty, mounts, names, owners, kit = () => false, empty = () => false }) {
    const inventory = state?.domains?.inventory;
    const defs = isPlainObject(inventory?.defs) ? inventory.defs : {};
    const stacks = Object.values(isPlainObject(inventory?.stacks) ? inventory.stacks : {}).filter(stack => isPlainObject(stack) && isPlainObject(defs[stack.def]))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const list = owners();
    let owner = typeof args?.owner === 'string' && args.owner ? args.owner : null;
    if (!owner && typeof args?.who === 'string' && args.who.trim()) {
        const key = args.who.trim().toLowerCase();
        owner = args.own === true ? 'party' : list.find(entry => entry.label.toLowerCase() === key)?.value ?? null;
    }
    if (!owner && !(typeof args?.who === 'string' && args.who.trim())) owner = 'party';
    const rows = {};
    for (const stack of stacks) {
        const def = defs[stack.def];
        const cond = condOf(stack, inventory);
        const worn = typeof stack.equipped === 'string';
        rows[stack.id] = {
            bonus: def.kind === 'equipment' ? bonusText(statsFor(def)) : '', cond, word: condWord(cond), broken: cond <= 0,
            place: worn ? stack.equipped : '', by: worn ? names(stack.owner) : '', byId: worn ? stack.owner : '',
            // The slot the Edit form offers: where it is worn, else the place its own slot names ('' for none: a bag).
            slotKey: worn ? stack.equipped : (def.kind === 'equipment' && slotWordOf(def.slot) ? placeOf(slotWordOf(def.slot)) : ''),
            fill: FILL[condWord(cond)],
            // A piece the reader added by hand (its Edit offers Kind, Slot, Rarity and Bonus): its own slot and stat points.
            ...(handDef(inventory, def) ? { hand: true, defSlot: def.kind === 'equipment' ? placeOf(slotWordOf(def.slot) ?? '') : '', stats: statsFor(def) } : {}),
            // A cast member's signature piece: whose it is, for the chip ("Bound to Mara").
            ...(typeof stack.bound === 'string' && stack.bound ? { bound: { who: names(stack.bound) || stack.bound } } : {}),
        };
    }
    const slots = Object.fromEntries(PLACES.map(place => [place, null]));
    for (const stack of stacks) {
        if (stack.owner !== owner || typeof stack.equipped !== 'string' || !Object.hasOwn(slots, stack.equipped) || slots[stack.equipped]) continue;
        const def = defs[stack.def];
        const cond = condOf(stack, inventory);
        slots[stack.equipped] = { stack: stack.id, name: def.name, rarity: def.rarity, bonus: bonusText(statsFor(def)), cond, word: condWord(cond), broken: cond <= 0,
            ...(typeof stack.bound === 'string' && stack.bound ? { bound: { who: names(stack.bound) || stack.bound } } : {}) };
    }
    const picture = carryPicture(state, { carryOf, mounts });
    const shared = picture.shared;
    const place = state?.domains?.scene?.place?.name ?? '';
    const memberCount = Math.max(1, readSheet(state).characters.length);
    const breakdown = (picture.sources.party ?? []).map((entry, at) => (at < memberCount ? `${entry.name} ${entry.carry}` : `${entry.name} +${entry.carry}`)).join(' · ');
    const away = (Array.isArray(mounts) ? mounts : []).filter(row => row && !travelsWith(row.where, place)).map(row => {
        const carry = (Number.isSafeInteger(row.carry) && row.carry > 0 ? row.carry : kindCarry(row.kind)) * (Number.isSafeInteger(row.count) && row.count > 0 ? row.count : 1);
        return `${row.name} +${carry} · ${String(row.where).trim()}, not with you`;
    });
    return {
        on: true, owner, owners: list, rows, slots,
        // The starting kit (the chat has no message from the reader yet): Rarity and Bonus may be set by hand.
        kit: { open: kit() === true, ...(empty() === true ? { empty: true } : {}) },
        carry: {
            load: shared.load, capacity: shared.capacity, pct: shared.capacity > 0 ? Math.round(shared.load * 100 / shared.capacity) : 0,
            level: loadLevel(shared.load, shared.capacity), lose: Math.abs(penalty), breakdown, away,
        },
    };
}

/**
 * The two gear queries: `inventory.gear` and `gear.carry` (`items.carry`'s answer from Story Block's own rules, asked only when no
 * carry module answers `items.carry`; a query of that name would clash with a carry module's). Both answer null while `on()` is false.
 */
export function createGearQueries({ on, kit = () => false, empty = () => false, condOf, carryOf, penalty, feature, names = () => '', owners = () => [] }) {
    // (`recorded: true`, asked by a roll that carries a gear record, answers whatever the switch says now: the record decides, gear.js `wearGear`)
    // (`inventory.gear` has no `feature`: the registry would answer null for it while the switch is off, and a roll that carries a gear record asks it then)
    const gate = (fn, recorded = false) => Object.assign((state, args, tools) => (on() || args?.recorded === true ? fn(state, args, tools) : null), recorded ? {} : { feature });
    // The mount rows, as the (feature-gated) `mounts.list` query gives them: none while Mounts is off.
    const mountsOf = tools => { try { const rows = tools?.query?.('mounts.list'); return Array.isArray(rows) ? rows : []; } catch { return []; } };
    return {
        'inventory.statBonus': gate((state, args) => statBonus(state, typeof args?.owner === 'string' && args.owner ? args.owner : 'party', condOf)),
        'inventory.gear': gate((state, args, tools) => gearAnswer(state, args, { condOf, carryOf, penalty, mounts: mountsOf(tools) }), true),
        'gear.view': gate((state, args, tools) => gearView(state, args, { kit, empty, condOf, carryOf, penalty, mounts: mountsOf(tools), names: id => names(state, tools, id), owners: () => owners(state, tools) })),
        'gear.carry': gate((state, args, tools) => carryAnswer(state, args, { carryOf, mounts: mountsOf(tools) })),
    };
}
