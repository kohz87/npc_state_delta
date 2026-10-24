// Lookups over the enabled packs (pure). Every function takes the normalized packs in
// list order (validate.js `pack`), so the same list always gives the same answer.
//
// Order decides ties: a pack earlier in the installed list wins over a later one, for an
// item name two packs both define and for the start place.

import { CONTENT_KINDS, DEFAULT_CRAFTS } from './limits.js';
import { slugify } from './validate.js';
import { foldKey } from '../../text.js';

// The inventory def fields (SPEC §7), in a fixed order.
const DEF_FIELDS = ['id', 'name', 'kind', 'rarity', 'value', 'stack', 'slot', 'stats', 'effect', 'tags', 'note'];

const copy = value => JSON.parse(JSON.stringify(value));

/**
 * The item as an inventory def (SPEC §7): `{ id: 'pack.<id>/<slug>', name, kind, … }`, with its `carry`
 * (the carry capacity it adds, PACKS.md "Carry capacity") when it has one.
 */
export function itemDef(item) {
    const def = {};
    for (const field of DEF_FIELDS) def[field] = copy(item[field]);
    if (Number.isSafeInteger(item.carry) && item.carry > 0) def.carry = item.carry;
    return def;
}

/**
 * The enabled packs' items as inventory defs by definition ID: `[def…]`, ID-sorted, each ID once (the first
 * pack that has it wins, as for names). `ids` narrows to those full IDs (`pack.<id>/<slug>`; unknown ones
 * are left out). A rules module freezes these into the chat (inventory.registerDefinition), after which the
 * chat's own copy answers `inventory.definitions` whether or not the pack is still installed; this is the
 * lookup that reads them while it is. Fresh copies.
 */
export function itemDefsIn(packs, ids = null) {
    const wanted = Array.isArray(ids) ? new Set(ids.filter(id => typeof id === 'string')) : null;
    const found = new Map();
    for (const pack of packs) {
        for (const item of pack.content.items) {
            if (found.has(item.id) || (wanted && !wanted.has(item.id))) continue;
            found.set(item.id, itemDef(item));
        }
    }
    return [...found.keys()].sort().map(id => found.get(id));
}

/**
 * Records of one kind from every enabled pack, in pack order then file order.
 * `kind`: a content kind (items, creatures, shops, recipes, events, quests, races, talents,
 * skills, presets, places, routes, terms: `{ id, slug, pack, name?, levelName?, xpName?, tiers? }`, the
 * words a world uses for levels and XP, MODULES §F25; ranks: `{ id, pack, title?, levels?, reward? }`,
 * each pack's ladder lowest first, so a reader takes one pack's ranks; crafts: `{ id, slug, pack, title,
 * stats, stations, note? }`, see craftsOf for the merged table; meterPresets: `{ id, slug, pack, title,
 * meters, stages? }`, ready-made NPC meter sets),
 * `currency` (one `{ pack, name, short }` per pack that suggests one), `layouts`,
 * `screens` (each with its `pack`), or `theme` (one `{ pack, tokens }` per pack that has a
 * theme). Unknown kinds give [].
 * `pack` narrows to one pack id.
 */
export function contentOf(packs, kind, { pack = null } = {}) {
    if (kind === 'currency') return copy(packs.filter(entry => entry.currency && (!pack || entry.id === pack)).map(entry => ({ pack: entry.id, ...entry.currency })));
    const chosen = pack ? packs.filter(entry => entry.id === pack) : packs;
    if (CONTENT_KINDS.includes(kind)) return copy(chosen.flatMap(entry => entry.content[kind] ?? []));
    if (kind === 'layouts' || kind === 'screens') return copy(chosen.flatMap(entry => entry[kind]));
    if (kind === 'theme') return copy(chosen.filter(entry => Object.keys(entry.theme).length).map(entry => ({ pack: entry.id, tokens: entry.theme })));
    return [];
}

