// pack.json validation and normalization (SPEC §9; pure).
//
// validatePack(input, options) → { ok: true, pack, raw } | { ok: false, errors: [{ code, path, message }] }
//
// `input` is the file's text or an already parsed value. The checks run in three rounds,
// each only when the one before passed: size and JSON, plain safe data (safety.js), then
// the fields. `pack` is the normalized form every lookup uses: content records get their
// namespaced ID (`pack.<id>/<slug>`), defaults filled in, item references inside the pack
// written as full IDs. `raw` is a detached copy of what was given, the form kept in settings.
//
// Options: `hostVersion` (Story Block's version, checked against requires.storyBlock) and
// `capabilities` (the capability names this Story Block has, or null when unknown: then
// requires.capabilities is checked for form only).
//
// A pack with a rules manifest (`content.rules`, RB_CONTRACT §7; PACKS.md "Rules packs") also goes through the
// rules checker (rules-v2.js), on the raw data, once the pass below has found nothing wrong with the envelope and
// the records this file owns (so the checker does not repeat that pass: `envelope: false`) and before the manifest
// is wrapped. The definitions the manifest owns (creatures, quests, shops, recipes) are then stored as the
// checker resolved them, nested slugs written as full IDs. A pack without the manifest never meets the checker:
// its creatures and quests stay open records, as they always were. The result then also carries `rulesHash` and
// `packHash` (the checker's two hashes).

import { CALENDAR_FIELDS, CALENDAR_HOLIDAY_FIELDS, CALENDAR_LIMITS, CALENDAR_START_FIELDS, CHOICE_FIELDS, CONTENT_KINDS, COMMAND, CRAFT_FIELDS, ECONOMY_FIELDS, ECONOMY_LIMITS, CRAFTS_LIMITS, DEFAULT_CRAFTS, METER_FIELDS, METER_LIMITS, METER_PRESET_FIELDS, METER_RESERVED, METER_STAGE_FIELDS, RECIPE_LIMITS, STAT_SUM, DEF_ID, EVENT_FIELDS, EVENT_LIMITS, ITEM_FIELDS, ITEM_KINDS, LIMITS, MOUNTS, PACK_FIELDS, PACK_ID, PLACE_FIELDS, PRESET_FIELDS, RARITIES, ROUTE_FIELDS, SCREEN_FIELDS, SCREEN_ID, SEMVER, SKILL_FIELDS, SKILL_TARGETS, SKILL_TYPES, SLUG, START_FIELDS, STAT_NAME, RANK_FIELDS, RANK_ID, RANKS_LIMITS, TERM_SEPARATORS, ITEM_CARRY, MARKET_FIELDS, MARKET_LIMITS, MARKET_WORD, TERMS_FIELDS, TERMS_LIMITS, TERMS_NUMERALS, TERMS_TIER_FIELDS, WEATHER_FIELDS, WEATHER_LIMITS, WEATHER_SEASON_FIELDS, WEATHER_TABLE_FIELDS } from './limits.js';
import { byteLength, checkPlain } from './safety.js';
import { parseRange, satisfies } from './version.js';
import { foldKey, oneLine } from '../../text.js';
import { MAX_DEPTH as MAX_TEMPLATE_DEPTH, tooDeep } from '../view/template/html.js';
import { MAX_LOOP_DEPTH, templateShape } from '../view/template/index.js';
import { MAX_JSON_DEPTH } from '../view/template/json.js';
import { MAX_AT_DEPTH, cssDepth, sheetEscape } from '../view/css.js';
import { MAX_COINS, MAX_COIN_VALUE, coinsOf } from '../domains/money.js';
// rules-v2.js imports this file back (it checks the rest of a pack with validatePack); both only use the
// other's exports when called, never while loading, so the cycle is harmless.
import { validateRulesPack } from './rules-v2.js';

export const HOST_VERSION = '2.0.0';

/** A slug for a display name: "Iron Sword (old)" → "iron-sword-old". */
export function slugify(name) {
    return String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value, min = 0) => Number.isInteger(value) && value >= min;
const fullId = (packId, slug) => `pack.${packId}/${slug}`;

/**
 * Checks and normalizes one pack. Nothing here touches settings or state.
 */
export function validatePack(input, { hostVersion = HOST_VERSION, capabilities = null, limits = LIMITS } = {}) {
    let value = input;
    if (typeof input === 'string') {
        if (byteLength(input) > limits.packBytes) return fail('TOO_LARGE', '', `The pack is larger than ${Math.round(limits.packBytes / 1024)} KB.`);
        const text = input.replace(/^﻿/, '').trim();
        if (!text) return fail('NOT_JSON', '', 'The pack is empty.');
        try {
            value = JSON.parse(text);
        } catch (error) {
            return fail('NOT_JSON', '', `The pack is not valid JSON (${error.message}).`);
        }
    }
    if (!isObject(value)) return fail('NOT_OBJECT', '', 'A pack is one JSON object: { "id": …, "version": …, "requires": …, "content": … }.');
    const unsafe = checkPlain(value, limits);
    if (unsafe.length) return { ok: false, errors: unsafe };
    // Detached plain copy: nothing the caller still holds can change the pack later.
    const raw = JSON.parse(JSON.stringify(value));
    if (byteLength(JSON.stringify(raw)) > limits.packBytes) return fail('TOO_LARGE', '', `The pack is larger than ${Math.round(limits.packBytes / 1024)} KB.`);

    const errors = [];
    const add = (code, path, message) => { if (errors.length < limits.errors) errors.push({ code, path, message }); };
    const rules = { checked: false };
    const pack = normalize(raw, { add, failed: () => errors.length > 0, rules, hostVersion, capabilities, limits });
    if (errors.length) return { ok: false, errors };
    const result = { ok: true, pack, raw };
    if (rules.checked) {
        // The checker's hashes cost about a sixth of its check and most readers (the installed list on every page load) never
        // ask for them: they are worked out the first time one is read, from the raw pack, and kept.
        let again = null;
        const hash = name => () => {
            again ??= validateRulesPack(raw, { capabilities, hostVersion, limits, envelope: false });
            return again.ok ? again[name] : undefined;
        };
        Object.defineProperty(result, 'rulesHash', { get: hash('rulesHash'), enumerable: false, configurable: true });
        Object.defineProperty(result, 'packHash', { get: hash('packHash'), enumerable: false, configurable: true });
    }
    return result;
}

function fail(code, path, message) {
    return { ok: false, errors: [{ code, path, message }] };
}

function normalize(raw, { add, failed, rules: seen, hostVersion, capabilities, limits }) {
    for (const key of Object.keys(raw)) if (!PACK_FIELDS.includes(key)) add('UNKNOWN_FIELD', key, `"${key}" is not a pack field (expected ${PACK_FIELDS.join(', ')}).`);

    const id = raw.id;
    if (typeof id !== 'string' || !PACK_ID.test(id)) add('BAD_ID', 'id', 'id must be 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit (like "fantasy-basics").');
    const packId = typeof id === 'string' && PACK_ID.test(id) ? id : 'invalid';
    if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) add('BAD_VERSION', 'version', 'version must look like 1.0.0.');
    for (const field of ['name', 'author']) {
        if (raw[field] !== undefined && (typeof raw[field] !== 'string' || raw[field].length > limits.name)) add('BAD_FIELD', field, `${field} must be text of at most ${limits.name} characters.`);
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') add('BAD_FIELD', 'description', 'description must be text.');

    const requires = checkRequires(raw.requires, { add, hostVersion, capabilities });
    // A rules pack's money may carry `display` and an empty coin list (schema 2, which the checker reads); the old check does not know them.
    const rules = isObject(raw.content) && raw.content.rules !== undefined;
    const currency = raw.currency === undefined ? null : checkCurrency(rules ? withoutRulesMoney(raw.currency) : raw.currency, add);
    const calendar = raw.calendar === undefined ? null : checkCalendar(raw.calendar, add);
    const economy = raw.economy === undefined ? null : checkEconomy(raw.economy, add);
    const weather = raw.weather === undefined ? null : checkWeather(raw.weather, add);

    const content = {};
    if (raw.content !== undefined && !isObject(raw.content)) add('BAD_CONTENT', 'content', 'content must be an object of lists: { "items": [ … ], "events": [ … ] }.');
    const given = isObject(raw.content) ? raw.content : {};
    for (const kind of Object.keys(given)) if (!CONTENT_KINDS.includes(kind)) add('UNKNOWN_KIND', `content.${kind}`, `"${kind}" is not a content kind (expected ${CONTENT_KINDS.join(', ')}).`);
    // Items first: shops, recipes and the start state refer to them.
    const items = records(given.items, 'items', { add, packId, check: (record, path, label) => checkItem(record, path, label, add) });
    content.items = items;
    const ref = itemRefs(items, packId);
    // With a rules manifest these are checked again below, by the rules checker, and stored as it resolved them.
    content.creatures = records(given.creatures, 'creatures', { add, packId, check: openRecord });
    content.shops = records(given.shops, 'shops', { add, packId, check: (record, path) => checkShop(record, path, add, ref) });
    // Crafts before recipes: a recipe's `craft` is a default craft or one this pack declares.
    const crafts = given.crafts === undefined ? null : checkCrafts(given.crafts, packId, add);
    const craftIds = new Set([...DEFAULT_CRAFTS.map(craft => craft.craft), ...(crafts ?? []).map(craft => craft.slug)]);
    content.recipes = records(given.recipes, 'recipes', { add, packId, check: (record, path) => checkRecipe(record, path, add, ref, craftIds) });
    content.events = records(given.events, 'events', { add, packId, check: (record, path) => checkEvent(record, path, add), slugField: 'id' });
    content.quests = records(given.quests, 'quests', { add, packId, check: openRecord });
    content.races = records(given.races, 'races', { add, packId, check: (record, path, label) => checkChoice(record, path, label, add), slugField: 'id', named: true });
    content.talents = records(given.talents, 'talents', { add, packId, check: (record, path, label) => checkChoice(record, path, label, add), slugField: 'id', named: true });
    linkEvents(content.events, packId, add);
    // Kinds added later are kept only when given, so older packs normalize as they always did.
    if (given.skills !== undefined) content.skills = records(given.skills, 'skills', { add, packId, check: (record, path, label) => checkSkill(record, path, label, add) });
    if (given.presets !== undefined) {
        const choose = { race: choiceRefs(content.races), talent: choiceRefs(content.talents), skill: choiceRefs(content.skills ?? []) };
        content.presets = records(given.presets, 'presets', { add, packId, check: (record, path, label) => checkPreset(record, path, label, add, choose), slugField: 'id', named: true });
    }
    if (given.places !== undefined) content.places = records(given.places, 'places', { add, packId, check: (record, path, label) => checkPlace(record, path, label, add) });
    if (given.routes !== undefined) {
        const place = placeRefs(content.places ?? []);
        content.routes = records(given.routes, 'routes', { add, packId, check: (record, path) => checkRoute(record, path, add, place), named: false, autoSlug: routeSlug });
    }
    if (given.terms !== undefined) {
        if (Array.isArray(given.terms) && given.terms.length > TERMS_LIMITS.records) add('BAD_CONTENT', 'content.terms', `content.terms holds at most ${TERMS_LIMITS.records} records (RPG Battle reads the first one that names something).`);
        else content.terms = records(given.terms, 'terms', { add, packId, check: (record, path, label) => checkTerms(record, path, label, add), slugField: 'id', named: false, autoSlug: termsSlug() });
    }
    if (given.ranks !== undefined) content.ranks = checkRanks(given.ranks, packId, add);
    if (given.markets !== undefined) content.markets = checkMarkets(given.markets, packId, add);
    if (crafts !== null) content.crafts = crafts;
    if (given.meterPresets !== undefined) {
        if (Array.isArray(given.meterPresets) && given.meterPresets.length > METER_LIMITS.presets) add('BAD_CONTENT', 'content.meterPresets', `content.meterPresets holds at most ${METER_LIMITS.presets} presets.`);
        else content.meterPresets = records(given.meterPresets, 'meterPresets', { add, packId, check: (record, path) => checkMeterPreset(record, path, add), slugField: 'id', named: false });
    }

    const start = raw.start === undefined ? null : checkStart(raw.start, add, ref);
    let layouts = [];
    if (raw.layouts !== undefined) {
        if (!Array.isArray(raw.layouts) || raw.layouts.some(layout => !isObject(layout))) add('BAD_LAYOUTS', 'layouts', 'layouts must be a list of layout objects.');
        else layouts = raw.layouts.map(layout => ({ ...layout, pack: packId }));
    }
    const screens = raw.screens === undefined ? [] : checkScreens(raw.screens, packId, add);
    const theme = raw.theme === undefined ? {} : checkTheme(raw.theme, add, 'theme');

    // Everything this file owns has been looked at; the rules checker takes the manifest and its definitions from here.
    if (rules) reserveRulesSlug(content, packId, add);
    if (rules && !failed()) checkRules(raw, { add, seen, content, currency, packId, hostVersion, capabilities, limits });

    return {
        id: packId,
        version: raw.version,
        name: oneLine(raw.name || packId, limits.name),
        author: oneLine(raw.author ?? '', limits.name),
        description: String(raw.description ?? ''),
        requires,
        currency,
        economy,
        calendar,
        // Kept only when given, so older packs normalize as they always did.
        ...(weather ? { weather } : {}),
        content,
        start,
        layouts,
        screens,
        theme,
    };
}

