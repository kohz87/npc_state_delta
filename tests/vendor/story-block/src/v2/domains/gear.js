// Gear in fights, the inventory side (`story-block.gear`, docs/v2/GEAR.md). Pure; a leaf of the inventory
// domain (it imports nothing from it: inventory.js hands in what it needs).
//
// Everything a piece of gear is worth in numbers is derived here, never typed by the story:
//  - what a worn piece gives is +N to the seven stats and nothing else: its budget (total points) comes from the def's rarity
//    (GEAR.budget), or a pack item's explicit `bonus` (0…6); the stats are the ones the pack or the line names (held to the budget), else
//    the ones the kind or name suggests (STAT_BY_NAME, then the slot's default);
//  - the slot (weapon | body | off-hand | head | cloak | feet | accessory) comes from the line's `kind:` / `slot:` word, else the name;
//    a bag is no slot: it adds its carry while owned;
//  - the carry capacity of a member is 10 + 2 × STR, plus the carry of what they wear.
// Part 2 (the roll wiring) reads `inventory.gear` and wears pieces with `gear.wear`.

import { isPlainObject } from './common.js';
import { readSheet } from '../lean-rpg/read.js';

export const GEAR = Object.freeze({
    // The slots a piece can occupy; every one gives its stats.
    slots: Object.freeze(['weapon', 'body', 'off-hand', 'head', 'cloak', 'feet', 'accessory']),
    // The keys a worn piece is filed under (accessories have two places).
    places: Object.freeze(['weapon', 'body', 'off-hand', 'head', 'cloak', 'feet', 'accessory-1', 'accessory-2']),
    // The seven stats a piece can raise, and the one each slot raises when nothing else says.
    stats: Object.freeze(['STR', 'VIT', 'AGI', 'DEX', 'INT', 'LUK', 'CHA']),
    slotStat: Object.freeze({ weapon: 'STR', body: 'VIT', 'off-hand': 'VIT', head: 'VIT', cloak: 'AGI', feet: 'AGI', accessory: 'LUK' }),
    // The total stat points a rarity gives (Plan A: stats stay 1–20, so gear stays small).
    budget: Object.freeze({ common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }),
    // A pack item's own `bonus` is its budget instead, 0…6 (the Studio / a pack only).
    bonusMax: 6,
    // A stat with gear added up may pass 20 but never this (part 2 holds the effective stat to it).
    effectiveMax: 30,
    // A piece raises at most this many different stats.
    maxStats: 2,
    // The story's own words reach `epic` at most; legendary comes from a pack or a module's reward.
    storyRarityMax: 'epic',
    // Carry: capacity = base + perStr × STR (STR 1…20) + what is worn; a thing weighs 1 per unit, coins are free.
    carry: Object.freeze({ base: 10, perStr: 2, strMin: 1, strMax: 20, strDefault: 10 }),
});

// The condition words (a piece's cond 0…100) and what a piece is worth in each: Good is unmarked, the rest show their word after the
// name in the prompt, and every price read through `inventory.items` is the def's value times the factor.
export const CONDITION = Object.freeze({
    good: Object.freeze({ min: 70, factor: 1 }),
    worn: Object.freeze({ min: 40, factor: 0.75 }),
    torn: Object.freeze({ min: 1, factor: 0.5 }),
    broken: Object.freeze({ min: 0, factor: 0.2 }),
});

/** good | worn | torn | broken for a condition 0…100 (a missing one is as new). */
export function condWord(cond) {
    const n = Number.isFinite(cond) ? cond : 100;
    return n >= CONDITION.good.min ? 'good' : n >= CONDITION.worn.min ? 'worn' : n >= CONDITION.torn.min ? 'torn' : 'broken';
}

/** The condition after `steps` steps down the words: good → worn (69) → torn (39) → broken (0). */
export function stepDown(cond, steps = 1) {
    let now = Number.isFinite(cond) ? cond : 100;
    for (let n = 0; n < steps; n += 1) now = condWord(now) === 'good' ? CONDITION.good.min - 1 : condWord(now) === 'worn' ? CONDITION.worn.min - 1 : 0;
    return now;
}

