// The inventory domain's read side (moved out of domains/inventory.js unchanged; inventory.js re-exports every public name): the
// items as a list, the equipment view, what the carried gear adds, the load and its encumbrance (never stored: derived from the
// state), the definitions, and the domain's query table (`createInventoryQueries`). Display and query only; nothing here writes.

import { isPlainObject, clone } from '../common.js';
import { trimText } from '../names.js';
import { DEF_ID } from '../../check.js';
import { valueByCond, handDef, statsFor, atLimit } from '../gear.js';
import { KIND_ORDER, isCount, CARRY_MAX, condOf, COND_MAX, packCarry } from './state.js';
import { membersOf, pcOf, slotLimits, canWear, asking } from './validate.js';

// The most definitions one `inventory.definitions` call may ask for by ID.
export const DEFINITIONS_MAX_IDS = 1000;

// What answers `items.carry`: a carry module's own answer, else (while `story-block.gear` is on) Story Block's rules, asked as
// `gear.carry` (a query of the name `items.carry` would clash with a carry module's). Null when nothing answers: no limit.
export function carryAnswer(ask, args, own = true) {
    for (const name of own ? ['items.carry', 'gear.carry'] : ['items.carry']) {
        let said = null;
        try { said = ask(name, args); } catch { said = null; }
        if (isPlainObject(said)) return said;
    }
    return null;
}

const ownerRank = owner => (owner === 'party' ? 0 : 1);
const kindRank = kind => (KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length);

/** Stacks joined with their defs, the party's first, then by kind, name and ID. */
/** The carry capacity each stack adds, by stack id, as the carry module reports it (`items.carry` → `bonuses`), or null. */
export function carryBonuses(tools) {
    const view = typeof tools?.query === 'function' ? carryAnswer(asker(tools), {}) : null;
    if (!isPlainObject(view) || !Array.isArray(view.bonuses)) return null;
    const out = {};
    for (const entry of view.bonuses) if (typeof entry?.stack === 'string' && isCount(entry.carry, 1)) out[entry.stack] = Math.min(CARRY_MAX, entry.carry);
    return out;
}