function checkRequires(requires, { add, hostVersion, capabilities }) {
    const out = { storyBlock: '', capabilities: [] };
    if (!isObject(requires)) {
        add('BAD_REQUIRES', 'requires', 'requires must say which Story Block it needs: { "storyBlock": "^2" }.');
        return out;
    }
    for (const key of Object.keys(requires)) if (key !== 'storyBlock' && key !== 'capabilities') add('UNKNOWN_FIELD', `requires.${key}`, `"${key}" is not a requires field (expected storyBlock, capabilities).`);
    if (typeof requires.storyBlock !== 'string' || !parseRange(requires.storyBlock)) add('BAD_REQUIRES', 'requires.storyBlock', 'requires.storyBlock must be a version range like "^2".');
    else if (!satisfies(hostVersion, requires.storyBlock)) add('HOST_VERSION', 'requires.storyBlock', `This pack needs Story Block ${requires.storyBlock}; this is ${hostVersion}.`);
    else out.storyBlock = requires.storyBlock;
    if (requires.capabilities !== undefined) {
        const list = requires.capabilities;
        if (!Array.isArray(list) || list.some(name => typeof name !== 'string' || !SLUG.test(name))) {
            add('BAD_REQUIRES', 'requires.capabilities', 'requires.capabilities must be a list of names like "inventory" or "party".');
        } else {
            out.capabilities = [...new Set(list)];
            const missing = capabilities ? out.capabilities.filter(name => !capabilities.includes(name)) : [];
            if (missing.length) add('MISSING_CAPABILITY', 'requires.capabilities', `This pack needs ${missing.join(', ')}, which no installed module provides.`);
        }
    }
    return out;
}

// One content list: every record an object, a unique slug, the record's own check.
// `slugField`: the record's own slug field (`slug`, or `id` for events, races and talents);
// `named`: the record needs a name (always for `slug` records); `autoSlug(record)`: the slug of a
// record without a name (routes) when it gives none.
function records(list, kind, { add, packId, check, slugField = 'slug', named = slugField === 'slug', autoSlug = null }) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
        add('BAD_CONTENT', `content.${kind}`, `content.${kind} must be a list.`);
        return [];
    }
    const out = [];
    const seen = new Set();
    list.forEach((record, index) => {
        const path = `content.${kind}[${index}]`;
        if (!isObject(record)) return add('BAD_RECORD', path, `${path} must be an object.`);
        const label = typeof record.name === 'string' ? `"${record.name}"` : path;
        if (named) {
            if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > LIMITS.name) return add('BAD_RECORD', `${path}.name`, `${path} needs a name of 1 to ${LIMITS.name} characters.`);
        }
        const given = record[slugField];
        let slug;
        if (given !== undefined || (!named && !autoSlug)) {
            if (typeof given !== 'string' || !SLUG.test(given)) return add('BAD_RECORD', `${path}.${slugField}`, `${label}: ${slugField} must be lowercase letters, digits and dashes (like "iron-sword").`);
            slug = given;
        } else if (!named) {
            slug = autoSlug(record);
            if (!slug) return add('BAD_RECORD', path, `${label}: give a "${slugField}".`);
        } else {
            slug = slugify(record.name);
            if (!slug) return add('BAD_RECORD', `${path}.name`, `${label}: the name needs at least one letter or digit, or give a "slug".`);
        }
        if (seen.has(slug)) return add('DUPLICATE', path, `${label}: two ${kind} share the slug "${slug}".`);
        seen.add(slug);
        const normalized = check(record, path, label);
        if (normalized) out.push({ ...normalized, id: fullId(packId, slug), slug, pack: packId });
    });
    return out;
}

// Records whose fields another part owns (creatures, quests …): any plain data, kept as is.
function openRecord(record) {
    const { slug: _slug, id: _id, pack: _pack, ...rest } = record;
    return { ...rest, name: oneLine(record.name, LIMITS.name) };
}

// A record without the host's wrapper fields (records() adds them back).
function bare(record) {
    const { slug: _slug, id: _id, pack: _pack, ...rest } = record;
    return rest;
}

// A rules pack's money without what only schema 2 knows: `display`, and an empty coin list (the checker reads both).
function withoutRulesMoney(currency) {
    if (!isObject(currency)) return currency;
    const { display: _display, ...rest } = currency;
    if (Array.isArray(rest.coins) && rest.coins.length === 0) delete rest.coins;
    return rest;
}

// The rules checker's turn (RB_CONTRACT §7): it gets the raw pack, with the envelope pass skipped because it has just been made.
// Its errors keep its codes and paths, except that unsafe text is `UNSAFE_HTML` here whoever found it. What it owns (creatures,
// quests, shops, recipes) replaces the bodies of the records already wrapped (id, slug and pack stay), as it resolved them; the
// manifest becomes one more record (name and slug, so `pack.<id>/rules`), and the pack's money gets its schema-2 `display`.
// The manifest is `pack.<id>/rules`; no other record of the pack may take that ID.
function reserveRulesSlug(content, packId, add) {
    const taken = fullId(packId, 'rules');
    for (const [kind, list] of Object.entries(content)) {
        if (!Array.isArray(list)) continue;
        list.forEach((record, index) => {
            if (record?.id === taken) add('DUPLICATE', `content.${kind}[${index}]`, `content.${kind}[${index}] has the slug "rules", which is the rules manifest's own (${taken}); give it another slug.`);
        });
    }
}

function checkRules(raw, { add, seen, content, currency, packId, hostVersion, capabilities, limits }) {
    const checked = validateRulesPack(raw, { capabilities, hostVersion, limits, envelope: false, hashes: false });
    if (!checked.ok) {
        for (const error of checked.errors) add(error.code === 'unsafe-markup' ? 'UNSAFE_HTML' : error.code, error.path, error.message);
        return;
    }
    for (const [kind, table] of [['creatures', 'foes'], ['quests', 'quests'], ['shops', 'shops'], ['recipes', 'recipes']]) {
        content[kind] = content[kind].map((record, index) => {
            const found = checked.resolved[table]?.[record.id];
            if (found) return { ...bare(found), id: record.id, slug: record.slug, pack: record.pack };
            add('BAD_RECORD', `content.${kind}[${index}]`, `content.${kind}[${index}] was not resolved by the rules checker.`);
            return record;
        });
    }
    // The manifest: the id, slug and pack are the host's and sit outside what the checker's closed schema allows.
    content.rules = records(checked.pack.content.rules, 'rules', { add, packId, check: manifest => bare(manifest) });
    if (currency && isObject(checked.pack.currency)) currency.display = checked.pack.currency.display;
    seen.checked = true;
}