/** The condition after one step up the words (broken → torn 39 → worn 69 → good 100), or all the way (`restore`) back to Good. */
export function stepUp(cond, restore = false) {
    const word = condWord(cond);
    if (restore || word === 'worn') return 100;
    return word === 'good' ? 100 : word === 'torn' ? CONDITION.good.min - 1 : CONDITION.worn.min - 1;
}

/** The word the prompt shows after a name (`Cane Sword (worn)`), or '' for Good. */
export const condMark = cond => (condWord(cond) === 'good' ? '' : condWord(cond));

/** What a piece of condition `cond` is worth: `value` × the condition's factor (Good 100%, Worn 75%, Torn 50%, Broken 20%), whole. */
export const valueByCond = (value, cond) => Math.round(value * CONDITION[condWord(cond)].factor);

// What a mount, a cart or a boat carries (per animal or vehicle), by the kind's words; a mount row may hold its own `carry`.
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

const RANK = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);

const words = text => String(text ?? '').normalize('NFKC').toLowerCase().split(/[^a-z]+/).filter(Boolean);
const singular = word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

// `kind:` words that name a slot, and the nouns of a name that do.
const SLOT_WORD = Object.freeze({
    weapon: 'weapon', armour: 'body', armor: 'body', body: 'body', shield: 'off-hand', offhand: 'off-hand',
    head: 'head', cloak: 'cloak', feet: 'feet', foot: 'feet', accessory: 'accessory',
});
const NAME_SLOT = Object.freeze({
    sword: 'weapon', blade: 'weapon', axe: 'weapon', hammer: 'weapon', club: 'weapon', bow: 'weapon', dagger: 'weapon', spear: 'weapon', staff: 'weapon', wand: 'weapon', tome: 'weapon',
    mail: 'body', leather: 'body', plate: 'body', cuirass: 'body', robe: 'body',
    shield: 'off-hand', buckler: 'off-hand',
    // A bag is no slot: a name that ends in one ("Leather Satchel") has none, whatever else it says.
    pack: null, satchel: null, bag: null, sack: null, backpack: null,
    helmet: 'head', helm: 'head', cap: 'head', hood: 'head',
    cloak: 'cloak', cape: 'cloak', mantle: 'cloak',
    boot: 'feet', shoe: 'feet', sandal: 'feet',
    ring: 'accessory', amulet: 'accessory', pendant: 'accessory', belt: 'accessory',
    gauntlet: 'accessory', glove: 'accessory', bracer: 'accessory', bracelet: 'accessory',
});
// Real compound gear words ("Longsword", "Warhammer", "Breastplate", "Longbow"), each matched as a whole word (a plural s is allowed, as for the nouns above).
// No word is read by its ending: "horseshoe", "reboot", "windshield", "crossword", "flagstaff" and "rainbow" are not gear.
const COMPOUND_SLOT = Object.freeze({
    longsword: 'weapon', shortsword: 'weapon', broadsword: 'weapon', greatsword: 'weapon', bastardsword: 'weapon', twohandedsword: 'weapon',
    warhammer: 'weapon', battleaxe: 'weapon', greataxe: 'weapon', handaxe: 'weapon', warstaff: 'weapon', quarterstaff: 'weapon',
    longbow: 'weapon', shortbow: 'weapon', crossbow: 'weapon', greatbow: 'weapon', warbow: 'weapon',
    breastplate: 'body', chainmail: 'body', platemail: 'body', ringmail: 'body',
});
const slotOfWord = word => {
    if (Object.hasOwn(NAME_SLOT, word)) return { slot: NAME_SLOT[word] };
    if (Object.hasOwn(COMPOUND_SLOT, word)) return { slot: COMPOUND_SLOT[word] };
    return null;
};
const foldHand = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/off[\s-]*hand/g, 'offhand');

