// Gear's slots, rarity, stat budgets and story-made definitions (moved out of domains/gear.js unchanged;
// gear.js re-exports every public name). gearDefine updates the supplied item definition in place.

import { isPlainObject } from '../common.js';

export const GEAR = Object.freeze({
    // The slots a piece can occupy; every one gives its stats.
    slots: Object.freeze(['weapon', 'body', 'off-hand', 'head', 'cloak', 'feet', 'accessory']),
    // The keys a worn piece is filed under (accessories have two places).
    places: Object.freeze(['weapon', 'body', 'off-hand', 'head', 'cloak', 'feet', 'accessory-1', 'accessory-2']),
    // The seven stats a piece can raise, and the one each slot raises when nothing else says.
    stats: Object.freeze(['STR', 'VIT', 'AGI', 'DEX', 'INT', 'LUK', 'CHA']),
    slotStat: Object.freeze({ weapon: 'STR', body: 'VIT', 'off-hand': 'VIT', head: 'VIT', cloak: 'AGI', feet: 'AGI', accessory: 'LUK' }),
    // The total stat points a rarity gives (Plan A: stats stay 1–20, so gear stays small).
    budget: Object.freeze({ common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 }),
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
