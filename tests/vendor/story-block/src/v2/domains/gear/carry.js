// Gear's carry rules: mount capacity, a member's capacity, the whole carry picture and the carry query's answer
// (moved out of domains/gear.js unchanged; gear.js re-exports every public name). The picture uses the supplied carry reader.

import { isPlainObject } from '../common.js';
import { readSheet } from '../../lean-rpg/read.js';
import { GEAR } from './stats.js';

export const KIND_CARRY = Object.freeze({ horse: 20, pony: 20, mule: 40, donkey: 40, cart: 60, barrow: 60, wagon: 150, boat: 100 });
export const OTHER_CARRY = 20;
const WORD_KIND = Object.freeze({ horses: 'horse', ponies: 'pony', mules: 'mule', donkeys: 'donkey', carts: 'cart', barrows: 'barrow', wagons: 'wagon', boats: 'boat', handcart: 'cart', handcarts: 'cart' });

/** What one mount of this kind carries: horse/pony 20, mule/donkey/pack animal 40, cart/barrow/hand-cart 60, wagon 150, boat 100, other 20. */
export function kindCarry(kind) {
    const text = String(kind ?? '').normalize('NFKC').toLowerCase();
    if (/pack[\s-]*(animal|beast|horse|pony)/.test(text)) return 40;
    for (const word of text.split(/[^a-z]+/).filter(Boolean)) {
        const base = WORD_KIND[word] ?? word;
        if (Object.hasOwn(KIND_CARRY, base)) return KIND_CARRY[base];
    }
    return OTHER_CARRY;
}

/** The capacity a story item adds by its name (cart, barrow, hand-cart, wagon, sledge: the same table; a sledge is a cart's), or null. */
export function itemCarryOf(name) {
    const words = String(name ?? '').normalize('NFKC').toLowerCase().split(/[^a-z]+/).filter(Boolean).map(word => word.replace(/s$/, ''));
    if (words.includes('wagon')) return KIND_CARRY.wagon;
    if (words.some(word => ['cart', 'handcart', 'sledge'].includes(word) || word.endsWith('barrow'))) return KIND_CARRY.cart;
    return null;
}

// "ridden by Wessel", "led by Tam": with the party; "stabled at the Stray Oar": where it was left.
const WITH_PARTY = /^\s*(?:ridden|rode|rides|riding|led|leads|leading|pulled|pulling|hitched|loaded|carried|carrying|with|travel)/i;
const foldWords = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Does a mount row travel with the party? Its `where` is empty, names the party's place, or says it is ridden, led or pulled. */
export function travelsWith(where, place) {
    const said = foldWords(where);
    if (!said || WITH_PARTY.test(String(where))) return true;
    const here = foldWords(place);
    return Boolean(here) && (said.includes(here) || here.includes(said));
}

const strOf = value => (Number.isSafeInteger(value) ? Math.max(GEAR.carry.strMin, Math.min(GEAR.carry.strMax, value)) : GEAR.carry.strDefault);
/** A member's carry capacity: 10 + 2 × STR (STR held to 1…20; a missing STR counts as the default). */
export const capacityFor = str => GEAR.carry.base + GEAR.carry.perStr * strOf(str);

function actorStr(actor) {
    for (const value of [actor?.str, actor?.STR, actor?.stats?.str, actor?.stats?.STR]) if (Number.isSafeInteger(value)) return value;
    return null;
}

/**
 * The whole carry picture from a state, in `items.carry`'s shape:
 * { on, people: [{ id, name, load, capacity }] (the party's own members who hold things of their own), bag, load, capacity, bonuses }.
 * `carryOf(def)` is the capacity a def adds (inventory.js: a pack item's `carry`).
 * The shared bag (owner `party`) has the RPG characters' capacities added up (a story with none counts one reader of default
 * strength); each person owns theirs. A thing weighs 1 per unit, and what a stack adds counts while it is worn (equipment) or held.
 */