// The stat a kind of thing raises when nothing else says (the name's last matching noun), else the slot's own (GEAR.slotStat).
const STAT_BY_NAME = Object.freeze({
    blade: 'DEX', sword: 'DEX', dagger: 'DEX', bow: 'DEX',
    axe: 'STR', hammer: 'STR', club: 'STR', spear: 'STR',
    staff: 'INT', wand: 'INT', tome: 'INT',
    mail: 'VIT', leather: 'VIT', plate: 'VIT', cuirass: 'VIT', robe: 'VIT', shield: 'VIT', buckler: 'VIT', helmet: 'VIT', helm: 'VIT', cap: 'VIT', hood: 'VIT',
    boot: 'AGI', shoe: 'AGI', sandal: 'AGI', cloak: 'AGI', cape: 'AGI', mantle: 'AGI',
    ring: 'LUK', amulet: 'LUK', pendant: 'LUK',
});

/**
 * The slot a `kind:` / `slot:` / `equipped:` word names: weapon, body (armour), off-hand (shield), head, cloak, feet or accessory
 * (`accessory-1` / `accessory-2` keep their number), or null.
 */
export function slotWordOf(value) {
    const text = foldHand(value);
    const place = /accessory[\s-]*([12])/.exec(text);
    if (place) return `accessory-${place[1]}`;
    for (const word of words(text)) if (Object.hasOwn(SLOT_WORD, word)) return SLOT_WORD[word];
    return null;
}

/** A slot as the place a piece is filed under: `accessory` → `accessory-1`; the others as they are. */
export const placeOf = slot => (slot === 'accessory' ? 'accessory-1' : slot);

/** The slot of a line's `kind:` / `slot:` word, else of the name (its last noun that says so), or null. */
export function gearSlotOf(kindWord, name) {
    const said = slotWordOf(kindWord);
    if (said) return said;
    const found = words(name).map(singular).map(slotOfWord).filter(Boolean);
    return found.length ? found.at(-1).slot : null;
}

// The five rarity words and their usual synonyms (a `rarity:` or `quality:` label).
const RARITY_WORD = Object.freeze({
    common: 'common', crude: 'common', poor: 'common', shoddy: 'common', plain: 'common', ordinary: 'common', simple: 'common', basic: 'common',
    uncommon: 'uncommon', fine: 'uncommon', good: 'uncommon', sturdy: 'uncommon', decent: 'uncommon', quality: 'uncommon',
    rare: 'rare', superior: 'rare', excellent: 'rare', masterwork: 'rare', exceptional: 'rare', exquisite: 'rare',
    epic: 'epic', heroic: 'epic', magnificent: 'epic', mythic: 'epic',
    legendary: 'legendary', fabled: 'legendary', artifact: 'legendary', divine: 'legendary',
});

/** The rarity a label's words name, or null (the first word that is one). */
export function gearRarityOf(value) {
    for (const word of words(value)) if (Object.hasOwn(RARITY_WORD, word)) return RARITY_WORD[word];
    return null;
}

/** The seven stats a record names with a positive whole number: { STR: 2 } (keys in any case; the rest is left out). */
export function statsOf(record) {
    const out = {};
    if (!isPlainObject(record)) return out;
    for (const key of Object.keys(record)) {
        const stat = String(key).trim().toUpperCase();
        if (GEAR.stats.includes(stat) && Number.isSafeInteger(record[key]) && record[key] > 0) out[stat] = (out[stat] ?? 0) + record[key];
    }
    return out;
}

/** The stats held to `budget` total points and to GEAR.maxStats different stats, in the order of GEAR.stats. */
export function withinBudget(stats, budget) {
    const out = {};
    let left = Math.max(0, budget);
    for (const stat of GEAR.stats) {
        if (Object.keys(out).length >= GEAR.maxStats) break;
        const n = Math.min(stats?.[stat] ?? 0, left);
        if (n > 0) { out[stat] = n; left -= n; }
    }
    return out;
}

/** The stat a piece raises when nothing says: its name's last matching noun, else its slot's default (null: no slot). */
export function defaultStat(name, slot) {
    const nouns = words(name).map(singular).filter(word => Object.hasOwn(STAT_BY_NAME, word));
    if (nouns.length) return STAT_BY_NAME[nouns[nouns.length - 1]];
    return GEAR.slotStat[baseOf(slot)] ?? null;
}