/**
 * The calendar for the story clock: the first enabled pack (in list order) that has one, as
 * `{ pack, era, months: [{ name, days }], start: { year, month, day, hour, minute } | null }`,
 * or null. `start.month` is the month's name. Calendars are not mixed across packs.
 */
export function calendarOf(packs) {
    const pack = packs.find(entry => entry.calendar);
    return pack ? copy({ pack: pack.id, ...pack.calendar }) : null;
}

/**
 * The weather table of the first enabled pack (in list order) that has one (MODULES §F122), as
 * `{ pack, seasons: [{ name, months }], tables: [{ season, region, weather: [text] }] }`, or null.
 * Tables are not mixed across packs. Read by a module that sets the weather by rule (Story Director).
 */
export function weatherOf(packs) {
    const pack = packs.find(entry => entry.weather);
    return pack ? copy({ pack: pack.id, seasons: pack.weather.seasons ?? [], tables: pack.weather.tables }) : null;
}

/**
 * The money scale of the first enabled pack (in list order) that sets one, as `{ pack, scale, note }`, or
 * null (MODULES §F104). Scales are not mixed across packs. Story Block's `inventory.economy` reads it.
 */
export function economyOf(packs) {
    const pack = packs.find(entry => entry.economy);
    return pack ? { pack: pack.id, scale: pack.economy.scale, note: pack.economy.note } : null;
}

/**
 * The craft table crafting reads (MODULES §F102): the default crafts with the enabled packs' `crafts`
 * laid over them, as `[{ craft, title, stats, stations, note?, pack }]`. `craft` is the id recipes
 * write ('alchemy'); `pack` is null for a default. A pack's craft with a default's id replaces it in
 * place; a new id is added after the defaults, in pack order. When two packs declare the same craft,
 * the pack earlier in the list wins, as for items.
 */
export function craftsOf(packs) {
    const table = new Map(DEFAULT_CRAFTS.map(craft => [craft.craft, { ...copy(craft), pack: null }]));
    const taken = new Set();
    for (const pack of packs) {
        for (const craft of pack.content.crafts ?? []) {
            if (taken.has(craft.slug)) continue;
            taken.add(craft.slug);
            table.set(craft.slug, { craft: craft.slug, title: craft.title, stats: [...craft.stats], stations: [...craft.stations], ...(craft.note ? { note: craft.note } : {}), pack: pack.id });
        }
    }
    return [...table.values()];
}

/**
 * The pack item a story name means, as an inventory def, or null.
 *
 * Precedence: a full def ID (`pack.fantasy/iron-sword`) names that item; else the first
 * enabled pack whose item has that name or alias (case and width folded); else the first
 * whose item slug equals the name's slug ("Iron-Sword!" → `iron-sword`). Inventory checks
 * its own aliases first and creates a `story/<slug>` def only when this returns null.
 */
export function resolveItemIn(packs, name) {
    const text = String(name ?? '').trim();
    if (!text) return null;
    if (text.startsWith('pack.') && text.includes('/')) {
        for (const pack of packs) for (const item of pack.content.items) if (item.id === text) return itemDef(item);
        return null;
    }
    const key = foldKey(text);
    for (const pack of packs) {
        for (const item of pack.content.items) if (foldKey(item.name) === key || item.aliases.some(alias => foldKey(alias) === key)) return itemDef(item);
    }
    const slug = slugify(text);
    if (!slug) return null;
    for (const pack of packs) for (const item of pack.content.items) if (item.slug === slug) return itemDef(item);
    return null;
}

/**
 * The enabled packs' `start` merged into one (SPEC §2.6):
 * `{ scene: { place, present }, inventory: { items: [{ def, aliases, qty, note }], money }, currency, packs, problems }`.
 *
 * * `place`: the first pack (in list order) that names one; places are not mixed field by field.
 * * `present`: every name once, in pack order.
 * * `items`: in pack order; the same def with the same note is one line with the quantities added.
 *   A start item from another pack that is not enabled is left out and listed in `problems`.
 * * `money`: added up, a whole number of the chat's one currency.
 * * `currency`: the first enabled pack's suggested `{ name, short }`, or null. The host uses it only
 *   when the reader has not named the currency.
 * * `packs`: the ids of the packs that gave something.
 */