function checkItem(record, path, label, add) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!ITEM_FIELDS.includes(key)) say(key, `"${key}" is not an item field (expected ${ITEM_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const kind = record.kind ?? 'goods';
    if (!ITEM_KINDS.includes(kind)) say('kind', `kind must be one of ${ITEM_KINDS.join(', ')}.`);
    const rarity = record.rarity ?? 'common';
    if (!RARITIES.includes(rarity)) say('rarity', `rarity must be one of ${RARITIES.join(', ')}.`);
    const value = record.value ?? 0;
    if (!isInt(value)) say('value', 'value must be a whole number of 0 or more (of the chat\'s currency).');
    // Equipment never stacks: each piece is its own stack (MODULES §F.6).
    const stack = record.stack ?? kind !== 'equipment';
    if (typeof stack !== 'boolean') say('stack', 'stack must be true or false.');
    else if (stack && kind === 'equipment') say('stack', 'equipment does not stack; leave "stack" out.');
    const slot = record.slot ?? null;
    if (slot !== null && (typeof slot !== 'string' || !slot.trim() || slot.length > 40)) say('slot', 'slot must be a short name like "weapon", or null.');
    const stats = record.stats ?? {};
    if (!isObject(stats) || Object.values(stats).some(n => !Number.isInteger(n))) say('stats', 'stats must map names to whole numbers: { "STR": 2 }.');
    const effect = record.effect ?? {};
    if (!isObject(effect)) say('effect', 'effect must be an object, like { "heal": 20 }.');
    const tags = record.tags ?? [];
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) say('tags', 'tags must be a list of short words.');
    const aliases = record.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > LIMITS.name)) say('aliases', 'aliases must be a list of other names for the item.');
    const note = record.note ?? '';
    if (typeof note !== 'string' || note.length > 500) say('note', 'note must be text of at most 500 characters.');
    // The carry capacity it adds while owned (worn, for equipment): PACKS.md "Carry capacity".
    if (record.carry !== undefined && !(isInt(record.carry, ITEM_CARRY.min) && record.carry <= ITEM_CARRY.max)) say('carry', `carry must be a whole number from ${ITEM_CARRY.min} to ${ITEM_CARRY.max} (the carry capacity it adds), or left out.`);
    if (!ok) return null;
    return {
        name: oneLine(record.name, LIMITS.name), kind, rarity, value, stack,
        slot: slot === null ? null : slot.trim(), stats: { ...stats }, effect: { ...effect },
        tags: tags.map(tag => tag.trim()), note,
        aliases: [...new Set(aliases.map(alias => oneLine(alias, LIMITS.name)))],
        ...(record.carry !== undefined ? { carry: record.carry } : {}),
    };
}

// How a reference to an item is written inside a pack: an item's slug or name from this
// pack, or a full def ID (`story/rope`, `pack.other/iron-sword`). Returns the full ID or null.
function itemRefs(items, packId) {
    const bySlug = new Map(items.map(item => [item.slug, item.id]));
    const byName = new Map();
    for (const item of items) for (const name of [item.name, ...item.aliases]) if (!byName.has(foldKey(name))) byName.set(foldKey(name), item.id);
    return value => {
        if (typeof value !== 'string' || !value.trim()) return null;
        if (value.includes('/')) return DEF_ID.test(value) ? value : null;
        return bySlug.get(value) ?? byName.get(foldKey(value)) ?? null;
    };
}

function checkShop(record, path, add, ref) {
    const base = openRecord(record);
    if (record.stock === undefined) return { ...base, stock: [] };
    if (!Array.isArray(record.stock)) {
        add('BAD_RECORD', `${path}.stock`, `"${record.name}": stock must be a list of items.`);
        return null;
    }
    const stock = [];
    let ok = true;
    record.stock.forEach((entry, index) => {
        const at = `${path}.stock[${index}]`;
        const line = typeof entry === 'string' ? { item: entry } : entry;
        if (!isObject(line)) { ok = false; return add('BAD_RECORD', at, `"${record.name}": each stock entry is an item name or { "item": …, "qty": … }.`); }
        const id = ref(line.item);
        if (!id) { ok = false; return add('UNKNOWN_REF', `${at}.item`, `"${record.name}" sells "${line.item}", which is not an item of this pack or a def ID.`); }
        if (line.qty !== undefined && !isInt(line.qty, 1)) { ok = false; return add('BAD_RECORD', `${at}.qty`, `"${record.name}": qty must be a whole number of 1 or more.`); }
        if (line.price !== undefined && !isInt(line.price)) { ok = false; return add('BAD_RECORD', `${at}.price`, `"${record.name}": price must be a whole number of 0 or more.`); }
        stock.push({ ...line, item: id });
    });
    return ok ? { ...base, stock } : null;
}

function checkRecipe(record, path, add, ref, craftIds) {
    const base = openRecord(record);
    let ok = true;
    const craft = checkRecipeCraft(record, path, add, craftIds);
    if (!craft) ok = false;
    const makes = ref(record.makes);
    if (!makes) { ok = false; add('UNKNOWN_REF', `${path}.makes`, `"${record.name}" makes "${record.makes ?? ''}", which is not an item of this pack or a def ID.`); }
    if (record.qty !== undefined && !isInt(record.qty, 1)) { ok = false; add('BAD_RECORD', `${path}.qty`, `"${record.name}": qty must be a whole number of 1 or more.`); }
    for (const field of ['fee', 'minutes']) {
        if (record[field] !== undefined && !isInt(record[field])) { ok = false; add('BAD_RECORD', `${path}.${field}`, `"${record.name}": ${field} must be a whole number of 0 or more.`); }
    }
    const materials = [];
    if (!Array.isArray(record.materials) || !record.materials.length) {
        ok = false;
        add('BAD_RECORD', `${path}.materials`, `"${record.name}": materials must be a list like [{ "item": "iron-ingot", "qty": 2 }].`);
    } else {
        record.materials.forEach((entry, index) => {
            const at = `${path}.materials[${index}]`;
            const id = isObject(entry) ? ref(entry.item) : null;
            if (!id) { ok = false; return add('UNKNOWN_REF', `${at}.item`, `"${record.name}" needs "${isObject(entry) ? entry.item : entry}", which is not an item of this pack or a def ID.`); }
            if (!isInt(entry.qty ?? 1, 1)) { ok = false; return add('BAD_RECORD', `${at}.qty`, `"${record.name}": qty must be a whole number of 1 or more.`); }
            materials.push({ item: id, qty: entry.qty ?? 1 });
        });
    }
    return ok ? { ...base, makes, qty: record.qty ?? 1, materials, ...craft } : null;
}

// A recipe's crafting fields (MODULES §F102), each optional and kept only when given:
// `craft` (a default craft or one of this pack's `crafts`), `dc` 5–40, `station` (a slug: forge,
// alchemy-table, campfire, inn, workbench or the pack's own), `stat` ('STR+DEX', overriding the
// craft's stats), `known` (true: every character knows it from the start) and `teaches` (who
// teaches it, as text). Returns the normalized fields, or null after saying what is wrong.
function checkRecipeCraft(record, path, add, craftIds) {
    const label = `"${record.name}"`;
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    const out = {};
    if (record.craft !== undefined) {
        if (typeof record.craft !== 'string' || !SLUG.test(record.craft)) say('craft', 'craft must be a craft id like "alchemy" (lowercase letters, digits and dashes).');
        else if (!craftIds.has(record.craft)) say('craft', `"${record.craft}" is not a craft: use ${DEFAULT_CRAFTS.map(entry => entry.craft).join(', ')}, or declare it in this pack's content.crafts.`, 'UNKNOWN_REF');
        else out.craft = record.craft;
    }
    if (record.dc !== undefined) {
        if (!Number.isInteger(record.dc) || record.dc < RECIPE_LIMITS.dcMin || record.dc > RECIPE_LIMITS.dcMax) say('dc', `dc must be a whole number from ${RECIPE_LIMITS.dcMin} to ${RECIPE_LIMITS.dcMax} (how hard the craft check is).`);
        else out.dc = record.dc;
    }
    if (record.station !== undefined) {
        if (typeof record.station !== 'string' || !SLUG.test(record.station)) say('station', 'station must be a station id like "forge", "alchemy-table", "campfire", "inn" or "workbench" (lowercase letters, digits and dashes).');
        else out.station = record.station;
    }
    if (record.stat !== undefined) {
        const stats = typeof record.stat === 'string' ? record.stat.split('+') : [];
        if (typeof record.stat !== 'string' || !STAT_SUM.test(record.stat)) say('stat', `stat must be 1 to ${RECIPE_LIMITS.stats} stat names joined by + (like "STR+DEX" or "INT").`);
        else if (new Set(stats).size !== stats.length) say('stat', `stat names "${record.stat}" with a stat twice.`);
        else out.stat = record.stat;
    }
    if (record.known !== undefined) {
        if (typeof record.known !== 'boolean') say('known', 'known must be true (every character knows it from the start) or false.');
        else out.known = record.known;
    }
    if (record.teaches !== undefined) {
        if (typeof record.teaches !== 'string' || !record.teaches.trim() || oneLine(record.teaches).length > RECIPE_LIMITS.teaches) say('teaches', `teaches must say who teaches it, 1 to ${RECIPE_LIMITS.teaches} characters (like "Hollis at the Gate Forge").`);
        else out.teaches = oneLine(record.teaches);
    }
    return ok ? out : null;
}

const statList = (value, max) => Array.isArray(value) && value.length >= 1 && value.length <= max
    && value.every(stat => typeof stat === 'string' && STAT_NAME.test(stat)) && new Set(value).size === value.length;