/**
 * The numbers a story-made item gets (the `item.define` step for `story-block.gear`): its `slot` (only while it has none),
 * `rarity` (only when the line names one) and `stats`: the ones the line names (`said.stats`, { DEX: 2 }), else the kind's or the
 * slot's, held to the rarity's budget. Other numbers on the line are never read. A rarity word reaches `epic` at most unless
 * `allowLegendary` (the same reply completed a quest or won a hard fight, or a module's reward) and to `ceiling` (the place's `loot.maxRarity`). A slot makes plain goods equipment.
 */
export function gearDefine(def, said = {}, { allowLegendary = false, ceiling = null, onHeld = null } = {}) {
    if (!def || typeof def !== 'object') return def;
    if (def.slot === null || def.slot === undefined) {
        const slot = gearSlotOf(said.slot ?? said.kind, def.name);
        if (slot) {
            def.slot = slot;
            if (def.kind === 'goods') def.kind = 'equipment';
        }
    }
    const rarity = gearRarityOf(said.rarity);
    if (rarity) {
        // The ceiling: epic for the story's own words (legendary only when earned), lowered further by the place's `loot.maxRarity`.
        let top = allowLegendary ? 'legendary' : GEAR.storyRarityMax;
        if (RANK.includes(ceiling) && RANK.indexOf(ceiling) < RANK.indexOf(top)) top = ceiling;
        def.rarity = RANK.indexOf(rarity) > RANK.indexOf(top) ? top : rarity;
        if (def.rarity !== rarity) onHeld?.(rarity, def.rarity);
    }
    if (def.slot && (!isPlainObject(def.stats) || !Object.keys(def.stats).length)) {
        const named = withinBudget(statsOf(said.stats), gearBudget(def));
        def.stats = Object.keys(named).length ? named : (statsFor(def));
    }
    return def;
}

/** Is this def one the reader made by hand (`hand: true`), with no story-given stack of it? Only then may the reader's Edit change its kind, slot, rarity or bonus. */
export const handDef = (inventory, def) => def?.hand === true
    && !Object.values(isPlainObject(inventory?.stacks) ? inventory.stacks : {}).some(stack => stack?.def === def.id && stack.story === true);

/** A pack item's explicit bonus (0…6), only for a `pack.` def; else null. */
export const packBonus = (id, value) => (typeof id === 'string' && id.startsWith('pack.') && Number.isSafeInteger(value) && value >= 0 && value <= GEAR.bonusMax ? value : null);

/** The stat points a def may give while worn and whole: the pack's explicit `bonus`, else by rarity. */
export function gearBudget(def) {
    const explicit = packBonus(def?.id, def?.bonus);
    if (explicit !== null) return explicit;
    return Object.hasOwn(GEAR.budget, def?.rarity) ? GEAR.budget[def.rarity] : 0;
}

/**
 * The stats a def gives while worn and whole: the ones it lists (`stats: { DEX: 2 }`) held to its budget, else the budget on the stat
 * its name or slot suggests. Nothing without a slot, or with a budget of 0.
 */
export function statsFor(def) {
    const budget = gearBudget(def);
    if (!def?.slot || budget <= 0) return {};
    const listed = withinBudget(statsOf(def.stats), budget);
    if (Object.keys(listed).length) return listed;
    const stat = defaultStat(def.name, def.slot);
    return stat ? { [stat]: budget } : {};
}

const baseOf = key => (typeof key === 'string' ? key.trim().replace(/-\d+$/, '') : null);
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

/** Encumbered: carrying something and at or over the capacity (100 % and more, as approved; an empty load is never encumbered). */
export const atLimit = (load, capacity) => load > 0 && load >= capacity;

/** The load bands of the Carry card: `over` (red, "Encumbered") from 100 % (the same test as the encumbered condition), `heavy` (yellow) from 80 % to below 100 %. */
export function loadLevel(load, capacity) {
    if (atLimit(load, capacity)) return 'over';
    return capacity > 0 && load * 5 >= capacity * 4 ? 'heavy' : 'normal';
}

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