export function mergeStart(packs) {
    const out = { scene: { place: null, present: [] }, inventory: { items: [], money: 0 }, currency: null, packs: [], problems: [] };
    const items = new Map();
    for (const item of packs.flatMap(pack => pack.content.items)) if (!items.has(item.id)) items.set(item.id, item);
    const present = new Set();
    for (const pack of packs) {
        if (pack.currency && !out.currency) out.currency = copy(pack.currency);
        const start = pack.start;
        if (!start) continue;
        let gave = false;
        if (start.scene.place && !out.scene.place) {
            out.scene.place = copy(start.scene.place);
            gave = true;
        }
        for (const name of start.scene.present) {
            gave = true;
            if (present.has(foldKey(name))) continue;
            present.add(foldKey(name));
            out.scene.present.push(name);
        }
        for (const line of start.inventory.items) {
            const item = items.get(line.item);
            if (!item) {
                out.problems.push(`${pack.name} starts with ${line.item}, but the pack that defines it is not enabled.`);
                continue;
            }
            gave = true;
            const same = out.inventory.items.find(entry => entry.def.id === item.id && entry.note === line.note);
            if (same) same.qty += line.qty;
            else out.inventory.items.push({ def: itemDef(item), aliases: [...item.aliases], qty: line.qty, note: line.note });
        }
        if (start.inventory.money) {
            gave = true;
            out.inventory.money += start.inventory.money;
        }
        if (gave) out.packs.push(pack.id);
    }
    return out;
}

/**
 * Writes a merged start into an initial State (SPEC §2.6, shapes of SPEC §7) and returns the
 * new State; `state` is not changed. Only the `scene` and `inventory` slices that exist are
 * touched. `id(prefix)` makes record IDs (the host passes `sdk.id`); `coin` is the wallet key,
 * `coin` by default (MODULES §F1: `wallets[owner] = { coin: n }`).
 *
 * * The start place is used only when the scene has no place yet; present names are added once.
 * * Each start item adds its def (if inventory has none with that ID), its name and aliases to
 *   `aliases` (where free), and a party stack; an item that does not stack gets one stack each.
 * * Money is added to the party's wallet under `coin`.
 */
export function applyStart(state, start, { id, coin = 'coin' } = {}) {
    if (typeof id !== 'function') throw new Error('applyStart needs an id(prefix) function.');
    const next = copy(state);
    const scene = next.domains?.scene;
    if (scene && start.scene) {
        if (start.scene.place && !scene.place?.name) scene.place = copy(start.scene.place);
        if (Array.isArray(scene.present)) {
            const here = new Set(scene.present.map(foldKey));
            for (const name of start.scene.present) if (!here.has(foldKey(name))) { here.add(foldKey(name)); scene.present.push(name); }
        }
    }
    const inventory = next.domains?.inventory;
    if (inventory && start.inventory) {
        inventory.defs ??= {};
        inventory.stacks ??= {};
        inventory.wallets ??= {};
        inventory.aliases ??= {};
        for (const line of start.inventory.items) {
            const def = line.def;
            inventory.defs[def.id] ??= copy(def);
            for (const name of [def.name, ...(line.aliases ?? [])]) inventory.aliases[foldKey(name)] ??= def.id;
            const stacks = def.stack ? [line.qty] : Array.from({ length: line.qty }, () => 1);
            for (const qty of stacks) {
                const stackId = id('it');
                inventory.stacks[stackId] = { id: stackId, def: def.id, qty, owner: 'party', equipped: null, note: line.note ?? '', from: '' };
            }
        }
        if (start.inventory.money) {
            const wallet = inventory.wallets.party ??= {};
            wallet[coin] = (wallet[coin] ?? 0) + start.inventory.money;
        }
    }
    return next;
}