// The crafts a pack declares or changes (MODULES §F102): `{ id, title, stats, stations?, note? }`. The id
// is the craft as recipes write it ('alchemy'); one of the default crafts' ids replaces that craft.
function checkCrafts(list, packId, add) {
    if (Array.isArray(list) && list.length > CRAFTS_LIMITS.records) {
        add('BAD_CONTENT', 'content.crafts', `content.crafts holds at most ${CRAFTS_LIMITS.records} crafts.`);
        return [];
    }
    return records(list, 'crafts', { add, packId, slugField: 'id', named: false, check: (record, path) => {
        const label = typeof record.id === 'string' ? `Craft "${record.id}"` : path;
        let ok = true;
        const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
        for (const key of Object.keys(record)) if (!CRAFT_FIELDS.includes(key)) say(key, `"${key}" is not a craft field (expected ${CRAFT_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
        if (typeof record.title !== 'string' || !record.title.trim() || oneLine(record.title).length > CRAFTS_LIMITS.title) say('title', `title must be the craft's name, 1 to ${CRAFTS_LIMITS.title} characters (like "Alchemy").`);
        else if (TERM_SEPARATORS.test(record.title)) say('title', 'title may not hold | : # < > or a line break.');
        if (!statList(record.stats, CRAFTS_LIMITS.stats)) say('stats', `stats must list 1 to ${CRAFTS_LIMITS.stats} different stat names the check rolls with: ["INT", "DEX"].`);
        const stations = record.stations ?? [];
        if (!Array.isArray(stations) || stations.length > CRAFTS_LIMITS.stations || stations.some(station => typeof station !== 'string' || !SLUG.test(station)) || new Set(stations).size !== stations.length) {
            say('stations', `stations must list at most ${CRAFTS_LIMITS.stations} different station ids ("forge", "alchemy-table" …); leave it out or [] for anywhere.`);
        }
        const note = record.note ?? '';
        if (!isText(note, CRAFTS_LIMITS.note)) say('note', `note must be text of at most ${CRAFTS_LIMITS.note} characters.`);
        if (!ok) return null;
        return { title: oneLine(record.title), stats: [...record.stats], stations: [...stations], ...(note ? { note } : {}) };
    } });
}

// One ready-made set of NPC meters for NPC State Delta (MODULES §F81, §F90). Each meter is a whole-number
// range with a start; `bands` name stretches of it (a band reaches from its `at` to the next band's),
// `drift` pulls it toward a value by `perDay` each story day. A stage is reached when every one of its
// `needs` is: `at` 0 or more means the meter at or above it, a negative `at` at or below it (NPC State
// Delta's own rule). Code moves meters and stages; the story only proposes.
function checkMeterPreset(record, path, add) {
    const label = typeof record.id === 'string' ? `Meter preset "${record.id}"` : path;
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!METER_PRESET_FIELDS.includes(key)) say(key, `"${key}" is not a meter preset field (expected ${METER_PRESET_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const words = (field, value, max, what) => {
        if (typeof value !== 'string' || !value.trim() || oneLine(value).length > max) { say(field, `${what} must be text of 1 to ${max} characters.`); return false; }
        if (TERM_SEPARATORS.test(value)) { say(field, `${what} may not hold | : # < > or a line break (it is a label in the story's blocks).`); return false; }
        return true;
    };
    words('title', record.title, METER_LIMITS.title, 'title');
    const meters = [];
    const byId = new Map();
    if (!Array.isArray(record.meters) || !record.meters.length || record.meters.length > METER_LIMITS.meters) {
        say('meters', `meters must be a list of 1 to ${METER_LIMITS.meters} meters: [{ "id": "regard", "name": "Regard", "min": -100, "max": 100, "start": 0 }].`);
    } else record.meters.forEach((meter, index) => {
        const at = `meters[${index}]`;
        if (!isObject(meter)) return say(at, `${at} must be an object.`);
        const before = ok;
        ok = true;
        for (const key of Object.keys(meter)) if (!METER_FIELDS.includes(key)) say(`${at}.${key}`, `"${key}" is not a meter field (expected ${METER_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
        if (typeof meter.id !== 'string' || !SLUG.test(meter.id) || meter.id.length > METER_LIMITS.id) say(`${at}.id`, `${at}.id must be lowercase letters, digits and dashes, at most ${METER_LIMITS.id} (like "regard").`);
        else if (METER_RESERVED.includes(meter.id)) say(`${at}.id`, `"${meter.id}" is a word NPC State Delta keeps for itself; pick another meter id.`);
        else if (byId.has(meter.id)) say(`${at}.id`, `two meters share the id "${meter.id}".`, 'DUPLICATE');
        words(`${at}.name`, meter.name, METER_LIMITS.name, `${at}.name`);
        const whole = value => Number.isInteger(value) && value >= METER_LIMITS.min && value <= METER_LIMITS.max;
        const range = `whole numbers from ${METER_LIMITS.min} to ${METER_LIMITS.max}`;
        let fits = () => false;
        if (!whole(meter.min) || !whole(meter.max) || meter.min >= meter.max) say(`${at}.min`, `${at}: min and max must be ${range}, min below max.`);
        else {
            fits = value => Number.isInteger(value) && value >= meter.min && value <= meter.max;
            if (!fits(meter.start)) say(`${at}.start`, `${at}.start must be a whole number from ${meter.min} to ${meter.max}.`);
        }
        if (meter.describe !== undefined && (typeof meter.describe !== 'string' || oneLine(meter.describe).length > METER_LIMITS.describe)) say(`${at}.describe`, `${at}.describe must be text of at most ${METER_LIMITS.describe} characters.`);
        let bands = [];
        if (meter.bands !== undefined) {
            if (!Array.isArray(meter.bands) || !meter.bands.length || meter.bands.length > METER_LIMITS.bands) say(`${at}.bands`, `${at}.bands must be a list of 1 to ${METER_LIMITS.bands} { "at": …, "word": … }, lowest first.`);
            else meter.bands.forEach((band, n) => {
                const where = `${at}.bands[${n}]`;
                if (!isObject(band) || Object.keys(band).some(key => key !== 'at' && key !== 'word')) return say(where, `${where} must be { "at": …, "word": … }.`);
                if (!fits(band.at)) say(`${where}.at`, `${where}.at must be a whole number inside the meter's range.`);
                else if (n > 0 && isObject(meter.bands[n - 1]) && Number.isInteger(meter.bands[n - 1].at) && band.at <= meter.bands[n - 1].at) say(`${where}.at`, `${where}.at must be above the band before it (bands go lowest first).`);
                if (words(`${where}.word`, band.word, METER_LIMITS.word, `${where}.word`)) bands.push({ at: band.at, word: oneLine(band.word) });
            });
        }
        let drift = null;
        if (meter.drift !== undefined) {
            const value = meter.drift;
            if (!isObject(value) || Object.keys(value).some(key => key !== 'toward' && key !== 'perDay') || !fits(value.toward)
                || !Number.isInteger(value.perDay) || value.perDay < 1 || value.perDay > meter.max - meter.min) {
                say(`${at}.drift`, `${at}.drift must be { "toward": a value inside the meter's range, "perDay": a whole number of 1 or more }.`);
            } else drift = { toward: value.toward, perDay: value.perDay };
        }
        if (ok) {
            const out = { id: meter.id, name: oneLine(meter.name), min: meter.min, max: meter.max, start: meter.start };
            if (meter.describe !== undefined && meter.describe.trim()) out.describe = oneLine(meter.describe);
            if (meter.bands !== undefined) out.bands = bands;
            if (drift) out.drift = drift;
            meters.push(out);
            byId.set(meter.id, out);
        }
        ok = before && ok;
    });
    const stages = [];
    if (record.stages !== undefined) {
        const seen = new Set();
        if (!Array.isArray(record.stages) || record.stages.length > METER_LIMITS.stages) say('stages', `stages must be a list of at most ${METER_LIMITS.stages} { "id", "name", "needs": [{ "meter", "at" }] }.`);
        else record.stages.forEach((stage, index) => {
            const at = `stages[${index}]`;
            if (!isObject(stage)) return say(at, `${at} must be an object.`);
            for (const key of Object.keys(stage)) if (!METER_STAGE_FIELDS.includes(key)) say(`${at}.${key}`, `"${key}" is not a stage field (expected ${METER_STAGE_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
            if (typeof stage.id !== 'string' || !SLUG.test(stage.id)) say(`${at}.id`, `${at}.id must be lowercase letters, digits and dashes (like "trusted").`);
            else if (seen.has(stage.id)) say(`${at}.id`, `two stages share the id "${stage.id}".`, 'DUPLICATE');
            else seen.add(stage.id);
            const named = words(`${at}.name`, stage.name, METER_LIMITS.name, `${at}.name`);
            const needs = [];
            if (!Array.isArray(stage.needs) || !stage.needs.length || stage.needs.length > METER_LIMITS.needs) say(`${at}.needs`, `${at}.needs must be a list of 1 to ${METER_LIMITS.needs} { "meter": …, "at": … }.`);
            else stage.needs.forEach((need, n) => {
                const where = `${at}.needs[${n}]`;
                if (!isObject(need) || Object.keys(need).some(key => key !== 'meter' && key !== 'at')) return say(where, `${where} must be { "meter": …, "at": … }.`);
                const meter = byId.get(need.meter);
                if (!meter) return say(`${where}.meter`, `"${need.meter ?? ''}" is not a meter of this preset.`, 'UNKNOWN_REF');
                if (needs.some(other => other.meter === need.meter)) return say(`${where}.meter`, `${at} names the meter "${need.meter}" twice.`, 'DUPLICATE');
                if (!Number.isInteger(need.at) || need.at < meter.min || need.at > meter.max) return say(`${where}.at`, `${where}.at must be a whole number from ${meter.min} to ${meter.max} (0 or more: at or above it; below 0: at or below it).`);
                needs.push({ meter: need.meter, at: need.at });
            });
            if (stage.milestone !== undefined && (typeof stage.milestone !== 'string' || !stage.milestone.trim() || oneLine(stage.milestone).length > METER_LIMITS.milestone)) say(`${at}.milestone`, `${at}.milestone must be text of 1 to ${METER_LIMITS.milestone} characters (what the story is told when the stage is first reached).`);
            if (ok && named) stages.push({ id: stage.id, name: oneLine(stage.name), needs, ...(stage.milestone !== undefined ? { milestone: oneLine(stage.milestone) } : {}) });
        });
    }
    if (!ok) return null;
    return { title: oneLine(record.title), meters, ...(record.stages !== undefined ? { stages } : {}) };
}

// Commands the host makes for itself (registry.js CAPTURE_PREFIX, INIT_PREFIX; events/engine.js FIRE):
// a change line the story never wrote, a module's state reset, an event firing another. Not for packs.
const HOST_COMMAND = /^(?:capture\.|module\.)|^events\.fire$/;

function checkEvent(record, path, add) {
    const label = `Event "${record.id}"`;
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!EVENT_FIELDS.includes(key)) say(key, `"${key}" is not an event field (expected ${EVENT_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    if (typeof record.when !== 'string' || !record.when.trim() || record.when.length > EVENT_LIMITS.when) say('when', `when must be a condition of 1 to ${EVENT_LIMITS.when} characters.`);
    if (typeof record.cue !== 'string' || !record.cue.trim() || record.cue.trim().length > EVENT_LIMITS.cue) say('cue', `cue must be text of 1 to ${EVENT_LIMITS.cue} characters.`);
    if (record.once !== undefined && typeof record.once !== 'boolean') say('once', 'once must be true or false.');
    if (record.after !== undefined && (typeof record.after !== 'string' || !SLUG.test(record.after))) say('after', 'after must be the id of another event in this pack.');
    const then = record.then ?? [];
    if (!Array.isArray(then) || then.length > EVENT_LIMITS.then) say('then', `then must be a list of at most ${EVENT_LIMITS.then} { "command": …, "payload": { … } }.`);
    else then.forEach((step, index) => {
        if (!isObject(step) || typeof step.command !== 'string' || !COMMAND.test(step.command)) say(`then[${index}].command`, `then[${index}] needs a command name like "wallet.receive".`);
        else if (HOST_COMMAND.test(step.command)) say(`then[${index}].command`, `then[${index}] names "${step.command}", a command Story Block runs itself; an event runs only module commands (like "wallet.receive").`);
        else if (step.payload !== undefined && !isObject(step.payload)) say(`then[${index}].payload`, `then[${index}].payload must be an object.`);
        else if (Object.keys(step).some(key => key !== 'command' && key !== 'payload')) say(`then[${index}]`, `then[${index}] holds only command and payload.`);
    });
    if (!ok) return null;
    return {
        when: record.when.trim(),
        cue: record.cue.trim(),
        once: record.once ?? true,
        after: record.after ?? null,
        then: then.map(step => ({ command: step.command, payload: { ...(step.payload ?? {}) } })),
    };
}

// `after` names an event of the same pack; written as its full ID, and no loops.
function linkEvents(events, packId, add) {
    const ids = new Set(events.map(event => event.slug));
    for (const event of events) {
        if (event.after === null) continue;
        if (!ids.has(event.after) || event.after === event.slug) {
            add('UNKNOWN_REF', `content.events.${event.slug}.after`, `Event "${event.slug}" comes after "${event.after}", which is not another event of this pack.`);
            continue;
        }
        // Only a once event leaves the claim that `after` waits for.
        if (events.find(other => other.slug === event.after).once === false) {
            add('BAD_RECORD', `content.events.${event.slug}.after`, `Event "${event.slug}" comes after "${event.after}", which repeats (once: false) and so never counts as happened.`);
            continue;
        }
        event.after = fullId(packId, event.after);
    }
    const bySlug = new Map(events.map(event => [event.id, event]));
    for (const event of events) {
        const chain = new Set([event.id]);
        for (let next = bySlug.get(event.after); next; next = bySlug.get(next.after)) {
            if (chain.has(next.id)) {
                add('BAD_RECORD', `content.events.${event.slug}.after`, `Event "${event.slug}" is part of an "after" loop.`);
                break;
            }
            chain.add(next.id);
        }
    }
}

// A currency the pack suggests (MODULES §F1): one name for the chat's one currency (singular, with an
// optional plural and short form), used only when the reader has not named one; optionally its coins
// (MODULES §F108): `coins: [{ name, plural?, value }]`, each worth `value` of the smallest (whole, 1 to
// 1,000,000), at most 8, names once each.
function checkCurrency(currency, add) {
    const { short, plural, coins } = currency ?? {};
    const optional = (value, max) => value === undefined || (typeof value === 'string' && value.trim() && value.length <= max);
    if (!isObject(currency) || Object.keys(currency).some(key => !['name', 'plural', 'short', 'coins'].includes(key))
        || typeof currency.name !== 'string' || !currency.name.trim() || currency.name.length > 24
        || !optional(short, 8) || !optional(plural, 24)) {
        add('BAD_CURRENCY', 'currency', 'currency must be { "name": "mark" } (at most 24 characters), with an optional "plural" of at most 24 ("marks"), "short" of at most 8 ("m") and "coins".');
        return null;
    }
    let cleanCoins = null;
    if (coins !== undefined) {
        const good = Array.isArray(coins) && coins.length >= 1 && coins.length <= MAX_COINS && coins.every(coin => isObject(coin)
            && Object.keys(coin).every(key => ['name', 'plural', 'value'].includes(key))
            && typeof coin.name === 'string' && coin.name.trim() && coin.name.length <= 24 && !/[\d|:#<>/]/.test(coin.name)
            && optional(coin.plural, 24) && Number.isSafeInteger(coin.value) && coin.value >= 1 && coin.value <= MAX_COIN_VALUE);
        cleanCoins = good ? coinsOf(coins.map(coin => ({ name: oneLine(coin.name), value: coin.value, ...(coin.plural === undefined ? {} : { plural: oneLine(coin.plural) }) }))) : [];
        if (!good || cleanCoins.length !== coins.length) {
            add('BAD_CURRENCY', 'currency.coins', 'currency.coins must be 1 to 8 coins [{ "name": "penny", "plural": "pennies", "value": 1 }, { "name": "silver", "value": 10 }]: a name of at most 24 characters without digits, once each, and a whole value from 1 to 1,000,000 (what one is worth in the smallest).');
            cleanCoins = null;
        }
    }
    return { name: oneLine(currency.name), short: oneLine(short ?? ''), ...(plural === undefined ? {} : { plural: oneLine(plural) }), ...(cleanCoins ? { coins: cleanCoins } : {}) };
}

// A pack's money scale (MODULES §F104): `{ scale?, note? }`, `scale` a number from 0.001 to 1000
// (default 1) that multiplies the built-in money defaults; `note` says what the scale is, for the reader.
function checkEconomy(economy, add) {
    let ok = true;
    const say = (path, message, code = 'BAD_ECONOMY') => { ok = false; add(code, path, message); };
    if (!isObject(economy)) {
        say('economy', 'economy must be { "scale": 1, "note": "…" } (both optional).');
        return null;
    }
    for (const key of Object.keys(economy)) if (!ECONOMY_FIELDS.includes(key)) say(`economy.${key}`, `"${key}" is not an economy field (expected ${ECONOMY_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const scale = economy.scale === undefined ? 1 : economy.scale;
    if (!isNumber(scale) || scale < ECONOMY_LIMITS.min || scale > ECONOMY_LIMITS.max) say('economy.scale', `economy.scale must be a number from ${ECONOMY_LIMITS.min} to ${ECONOMY_LIMITS.max}: how many of this pack's coins the built-in defaults' one is worth (1 leaves them as they are, 0.01 for a world a hundred times poorer).`);
    const note = economy.note ?? '';
    if (!isText(note, ECONOMY_LIMITS.note)) say('economy.note', `economy.note must be text of at most ${ECONOMY_LIMITS.note} characters.`);
    return ok ? { scale, note: note.trim() } : null;
}

/*
 * A pack's weather (MODULES §F122): `{ seasons?, tables }`, plain data a module that sets the weather by
 * rule reads (Story Director, from its calendar and the scene's region). `seasons`: at most 12
 * `{ name, months: [month name] }` (a month in one season only; the names are the calendar's months);
 * `tables`: 1 to 120 `{ season?, region?, weather: [1 to 24 texts of at most 60 characters] }`, a table
 * without `season` or `region` for any. Texts are kept on one line. Problems are `BAD_WEATHER`.
 */
function checkWeather(weather, add) {
    let ok = true;
    const say = (path, message, code = 'BAD_WEATHER') => { ok = false; add(code, path, message); };
    const L = WEATHER_LIMITS;
    if (!isObject(weather)) {
        say('weather', 'weather must be { "seasons": [ … ], "tables": [{ "season", "region", "weather": [ … ] }] }.');
        return null;
    }
    for (const key of Object.keys(weather)) if (!WEATHER_FIELDS.includes(key)) say(`weather.${key}`, `"${key}" is not a weather field (expected ${WEATHER_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const word = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max ? oneLine(value, max) : '');
    const seasons = [];
    if (weather.seasons !== undefined) {
        const months = new Set();
        if (!Array.isArray(weather.seasons) || weather.seasons.length > L.seasons) say('weather.seasons', `seasons must be a list of at most ${L.seasons} { "name", "months" }.`);
        else weather.seasons.forEach((season, index) => {
            const at = `weather.seasons[${index}]`;
            if (!isObject(season) || Object.keys(season).some(key => !WEATHER_SEASON_FIELDS.includes(key))) return say(at, `${at} must be { "name", "months" }.`);
            const name = word(season.name, L.season);
            if (!name) return say(`${at}.name`, `name must be text of at most ${L.season} characters (a season, like "winter").`);
            const list = Array.isArray(season.months) ? season.months.map(month => word(month, CALENDAR_LIMITS.monthName)) : [];
            if (!list.length || list.length > L.months || list.some(month => !month)) return say(`${at}.months`, `months must be a list of 1 to ${L.months} month names.`);
            for (const month of list) {
                if (months.has(foldKey(month))) return say(`${at}.months`, `"${month}" is in two seasons.`);
                months.add(foldKey(month));
            }
            seasons.push({ name, months: list });
        });
    }
    const tables = [];
    if (!Array.isArray(weather.tables) || !weather.tables.length || weather.tables.length > L.tables) say('weather.tables', `tables must be a list of 1 to ${L.tables} { "season", "region", "weather": [ … ] }.`);
    else weather.tables.forEach((table, index) => {
        const at = `weather.tables[${index}]`;
        if (!isObject(table) || Object.keys(table).some(key => !WEATHER_TABLE_FIELDS.includes(key))) return say(at, `${at} must be { "season", "region", "weather": [ … ] }.`);
        if (table.season !== undefined && !isText(table.season, L.season)) say(`${at}.season`, `season must be text of at most ${L.season} characters.`);
        if (table.region !== undefined && !isText(table.region, L.region)) say(`${at}.region`, `region must be text of at most ${L.region} characters.`);
        const kinds = Array.isArray(table.weather) ? table.weather.map(text => word(text, L.text)) : [];
        if (!kinds.length || kinds.length > L.kinds || kinds.some(text => !text)) return say(`${at}.weather`, `weather must be a list of 1 to ${L.kinds} texts of at most ${L.text} characters ("cold drizzle, low fog").`);
        tables.push({ season: typeof table.season === 'string' ? oneLine(table.season, L.season) : '', region: typeof table.region === 'string' ? oneLine(table.region, L.region) : '', weather: kinds });
    });
    return ok ? { ...(seasons.length ? { seasons } : {}), tables } : null;
}

// A race or talent for the character creation wizard: { id?, name, note?, stats?, tags? }.
function checkChoice(record, path, label, add) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!CHOICE_FIELDS.includes(key)) say(key, `"${key}" is not a field here (expected ${CHOICE_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const note = record.note ?? '';
    if (typeof note !== 'string' || note.length > 500) say('note', 'note must be text of at most 500 characters.');
    const stats = record.stats ?? {};
    if (!isObject(stats) || Object.values(stats).some(n => !Number.isInteger(n))) say('stats', 'stats must map names to whole numbers: { "STR": 1 }.');
    const tags = record.tags ?? [];
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) say('tags', 'tags must be a list of short words.');
    if (!ok) return null;
    return { name: oneLine(record.name, LIMITS.name), note, stats: { ...stats }, tags: tags.map(tag => tag.trim()) };
}

function checkStart(start, add, ref) {
    if (!isObject(start)) {
        add('BAD_START', 'start', 'start must be an object: { "scene": { … }, "inventory": { … } }.');
        return null;
    }
    for (const key of Object.keys(start)) if (!START_FIELDS.includes(key)) add('UNKNOWN_FIELD', `start.${key}`, `"${key}" is not a start field (expected ${START_FIELDS.join(', ')}).`);
    const out = { scene: { place: null, present: [] }, inventory: { items: [], money: 0 } };
    const scene = start.scene ?? {};
    if (!isObject(scene)) add('BAD_START', 'start.scene', 'start.scene must be an object.');
    else {
        if (scene.place !== undefined) {
            const place = scene.place;
            const fields = ['name', 'kind', 'region'];
            if (!isObject(place) || typeof place.name !== 'string' || !place.name.trim()
                || Object.keys(place).some(key => !fields.includes(key))
                || fields.some(field => place[field] !== undefined && (typeof place[field] !== 'string' || place[field].length > LIMITS.name))) {
                add('BAD_START', 'start.scene.place', 'start.scene.place must be { "name": …, "kind": …, "region": … } with short text values.');
            } else out.scene.place = { name: oneLine(place.name), kind: oneLine(place.kind ?? ''), region: oneLine(place.region ?? '') };
        }
        if (scene.present !== undefined) {
            if (!Array.isArray(scene.present) || scene.present.some(name => typeof name !== 'string' || !name.trim() || name.length > LIMITS.name)) add('BAD_START', 'start.scene.present', 'start.scene.present must be a list of names.');
            else out.scene.present = scene.present.map(name => oneLine(name));
        }
        for (const key of Object.keys(scene)) if (key !== 'place' && key !== 'present') add('UNKNOWN_FIELD', `start.scene.${key}`, `"${key}" is not a start.scene field (expected place, present).`);
    }
    const inventory = start.inventory ?? {};
    if (!isObject(inventory)) add('BAD_START', 'start.inventory', 'start.inventory must be an object.');
    else {
        for (const key of Object.keys(inventory)) if (key !== 'items' && key !== 'money') add('UNKNOWN_FIELD', `start.inventory.${key}`, `"${key}" is not a start.inventory field (expected items, money).`);
        const items = inventory.items ?? [];
        if (!Array.isArray(items)) add('BAD_START', 'start.inventory.items', 'start.inventory.items must be a list.');
        else items.forEach((entry, index) => {
            const at = `start.inventory.items[${index}]`;
            const line = typeof entry === 'string' ? { item: entry } : entry;
            if (!isObject(line) || Object.keys(line).some(key => !['item', 'qty', 'note'].includes(key))) return add('BAD_START', at, `${at} is an item name or { "item": …, "qty": …, "note": … }.`);
            const id = ref(line.item);
            // A start item must be defined by this pack: the start state has no story to name it.
            if (!id || !id.startsWith('pack.')) return add('UNKNOWN_REF', `${at}.item`, `The start gives "${line.item}", which is not an item of this pack.`);
            if (!isInt(line.qty ?? 1, 1)) return add('BAD_START', `${at}.qty`, `${at}.qty must be a whole number of 1 or more.`);
            if (line.note !== undefined && (typeof line.note !== 'string' || line.note.length > 500)) return add('BAD_START', `${at}.note`, `${at}.note must be text of at most 500 characters.`);
            out.inventory.items.push({ item: id, qty: line.qty ?? 1, note: line.note ?? '' });
        });
        // Money is one whole number of the chat's one currency, like item values (MODULES §F1).
        const money = inventory.money ?? 0;
        if (!isInt(money)) add('BAD_START', 'start.inventory.money', 'start.inventory.money must be a whole number of 0 or more.');
        else out.inventory.money = money;
    }
    return out;
}

const isText = (value, max) => typeof value === 'string' && value.length <= max;
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// A skill template for RPG Battle (v1 skillFromTemplate): what it is, never its numbers, which
// RPG Battle's rules set at the level it is learned.
function checkSkill(record, path, label, add) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!SKILL_FIELDS.includes(key)) say(key, `"${key}" is not a skill field (expected ${SKILL_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const type = record.type ?? 'physical';
    if (!SKILL_TYPES.includes(type)) say('type', `type must be one of ${SKILL_TYPES.join(', ')}.`);
    const stat = record.stat ?? null;
    if (stat !== null && (typeof stat !== 'string' || !STAT_NAME.test(stat))) say('stat', 'stat must be a stat name like "DEX".');
    const target = record.target ?? 'one';
    if (!SKILL_TARGETS.includes(target)) say('target', `target must be one of ${SKILL_TARGETS.join(', ')}.`);
    const element = record.element ?? null;
    if (element !== null && (typeof element !== 'string' || !/^[a-z]{1,24}$/.test(element))) say('element', 'element must be one short lowercase word, like "fire", or left out.');
    const note = record.note ?? '';
    if (!isText(note, 500)) say('note', 'note must be text of at most 500 characters.');
    const tags = record.tags ?? [];
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) say('tags', 'tags must be a list of short words.');
    if (!ok) return null;
    return { name: oneLine(record.name, LIMITS.name), type, stat, target, element, note, tags: tags.map(tag => tag.trim()) };
}

// How a preset names a race, talent or skill of this pack: its id or slug, its name, or its
// full id (`pack.<id>/<slug>`). Returns the full id or null.
function choiceRefs(list) {
    const byKey = new Map();
    for (const record of list) {
        for (const key of [record.id, record.slug, foldKey(record.name)]) if (!byKey.has(key)) byKey.set(key, record.id);
    }
    return value => {
        if (typeof value !== 'string' || !value.trim()) return null;
        return byKey.get(value) ?? byKey.get(foldKey(value)) ?? null;
    };
}

// A ready-made character for the creation wizard: a race, talents and the points spent on each
// stat (on top of the race and talents), plus skills to offer. The name and background come
// from the persona; creation checks the point budget, this only checks the form.
function checkPreset(record, path, label, add, choose) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!PRESET_FIELDS.includes(key)) say(key, `"${key}" is not a preset field (expected ${PRESET_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const note = record.note ?? '';
    if (!isText(note, 500)) say('note', 'note must be text of at most 500 characters.');
    let race = null;
    if (record.race !== undefined && record.race !== null) {
        race = choose.race(record.race);
        if (!race) say('race', `"${record.race}" is not a race of this pack.`, 'UNKNOWN_REF');
    }
    const refs = (field, ref, word) => {
        const list = record[field] ?? [];
        if (!Array.isArray(list)) { say(field, `${field} must be a list of ${word} ids or names of this pack.`); return []; }
        const out = [];
        list.forEach((entry, index) => {
            const id = ref(entry);
            if (!id) say(`${field}[${index}]`, `"${entry}" is not a ${word} of this pack.`, 'UNKNOWN_REF');
            else if (out.includes(id)) say(`${field}[${index}]`, `"${entry}" is listed twice.`, 'DUPLICATE');
            else out.push(id);
        });
        return out;
    };
    const talents = refs('talents', choose.talent, 'talent');
    const skills = refs('skills', choose.skill, 'skill');
    const points = record.points ?? {};
    if (!isObject(points) || Object.entries(points).some(([stat, n]) => !STAT_NAME.test(stat) || !isInt(n))) say('points', 'points must map stat names to whole numbers of 0 or more: { "DEX": 3 }.');
    if (!ok) return null;
    return { name: oneLine(record.name, LIMITS.name), note, race, talents, points: { ...points }, skills };
}

// A place on the map: a name, coordinates in map units (x east, y north) and what it is.
function checkPlace(record, path, label, add) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!PLACE_FIELDS.includes(key)) say(key, `"${key}" is not a place field (expected ${PLACE_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    for (const axis of ['x', 'y']) if (!isNumber(record[axis]) || Math.abs(record[axis]) > 1e6) say(axis, `${axis} must be a number (map units).`);
    for (const field of ['region', 'kind', 'layer']) if (record[field] !== undefined && !isText(record[field], LIMITS.name)) say(field, `${field} must be text of at most ${LIMITS.name} characters.`);
    const aliases = record.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > LIMITS.name)) say('aliases', 'aliases must be a list of other names for the place.');
    const note = record.note ?? '';
    if (!isText(note, 500)) say('note', 'note must be text of at most 500 characters.');
    for (const flag of ['hidden', 'secret']) if (record[flag] !== undefined && typeof record[flag] !== 'boolean') say(flag, `${flag} must be true or false.`);
    // Its market (PACKS.md "Markets"): a settlement type and environment tags, each a lowercase word.
    if (record.market !== undefined && !(typeof record.market === 'string' && MARKET_WORD.test(record.market))) say('market', 'market must be a settlement type, a lowercase word like "village" or "city".');
    const placeTags = record.tags ?? [];
    if (!Array.isArray(placeTags) || placeTags.length > MARKET_LIMITS.tags || placeTags.some(tag => typeof tag !== 'string' || !MARKET_WORD.test(tag))) say('tags', `tags must be a list of at most ${MARKET_LIMITS.tags} lowercase words like "river" or "port".`);
    if (!ok) return null;
    return {
        name: oneLine(record.name, LIMITS.name), aliases: [...new Set(aliases.map(alias => oneLine(alias, LIMITS.name)))],
        region: oneLine(record.region ?? '', LIMITS.name), kind: oneLine(record.kind ?? '', LIMITS.name), layer: oneLine(record.layer ?? '', LIMITS.name),
        x: record.x, y: record.y, note,
        // `secret` is another word for `hidden`; the map reads either.
        ...(record.hidden === true || record.secret === true ? { hidden: true } : {}),
        ...(record.market !== undefined ? { market: record.market } : {}),
        ...(placeTags.length ? { tags: [...new Set(placeTags)] } : {}),
    };
}

// What is wrong with a template's shape for a pack (B-b5b-robust-r2-2, r2-3), or ''.
function shapeProblem(template) {
    const shape = templateShape(template);
    if (shape.loops > MAX_LOOP_DEPTH) return `nests loops (data-each) ${shape.loops} deep; at most ${MAX_LOOP_DEPTH} are allowed`;
    if (shape.deepJson) return `has data-props or data-payload nested more than ${MAX_JSON_DEPTH} deep`;
    return '';
}

// A route names two places of this pack by name, alias or slug; it is stored with their names.
function placeRefs(places) {
    const byKey = new Map();
    for (const place of places) for (const key of [place.slug, ...[place.name, ...place.aliases].map(foldKey)]) if (!byKey.has(key)) byKey.set(key, place.name);
    return value => (typeof value === 'string' && value.trim() ? byKey.get(value) ?? byKey.get(foldKey(value)) ?? null : null);
}

const routeSlug = record => slugify(`${record.from ?? ''} ${record.to ?? ''} ${record.kind ?? ''}`);

function checkRoute(record, path, add, place) {
    const label = typeof record.from === 'string' && typeof record.to === 'string' ? `Route "${record.from}" to "${record.to}"` : path;
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!ROUTE_FIELDS.includes(key)) say(key, `"${key}" is not a route field (expected ${ROUTE_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const from = place(record.from);
    const to = place(record.to);
    if (!from) say('from', `"${record.from ?? ''}" is not a place of this pack.`, 'UNKNOWN_REF');
    if (!to) say('to', `"${record.to ?? ''}" is not a place of this pack.`, 'UNKNOWN_REF');
    if (from && to && from === to) say('to', 'a route joins two different places.');
    if (typeof record.kind !== 'string' || !record.kind.trim() || record.kind.length > 40) say('kind', 'kind must say what the route is, like "road" or "river" (at most 40 characters).');
    for (const field of ['km', 'hours']) if (record[field] !== undefined && (!isNumber(record[field]) || record[field] <= 0 || record[field] > 1e6)) say(field, `${field} must be a number above 0, or left out.`);
    if (record.corridor !== undefined && !isText(record.corridor, LIMITS.name)) say('corridor', `corridor must be text of at most ${LIMITS.name} characters.`);
    const note = record.note ?? '';
    if (!isText(note, 500)) say('note', 'note must be text of at most 500 characters.');
    if (!ok) return null;
    return { from, to, kind: oneLine(record.kind, 40), km: record.km ?? null, hours: record.hours ?? null, corridor: oneLine(record.corridor ?? '', LIMITS.name), note };
}

// A record of display terms gets the slug from its `id`, else its name, else `terms`, `terms-2` … in
// file order (a pack usually has one).
function termsSlug() {
    let count = 0;
    return record => {
        const named = typeof record.name === 'string' ? slugify(record.name) : '';
        if (named) return named;
        count += 1;
        return count === 1 ? 'terms' : `terms-${count}`;
    };
}

// The words a world uses for levels and XP (MODULES §F25), as RPG Battle's terms read them:
// `{ id?, name?, levelName?, xpName?, tiers?: true | { size?, numerals?, enabled? } }`. The reader's
// own terms win over these. A term is a label in RPG Battle's blocks, so it may not hold `| : # < >`
// or a line break; checkPlain has already refused any markup or script link in it.
function checkTerms(record, path, label, add) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!TERMS_FIELDS.includes(key)) say(key, `"${key}" is not a terms field (expected ${TERMS_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    if (record.name !== undefined && (typeof record.name !== 'string' || !record.name.trim() || record.name.length > LIMITS.name)) say('name', `name must be text of 1 to ${LIMITS.name} characters.`);
    const out = {};
    if (typeof record.name === 'string') out.name = oneLine(record.name, LIMITS.name);
    for (const [field, word, example] of [['levelName', 'level', 'Soul Class'], ['xpName', 'XP', 'Soul Growth']]) {
        const value = record[field];
        if (value === undefined) continue;
        if (typeof value !== 'string' || !value.trim() || oneLine(value).length > TERMS_LIMITS.term) say(field, `${field} must be the ${word} word, 1 to ${TERMS_LIMITS.term} characters (like "${example}").`);
        else if (TERM_SEPARATORS.test(value)) say(field, `${field} may not hold | : # < > or a line break (it is a label in the story's blocks).`);
        else out[field] = oneLine(value);
    }
    const tiers = record.tiers;
    if (tiers !== undefined) {
        if (tiers === true) out.tiers = true;
        else if (!isObject(tiers)) say('tiers', 'tiers must be true or { "size": 10, "numerals": "roman" } (levels grouped into titled tiers).');
        else {
            for (const key of Object.keys(tiers)) if (!TERMS_TIER_FIELDS.includes(key)) say(`tiers.${key}`, `"${key}" is not a tiers field (expected ${TERMS_TIER_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
            if (tiers.size !== undefined && (!isInt(tiers.size, 1) || tiers.size > TERMS_LIMITS.tierSize)) say('tiers.size', `tiers.size must be a whole number of levels from 1 to ${TERMS_LIMITS.tierSize}.`);
            if (tiers.numerals !== undefined && !TERMS_NUMERALS.includes(tiers.numerals)) say('tiers.numerals', `tiers.numerals must be ${TERMS_NUMERALS.map(word => `"${word}"`).join(' or ')}.`);
            if (tiers.enabled !== undefined && tiers.enabled !== false) say('tiers.enabled', 'tiers.enabled can only be false (to switch tiers off); leave it out otherwise.');
            out.tiers = { ...tiers };
        }
    }
    if (ok && out.levelName === undefined && out.xpName === undefined && out.tiers === undefined) {
        ok = false;
        add('BAD_RECORD', path, `${label}: a terms record suggests at least one of levelName, xpName or tiers.`);
    }
    return ok ? out : null;
}

// A ladder of ranks, lowest first (Story Director's quest letters, RPG Battle's foe strength). The id is
// the rank as the story writes it ('F', 'SS'), kept as given and unique ignoring case, not a slug;
// `levels` and `reward` are whole-number ranges, the reward in units of the chat's one currency.
// A rank never starts below the one before it, so a ladder written highest first is caught.
function checkRanks(list, packId, add) {
    if (!Array.isArray(list)) {
        add('BAD_CONTENT', 'content.ranks', 'content.ranks must be a list of ranks, lowest first: [{ "id": "F" }, { "id": "E" }].');
        return [];
    }
    if (list.length > RANKS_LIMITS.records) {
        add('BAD_CONTENT', 'content.ranks', `content.ranks holds at most ${RANKS_LIMITS.records} ranks.`);
        return [];
    }
    const out = [];
    const seen = new Set();
    let ok = true;
    // The last rank (id and range) that gave levels, and the last that gave a reward.
    const last = { levels: null, reward: null };
    list.forEach((record, index) => {
        const path = `content.ranks[${index}]`;
        if (!isObject(record)) { ok = false; return add('BAD_RECORD', path, `${path} must be an object like { "id": "F", "title": "Registered" }.`); }
        const label = typeof record.id === 'string' ? `Rank "${record.id}"` : path;
        let good = true;
        const say = (field, message, code = 'BAD_RECORD') => { good = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
        for (const key of Object.keys(record)) if (!RANK_FIELDS.includes(key)) say(key, `"${key}" is not a rank field (expected ${RANK_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
        if (typeof record.id !== 'string' || !RANK_ID.test(record.id)) say('id', 'id must be 1 to 8 letters, digits, + or -, the rank as the story writes it (like "F" or "SS").');
        else if (seen.has(foldKey(record.id))) say('id', `"${record.id}" repeats an earlier rank's id (ids are unique, ignoring case).`, 'DUPLICATE');
        else seen.add(foldKey(record.id));
        const title = record.title;
        if (title !== undefined) {
            if (typeof title !== 'string' || !title.trim() || oneLine(title).length > RANKS_LIMITS.title) say('title', `title must be text of 1 to ${RANKS_LIMITS.title} characters (like "Journeyman").`);
            else if (TERM_SEPARATORS.test(title)) say('title', 'title may not hold | : # < > or a line break.');
        }
        const range = (field, min, max, words) => {
            const value = record[field];
            if (value === undefined) return null;
            if (!Array.isArray(value) || value.length !== 2 || !value.every(n => isInt(n, min) && n <= max) || value[0] > value[1]) {
                say(field, `${field} must be [lowest, highest]: two ${words}, the first not above the second.`);
                return null;
            }
            return [value[0], value[1]];
        };
        const levels = range('levels', 1, RANKS_LIMITS.level, `whole levels from 1 to ${RANKS_LIMITS.level}`);
        const reward = range('reward', 0, Number.MAX_SAFE_INTEGER, 'whole amounts of 0 or more of the chat\'s currency');
        if (!good) { ok = false; return; }
        const rank = { id: record.id, ...(title !== undefined ? { title: oneLine(title) } : {}), ...(levels ? { levels } : {}), ...(reward ? { reward } : {}), pack: packId };
        for (const field of ['levels', 'reward']) {
            if (!rank[field]) continue;
            const before = last[field];
            if (before && rank[field][0] < before.range[0]) {
                ok = false;
                add('BAD_RECORD', `${path}.${field}`, `${label}: ranks go from lowest to highest, but its ${field} start below rank "${before.id}"'s.`);
            }
            last[field] = { id: rank.id, range: rank[field] };
        }
        out.push(rank);
    });
    return ok ? out : [];
}

// Markets (PACKS.md "Markets"): settlement types and environment tags with their price factors, as
// RPG Battle's trade reads them over its built-in ones. Each record is a type (`type`, with `buy`, `sell`
// and `stock`) or a tag (`tag`, with `prices` per item category); one of each name per pack.
function checkMarkets(list, packId, add) {
    if (!Array.isArray(list)) {
        add('BAD_CONTENT', 'content.markets', 'content.markets must be a list like [{ "type": "town", "buy": 1 }, { "tag": "coastal", "prices": { "fish": 0.8 } }].');
        return [];
    }
    if (list.length > MARKET_LIMITS.records) {
        add('BAD_CONTENT', 'content.markets', `content.markets holds at most ${MARKET_LIMITS.records} records.`);
        return [];
    }
    const { factorMin: lo, factorMax: hi } = MARKET_LIMITS;
    const isFactor = value => isNumber(value) && value >= lo && value <= hi;
    const out = [];
    const seen = new Set();
    let ok = true;
    list.forEach((record, index) => {
        const path = `content.markets[${index}]`;
        if (!isObject(record)) { ok = false; return add('BAD_RECORD', path, `${path} must be an object like { "type": "town", "buy": 1.1 }.`); }
        const name = record.type ?? record.tag;
        const label = typeof name === 'string' ? `Market "${name}"` : path;
        let good = true;
        const say = (field, message, code = 'BAD_RECORD') => { good = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
        for (const key of Object.keys(record)) if (!MARKET_FIELDS.includes(key)) say(key, `"${key}" is not a market field (expected ${MARKET_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
        const isType = record.type !== undefined;
        if (isType === (record.tag !== undefined)) say(isType ? 'tag' : 'type', 'a market record is either a settlement type ("type") or an environment tag ("tag").');
        else if (typeof name !== 'string' || !MARKET_WORD.test(name)) say(isType ? 'type' : 'tag', 'it must be a lowercase word like "village" or "coastal".');
        else if (seen.has(`${isType ? 'type' : 'tag'}:${name}`)) say(isType ? 'type' : 'tag', `"${name}" is in this list twice.`, 'DUPLICATE');
        else seen.add(`${isType ? 'type' : 'tag'}:${name}`);
        const fields = isType ? ['buy', 'sell', 'stock'] : ['prices'];
        for (const field of ['buy', 'sell', 'stock', 'prices']) if (record[field] !== undefined && !fields.includes(field)) say(field, `${field} belongs to ${isType ? 'an environment tag' : 'a settlement type'}.`);
        for (const field of ['buy', 'sell']) if (isType && record[field] !== undefined && !isFactor(record[field])) say(field, `${field} must be a factor from ${lo} to ${hi} (1 = as usual).`);
        const stock = record.stock;
        if (isType && stock !== undefined && !(Array.isArray(stock) && stock.length === 2 && stock.every(n => isInt(n, 1) && n <= MARKET_LIMITS.stock) && stock[0] <= stock[1])) say('stock', `stock must be [least, most] things a trader has, whole numbers from 1 to ${MARKET_LIMITS.stock}.`);
        const prices = record.prices;
        if (!isType && prices !== undefined) {
            if (!isObject(prices) || Object.keys(prices).length > MARKET_LIMITS.categories || Object.entries(prices).some(([key, value]) => !MARKET_WORD.test(key) || !isFactor(value))) say('prices', `prices must map item categories (like "fish" or "all") to factors from ${lo} to ${hi}, at most ${MARKET_LIMITS.categories}.`);
        }
        if (record.note !== undefined && !isText(record.note, MARKET_LIMITS.note)) say('note', `note must be text of at most ${MARKET_LIMITS.note} characters.`);
        if (!good) { ok = false; return; }
        out.push(isType
            ? { type: name, ...(record.buy !== undefined ? { buy: record.buy } : {}), ...(record.sell !== undefined ? { sell: record.sell } : {}), ...(stock ? { stock: [...stock] } : {}), ...(record.note ? { note: oneLine(record.note, MARKET_LIMITS.note) } : {}), pack: packId }
            : { tag: name, prices: { ...(prices ?? {}) }, ...(record.note ? { note: oneLine(record.note, MARKET_LIMITS.note) } : {}), pack: packId });
    });
    return ok ? out : [];
}

// The story clock's calendar: an era word, the months in order with their days, and the moment
// a new story starts. `start.month` is a month name or its number (1 = the first month); it is
// kept as the name.
function checkCalendar(calendar, add) {
    const problems = [];
    const say = (path, message) => problems.push([path, message]);
    if (!isObject(calendar)) say('calendar', 'calendar must be { "era": …, "months": [{ "name": …, "days": … }], "start": { … } }.');
    else {
        for (const key of Object.keys(calendar)) if (!CALENDAR_FIELDS.includes(key)) say(`calendar.${key}`, `"${key}" is not a calendar field (expected ${CALENDAR_FIELDS.join(', ')}).`);
        if (calendar.era !== undefined && !isText(calendar.era, CALENDAR_LIMITS.era)) say('calendar.era', `era must be text of at most ${CALENDAR_LIMITS.era} characters, like "CY".`);
        const months = calendar.months;
        const seen = new Set();
        if (!Array.isArray(months) || !months.length || months.length > CALENDAR_LIMITS.months) say('calendar.months', `months must be a list of 1 to ${CALENDAR_LIMITS.months} { "name": …, "days": … }.`);
        else months.forEach((month, index) => {
            const at = `calendar.months[${index}]`;
            if (!isObject(month) || Object.keys(month).some(key => key !== 'name' && key !== 'days')
                || typeof month.name !== 'string' || !month.name.trim() || month.name.length > CALENDAR_LIMITS.monthName
                || !isInt(month.days, 1) || month.days > CALENDAR_LIMITS.days) return say(at, `${at} must be { "name": …, "days": 1 to ${CALENDAR_LIMITS.days} } with a name of at most ${CALENDAR_LIMITS.monthName} characters.`);
            if (seen.has(foldKey(month.name))) return say(at, `two months are called "${month.name}".`);
            seen.add(foldKey(month.name));
        });
        // The months are usable: holidays and the start can be read against them.
        const monthsOk = !problems.length;
        // Holidays: named days that come back every year, `{ name, month, day }` (month by name or number).
        if (calendar.holidays !== undefined && monthsOk) {
            const holidays = calendar.holidays;
            if (!Array.isArray(holidays) || holidays.length > CALENDAR_LIMITS.holidays) say('calendar.holidays', `holidays must be a list of at most ${CALENDAR_LIMITS.holidays} { "name", "month", "day" }.`);
            else holidays.forEach((holiday, index) => {
                const at = `calendar.holidays[${index}]`;
                if (!isObject(holiday) || Object.keys(holiday).some(key => !CALENDAR_HOLIDAY_FIELDS.includes(key))) return say(at, `${at} must be { "name", "month", "day" }.`);
                if (!holidayName(holiday.name)) say(`${at}.name`, 'name must be text (a holiday\'s name).');
                const month = monthIndexOf(months, holiday.month);
                if (month < 0) say(`${at}.month`, 'month must be one of the months, by name or by number (1 is the first).');
                else if (!isInt(holiday.day, 1) || holiday.day > months[month].days) say(`${at}.day`, `day must be a whole number from 1 to ${months[month].days}.`);
            });
        }
        if (calendar.start !== undefined && monthsOk) {
            const start = calendar.start;
            const at = 'calendar.start';
            if (!isObject(start) || Object.keys(start).some(key => !CALENDAR_START_FIELDS.includes(key))) say(at, `${at} must be { "year", "month", "day", "hour", "minute" }.`);
            else {
                const index = typeof start.month === 'string' ? months.findIndex(month => foldKey(month.name) === foldKey(start.month))
                    : isInt(start.month, 1) ? start.month - 1 : -1;
                if (!Number.isSafeInteger(start.year)) say(`${at}.year`, 'year must be a whole number.');
                if (index < 0 || index >= months.length) say(`${at}.month`, 'month must be one of the months, by name or by number (1 is the first).');
                else if (!isInt(start.day, 1) || start.day > months[index].days) say(`${at}.day`, `day must be a whole number from 1 to ${months[index].days}.`);
                if (start.hour !== undefined && (!isInt(start.hour) || start.hour > 23)) say(`${at}.hour`, 'hour must be a whole number from 0 to 23.');
                if (start.minute !== undefined && (!isInt(start.minute) || start.minute > 59)) say(`${at}.minute`, 'minute must be a whole number from 0 to 59.');
            }
        }
    }
    if (problems.length) {
        for (const [path, message] of problems) add('BAD_CALENDAR', path, message);
        return null;
    }
    const months = calendar.months.map(month => ({ name: oneLine(month.name, CALENDAR_LIMITS.monthName), days: month.days }));
    const start = calendar.start;
    const index = start === undefined ? -1 : typeof start.month === 'string' ? months.findIndex(month => foldKey(month.name) === foldKey(start.month)) : start.month - 1;
    const holidays = (calendar.holidays ?? []).map(holiday => ({ name: holidayName(holiday.name), month: months[monthIndexOf(months, holiday.month)].name, day: holiday.day }));
    return {
        era: oneLine(calendar.era ?? '', CALENDAR_LIMITS.era),
        months,
        start: start === undefined ? null : { year: start.year, month: months[index].name, day: start.day, hour: start.hour ?? 0, minute: start.minute ?? 0 },
        // Only when the pack names any, so a calendar without them reads as before.
        ...(holidays.length ? { holidays } : {}),
    };
}

// A month given by name (any case) or number (1 = the first): its index in `months`, or -1.
function monthIndexOf(months, month) {
    if (typeof month === 'string') return months.findIndex(entry => foldKey(entry.name) === foldKey(month));
    return isInt(month, 1) && month <= months.length ? month - 1 : -1;
}

// A holiday's name as kept: control and invisible marks dropped, one line, at most CALENDAR_LIMITS.holidayName
// characters; '' when that leaves nothing.
function holidayName(name) {
    return typeof name === 'string' ? oneLine(name.replace(/[\p{Cc}\p{Cf}]+/gu, ' '), CALENDAR_LIMITS.holidayName).trim() : '';
}

// Themes are CSS custom properties (SPEC §13.3): `{ "--ss-accent": "#7c5cff" }`.
const TOKEN = /^--[a-z][a-z0-9-]{0,47}$/;
const CSS_VALUE_ESCAPE = /url\s*\(|expression\s*\(|@import|[<>{};\\]/i;

function checkTheme(theme, add, path) {
    if (!isObject(theme)) {
        add('BAD_THEME', path, `${path} must map CSS custom properties to values: { "--ss-accent": "#7c5cff" }.`);
        return {};
    }
    const out = {};
    for (const [name, value] of Object.entries(theme)) {
        if (!TOKEN.test(name)) { add('BAD_THEME', `${path}.${name}`, `"${name}" is not a CSS custom property name (two dashes, then letters, digits and dashes, like "--ss-accent").`); continue; }
        if (typeof value === 'number') { out[name] = value; continue; }
        if (typeof value !== 'string' || value.length > 200 || CSS_VALUE_ESCAPE.test(value)) { add('BAD_THEME', `${path}.${name}`, `${path} "${name}" must be a plain CSS value (no url(), no braces, semicolons or backslashes).`); continue; }
        const loads = cssUrlProblem(value);
        if (loads) { add('BAD_THEME', `${path}.${name}`, `${path} "${name}" ${loads}.`); continue; }
        out[name] = value.trim();
    }
    return out;
}

// A screen's stylesheet (SPEC §13.3): Story Block scopes it; here it may not load or run
// anything. url() only to https or image data, no @import, no expression() or bindings,
// no markup and no backslash escapes (which could spell any of these).
const CSS_URL = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const CSS_SAFE_URL = /^(?:https:\/\/|data:image\/(?:png|jpeg|gif|webp)[;,])/i;
const CSS_UNSAFE = /@import|expression\s*\(|behavior\s*:|-moz-binding|[<\\]/i;
// Functions whose arguments the browser loads: their strings must be safe URLs, and they may not take
// a value from var(), attr() or env() (a custom property could hold any URL as a plain string).
const CSS_LOADERS = /(?:^|[^\w-])((?:-webkit-|-moz-)?(?:image-set|image|cross-fade|src|url|element))\s*\(/gi;
const CSS_STRING = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
// A string that names a URL: a scheme with `//`, a protocol-relative `//`, or a scheme that loads or runs.
const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:javascript|vbscript|livescript|data|blob|file|filesystem):)/i;

/** The arguments of the call whose `(` is at `open`, to its matching `)` (strings respected). */
function callArgs(text, open) {
    let depth = 0;
    let quote = null;
    for (let i = open; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === '\'') quote = char;
        else if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) return text.slice(open + 1, i);
    }
    return text.slice(open + 1);
}

/** Why a CSS text loads something it may not ('' when fine): image-set() and the like, URL strings. */
function cssUrlProblem(css) {
    for (const match of css.matchAll(CSS_LOADERS)) {
        const name = match[1].toLowerCase();
        const args = callArgs(css, match.index + match[0].length - 1);
        if (/\b(?:var|attr|env)\s*\(/i.test(args)) return `may not give ${name}() a value from var(), attr() or env()`;
        for (const string of args.matchAll(CSS_STRING)) {
            const url = (string[1] ?? string[2]).trim();
            if (name !== 'element' && !CSS_SAFE_URL.test(url)) return `may load only https or image data URLs (not "${url.slice(0, 40)}" in ${name}())`;
        }
    }
    for (const string of css.matchAll(CSS_STRING)) {
        const url = (string[1] ?? string[2]).replace(/[\u0000-\u0020\u007f]+/g, '');
        if (URLISH.test(url) && !CSS_SAFE_URL.test(url)) return `may hold only https or image data URLs (not "${url.slice(0, 40)}")`;
    }
    return '';
}

export function unsafeCss(css) {
    // A rule's own braces are one level; each @media/@supports around it one more.
    if (cssDepth(css) > MAX_AT_DEPTH + 1) return `may nest @-rules at most ${MAX_AT_DEPTH} deep`;
    if (CSS_UNSAFE.test(css)) return 'may not use @import, expression(), behavior, -moz-binding, < or backslashes';
    // A selector that reaches past the screen's root (the page beside it, its siblings, a :has() on them) is refused whole.
    const reach = sheetEscape(css);
    if (reach) return `may style only inside its own screen (a selector ${reach})`;
    for (const [, , target] of css.matchAll(CSS_URL)) if (!CSS_SAFE_URL.test(target.trim())) return `may load only https or image data URLs (not "${target.trim().slice(0, 40)}")`;
    return cssUrlProblem(css);
}

function checkScreens(list, packId, add) {
    if (!Array.isArray(list)) {
        add('BAD_SCREENS', 'screens', 'screens must be a list of screen definitions.');
        return [];
    }
    const out = [];
    const seen = new Set();
    list.forEach((screen, index) => {
        const path = `screens[${index}]`;
        if (!isObject(screen)) return add('BAD_SCREENS', path, `${path} must be an object.`);
        const label = typeof screen.id === 'string' ? `Screen "${screen.id}"` : path;
        let ok = true;
        const say = (field, message, code = 'BAD_SCREENS') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
        for (const key of Object.keys(screen)) if (!SCREEN_FIELDS.includes(key)) say(key, `"${key}" is not a screen field (expected ${SCREEN_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
        if (typeof screen.id !== 'string' || !SCREEN_ID.test(screen.id) || screen.id.length > 100) say('id', 'id must be a screen id like "rpg-battle/party" (to restyle that screen) or "riverside-board".');
        else if (seen.has(screen.id)) say('id', 'two screens share this id.', 'DUPLICATE');
        else seen.add(screen.id);
        for (const field of ['title', 'icon']) if (screen[field] !== undefined && (typeof screen[field] !== 'string' || screen[field].length > LIMITS.name)) say(field, `${field} must be text of at most ${LIMITS.name} characters.`);
        if (screen.mounts !== undefined && (!Array.isArray(screen.mounts) || screen.mounts.some(mount => !MOUNTS.includes(mount)))) say('mounts', `mounts must be a list of ${MOUNTS.join(', ')}.`);
        if (screen.template === undefined && screen.layout === undefined) say('template', 'a screen needs a template or a layout.');
        if (screen.template !== undefined && typeof screen.template !== 'string') say('template', 'template must be text (an HTML template).');
        else if (typeof screen.template === 'string' && tooDeep(screen.template)) say('template', `the template nests elements more than ${MAX_TEMPLATE_DEPTH} deep.`);
        else if (typeof screen.template === 'string') {
            const why = shapeProblem(screen.template);
            if (why) say('template', `the template ${why}.`);
        }
        if (screen.layout !== undefined && !isObject(screen.layout)) say('layout', 'layout must be an object: { "root": … }.');
        if (screen.css !== undefined) {
            const why = typeof screen.css === 'string' ? unsafeCss(screen.css) : 'must be text';
            if (why) say('css', `css ${why}.`);
        }
        if (screen.data !== undefined && !isObject(screen.data)) say('data', 'data must map names to queries: { "pc": { "query": "party.pc" } }.');
        if (screen.steps !== undefined && (!Array.isArray(screen.steps) || screen.steps.some(step => !isObject(step) || (step.template !== undefined && typeof step.template !== 'string')))) say('steps', 'steps must be a list of { "id", "title", "template" }.');
        else if (Array.isArray(screen.steps) && screen.steps.some(step => typeof step.template === 'string' && tooDeep(step.template))) say('steps', `a step's template nests elements more than ${MAX_TEMPLATE_DEPTH} deep.`);
        else if (Array.isArray(screen.steps)) {
            const why = screen.steps.map(step => (typeof step.template === 'string' ? shapeProblem(step.template) : '')).find(Boolean);
            if (why) say('steps', `a step's template ${why}.`);
        }
        const theme = screen.theme === undefined ? {} : checkTheme(screen.theme, add, `${path}.theme`);
        if (ok) out.push({ ...screen, theme, pack: packId });
    });
    return out;
}