export function listItems(inventory, owner = null, carry = null, gear = false, nameOf = null) {
    const defs = inventory?.defs ?? {};
    return Object.values(inventory?.stacks ?? {})
        .filter(stack => defs[stack.def] && (owner === null || stack.owner === owner))
        .map(stack => {
            const def = defs[stack.def];
            return {
                stack: stack.id, def: def.id, name: def.name, kind: def.kind, rarity: def.rarity,
                // With gear on a price is the value by condition (gear.js valueByCond); `baseValue` is the def's own.
                value: gear ? valueByCond(def.value, condOf(stack, inventory)) : def.value, ...(gear ? { baseValue: def.value } : {}),
                slot: def.slot, qty: stack.qty, owner: stack.owner, equipped: stack.equipped, ...(gear && stack.equipped !== null ? { equippedBy: stack.owner } : {}), note: stack.note, from: stack.from,
                ...(condOf(stack, inventory) < COND_MAX ? { cond: condOf(stack, inventory) } : {}),
                ...(stack.key === true ? { key: true } : {}),
                ...(stack.story === true ? { story: true } : {}),
                // (gear on, a piece the reader made by hand: marked, with its own bonus, so a saved character keeps it exactly)
                ...(gear && handDef(inventory, def) ? { hand: true, ...(def.kind === 'equipment' ? { stats: statsFor(def) } : {}) } : {}),
                // (a cast member's signature piece, with gear on: whose it is, for the screens' chip)
                ...(gear && typeof stack.bound === 'string' && stack.bound ? { bound: { who: nameOf?.(stack.bound) ?? stack.bound } } : {}),
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
 *   not its owner), users: { [stack]: [{ id, name }] } (whom Use on… offers for a consumable: usersOf),
 *   limits: { accessory, worn } }.
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
    return { members, worn, wearers, givers, users: usersOf(query, inventory, items, members), limits };
}

/**
 * Who a Use on… picker offers for each consumable (bag management, beta.1 live test): the module that
 * answers `items.useOn`; Use runs `item.use { stack, target }`. Only consumables the party holds, only members;
 * {} without such a module, so the picker is not drawn.
 */
function usersOf(query, inventory, items, members) {
    const given = asking(query, 'items.useOn', {});
    if (!isPlainObject(given)) return {};
    const names = new Map(members.map(member => [member.id, member.name]));
    const out = {};
    for (const item of items) {
        if (inventory.defs[item.def]?.kind !== 'consumable' || !Object.hasOwn(given, item.stack) || !Array.isArray(given[item.stack])) continue;
        const ids = [...new Set(given[item.stack].map(entry => (isPlainObject(entry) ? entry.id : entry)).filter(id => names.has(id)))];
        if (ids.length) out[item.stack] = ids.map(id => ({ id, name: names.get(id) }));
    }
    return out;
}

// The encumbered condition (`story-block.encumbrance`): derived from the load the carry module reports
// (`items.carry` without `add`: { on, people: [{ id, name, load, capacity }], load, capacity }), never
// stored, so it lifts by itself once something is put down. Who is over their own capacity is named
// (through the party module's members); a party over its whole capacity is the party.
export const ENCUMBERED_PENALTY = -2;
/** The capacity a def adds to what its owner carries (a pack item's `carry`), or null. */
export const defCarry = def => (isCount(def?.carry, 1) && def.carry <= CARRY_MAX ? def.carry : null);
export const ENCUMBERED_STATS = Object.freeze(['AGI', 'DEX']);

/**
 * → { on, encumbered, party, who: [{ id, name, load, capacity }], load, capacity, penalty, stats }:
 * `penalty` (ENCUMBERED_PENALTY while encumbered, else 0) is what the checks module adds to checks of
 * `stats`; Story Block only tells the story.
 */
export function encumbrance(state, tools, gear = false) {
    const none = { on: false, encumbered: false, party: false, who: [], load: 0, capacity: 0, penalty: 0, stats: [...ENCUMBERED_STATS] };
    const view = carryAnswer(asker(tools), {});
    if (!isPlainObject(view) || view.on === false) return none;
    const num = value => (Number.isFinite(value) ? value : 0);
    // Past the limit encumbers (exactly at it does not) as it always did; only with gear on is "at the limit" (100 %) already encumbered, as its Carry card says.
    const over = (load, capacity) => (gear ? atLimit(load, capacity) : load > capacity);
    const who = (Array.isArray(view.people) ? view.people : [])
        .filter(person => isPlainObject(person) && over(num(person.load), num(person.capacity)))
        .map(person => ({ id: String(person.id ?? ''), name: trimText(person.name || person.id || 'someone', 40), load: num(person.load), capacity: num(person.capacity) }));
    const party = over(num(view.load), num(view.capacity));
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

/** `inventory.definitions`' answer from an inventory slice (see the query). */
export function definitionsOf(inventory, args) {
    if (args !== undefined && args !== null && !isPlainObject(args)) return [];
    const ids = args?.ids;
    const defs = isPlainObject(inventory?.defs) ? inventory.defs : {};
    let list;
    if (ids === undefined || ids === null) list = Object.keys(defs);
    else if (!Array.isArray(ids) || ids.length > DEFINITIONS_MAX_IDS || ids.some(id => typeof id !== 'string' || !DEF_ID.test(id))) return [];
    else list = [...new Set(ids)].filter(id => Object.hasOwn(defs, id));
    return list.sort().filter(id => isPlainObject(defs[id])).map(id => clone(defs[id]));
}

export const gearIsOn = env => { try { return env.gearOn?.() === true; } catch { return false; } };

// Who wears what on the gear screens: the party's bag is the main character's (the party module's `party.pc`, else the reader's persona), the
// others are the party's members. → { names: Map(owner → name), owners: [{ value, label }] } (the main character first, as owner `party`).
export function gearWearers(state, tools, env) {
    const query = asker(tools);
    const party = state?.domains?.party ?? null;
    const members = membersOf(query, party);
    const pcId = pcOf(query, party);
    let persona = '';
    try { persona = String(env.persona?.() ?? '').trim(); } catch { persona = ''; }
    const own = (pcId && members.find(member => member.id === pcId)?.name) || persona || 'The party';
    const names = new Map([['party', own], ...members.map(member => [member.id, member.name])]);
    return { names, owners: [{ value: 'party', label: own }, ...members.filter(member => member.id !== pcId).map(member => ({ value: member.id, label: member.name }))] };
}

// (how a bound piece names its member: the party's roster, else the ID; only asked with gear on)
export function boundNames(state, tools, env) {
    if (!gearIsOn(env)) return null;
    let names = null;
    return id => {
        if (!names) { try { names = gearWearers(state, tools, env).names; } catch { names = new Map(); } }
        return names.get(id);
    };
}