export function carryPicture(state, { carryOf, mounts = [] }) {
    const inventory = state?.domains?.inventory;
    const defs = isPlainObject(inventory?.defs) ? inventory.defs : {};
    const stacks = Object.values(isPlainObject(inventory?.stacks) ? inventory.stacks : {}).filter(stack => isPlainObject(stack) && isPlainObject(defs[stack.def]));
    const actors = isPlainObject(state?.domains?.party?.actors) ? state.domains.party.actors : {};
    const load = {}, bags = {}, bonuses = [];
    for (const stack of stacks) {
        const def = defs[stack.def];
        load[stack.owner] = (load[stack.owner] ?? 0) + stack.qty;
        const carry = carryOf(def);
        if (carry) {
            bonuses.push({ stack: stack.id, carry });
            if (def.kind !== 'equipment' || stack.equipped !== null) bags[stack.owner] = (bags[stack.owner] ?? 0) + carry;
        }
    }
    const sheet = readSheet(state).characters;
    const members = sheet.length ? sheet.map(person => ({ name: person.who, str: person.stats?.str })) : [{ name: 'The reader', str: null }];
    // Mounts and carts that travel with the party add their carry × count to the shared bag.
    const place = state?.domains?.scene?.place?.name ?? '';
    const rides = (Array.isArray(mounts) ? mounts : []).filter(row => row && travelsWith(row.where, place))
        .map(row => ({ name: row.name, carry: (Number.isSafeInteger(row.carry) && row.carry > 0 ? row.carry : kindCarry(row.kind)) * (Number.isSafeInteger(row.count) && row.count > 0 ? row.count : 1) }));
    const sources = {
        party: [...members.map(member => ({ name: member.name, carry: capacityFor(member.str) })),
            ...stacks.filter(stack => stack.owner === 'party' && carryOf(defs[stack.def]) && (defs[stack.def].kind !== 'equipment' || stack.equipped !== null)).map(stack => ({ name: defs[stack.def].name, carry: carryOf(defs[stack.def]) })),
            ...rides],
    };
    const sharedCapacity = sources.party.reduce((sum, entry) => sum + entry.carry, 0);
    const ids = [...new Set([...Object.keys(actors), ...Object.keys(load)])].filter(id => id !== 'party').sort();
    const people = ids.map(id => ({
        id, name: typeof actors[id]?.name === 'string' && actors[id].name.trim() ? actors[id].name.trim() : id,
        load: load[id] ?? 0, capacity: capacityFor(actorStr(actors[id])) + (bags[id] ?? 0),
    }));
    for (const person of people) {
        sources[person.id] = [{ name: person.name, carry: capacityFor(actorStr(actors[person.id])) },
            ...stacks.filter(stack => stack.owner === person.id && carryOf(defs[stack.def]) && (defs[stack.def].kind !== 'equipment' || stack.equipped !== null)).map(stack => ({ name: defs[stack.def].name, carry: carryOf(defs[stack.def]) }))];
    }
    const total = Object.values(load).reduce((sum, n) => sum + n, 0);
    return {
        on: true, people, bag: load.party ?? 0, load: total, capacity: sharedCapacity + people.reduce((sum, person) => sum + person.capacity, 0),
        shared: { load: load.party ?? 0, capacity: sharedCapacity }, sources, bonuses,
    };
}

const weightOf = (add, defs) => (Array.isArray(add) ? add : []).reduce((sum, entry) => {
    const qty = Number.isSafeInteger(entry?.qty) && entry.qty > 0 ? entry.qty : 0;
    return sum + (entry?.defId && defs?.[entry.defId]?.kind === 'money' ? 0 : qty);
}, 0);

/** `items.carry`'s answer, from Story Block's own rules: the whole picture, or `{ ok, message }` when `args.add` asks whether things fit. */
export function carryAnswer(state, args, deps) {
    const picture = carryPicture(state, deps);
    const { shared, sources, ...answer } = picture;
    if (!Array.isArray(args?.add)) return answer;
    const weight = weightOf(args.add, state?.domains?.inventory?.defs);
    const owner = typeof args.owner === 'string' ? args.owner : 'party';
    const person = picture.people.find(entry => entry.id === owner);
    if (person) {
        return person.load + weight > person.capacity
            ? { ok: false, message: `${person.name} cannot carry that: ${person.load} of ${person.capacity} carried.` } : { ok: true };
    }
    // A hand-over inside the party keeps the whole load; the shared bag has the whole party's capacity.
    if (args.move === true) return { ok: true };
    return picture.load + weight > picture.capacity
        ? { ok: false, message: `The party cannot carry that: ${picture.load} of ${picture.capacity} carried.` } : { ok: true };
}

/** Encumbered: carrying something and at or over the capacity (100 % and more, as approved; an empty load is never encumbered). */
export const atLimit = (load, capacity) => load > 0 && load >= capacity;

/** The load bands of the Carry card: `over` (red, "Encumbered") from 100 % (the same test as the encumbered condition), `heavy` (yellow) from 80 % to below 100 %. */
export function loadLevel(load, capacity) {
    if (atLimit(load, capacity)) return 'over';
    return capacity > 0 && load * 5 >= capacity * 4 ? 'heavy' : 'normal';
}
