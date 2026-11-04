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
// `dataModuleDefinitions`: checked normalized dependency definitions for public cross-pack data imports.
// `readableConditions`: false for a pack already stored (installed.js): an event whose `when` cannot be read is then not an error, so
// it stays the one invalid event the events part makes of it (as before 2.11.3) and the rest of the pack keeps working. Install, import
// and the authoring-kit checker leave it true.
//
import { CONTENT_KINDS, DEFAULT_CRAFTS, METER_LIMITS, LIMITS, PACK_FIELDS, PACK_ID, SEMVER, SLUG, TERMS_LIMITS } from './limits.js';
import { byteLength, checkPlain } from './safety.js';
import { parseRange, satisfies } from './version.js';
import { oneLine } from '../../text.js';
import { validateDataModules, dataModulesPackHash } from '../data-modules/check.js';
import { STRINGS } from '../strings.js';
import { checkCast } from './cast.js';
import { HOST_VERSION, fail, isObject, records, openRecord } from './validate/core.js';
import {
    checkCurrency, checkEconomy, checkWeather, checkEvent, checkChoice, linkEvents, checkSkill, choiceRefs,
    checkPreset, checkStart,
} from './validate/events-economy.js';
import { checkCalendar, checkPlace, placeRefs, checkRoute, routeSlug, checkTerms, termsSlug, checkRanks, checkMarkets } from './validate/world.js';
import { checkItem, itemRefs, checkShop, checkCrafts, checkRecipe, checkMeterPreset, checkRpg, checkYou } from './validate/items.js';
import { checkScreens, checkTheme } from './validate/theme.js';
export { HOST_VERSION, slugify } from './validate/core.js';
export { unsafeCss, checkScreens } from './validate/theme.js';

/**
 * Checks and normalizes one pack. Nothing here touches settings or state.
 */
export function validatePack(input, { hostVersion = HOST_VERSION, capabilities = null, limits = LIMITS, dataModuleDefinitions = [], readableConditions = true } = {}) {
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
    const pack = normalize(raw, { add, hostVersion, capabilities, limits, dataModuleDefinitions, readableConditions });
    if (errors.length) return { ok: false, errors };
    const result = { ok: true, pack, raw };
    if (pack.content.dataModules !== undefined) {
        // Hash the checked snapshot, before a consumer can edit its detached result.
        Object.defineProperty(result, 'packHash', { value: dataModulesPackHash(pack), enumerable: false, configurable: true });
    }
    return result;
}

function normalize(raw, { add, hostVersion, capabilities, limits, dataModuleDefinitions, readableConditions }) {
    for (const key of Object.keys(raw)) if (!PACK_FIELDS.includes(key)) add('UNKNOWN_FIELD', key, `"${key}" is not a pack field (expected ${PACK_FIELDS.join(', ')}).`);

    const id = raw.id;
    if (typeof id !== 'string' || !PACK_ID.test(id)) add('BAD_ID', 'id', 'id must be 1 to 40 lowercase letters, digits or dashes, starting with a letter or digit (like "fantasy-basics").');
    else if (id === 'chat') add('BAD_ID', 'id', STRINGS.blocks.reservedPack);
    const packId = typeof id === 'string' && PACK_ID.test(id) ? id : 'invalid';
    if (typeof raw.version !== 'string' || !SEMVER.test(raw.version)) add('BAD_VERSION', 'version', 'version must look like 1.0.0.');
    for (const field of ['name', 'author']) {
        if (raw[field] !== undefined && (typeof raw[field] !== 'string' || [...raw[field]].length > limits.name)) add('BAD_FIELD', field, `${field} must be text of at most ${limits.name} characters.`);
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') add('BAD_FIELD', 'description', 'description must be text.');

    const requires = checkRequires(raw.requires, { add, hostVersion, capabilities });
    const currency = raw.currency === undefined ? null : checkCurrency(raw.currency, add);
    const calendar = raw.calendar === undefined ? null : checkCalendar(raw.calendar, add);
    const economy = raw.economy === undefined ? null : checkEconomy(raw.economy, add);
    const weather = raw.weather === undefined ? null : checkWeather(raw.weather, add);

    const content = {};
    if (raw.content !== undefined && !isObject(raw.content)) add('BAD_CONTENT', 'content', 'content must be an object of lists: { "items": [ … ], "events": [ … ] }.');
    const given = isObject(raw.content) ? raw.content : {};
    for (const kind of Object.keys(given)) if (!CONTENT_KINDS.includes(kind) && kind !== 'you') add('UNKNOWN_KIND', `content.${kind}`, `"${kind}" is not a content kind (expected ${[...CONTENT_KINDS, 'you'].join(', ')}).`);
    // Items first: shops, recipes and the start state refer to them.
    const items = records(given.items, 'items', { add, packId, check: (record, path, label) => checkItem(record, path, label, add) });
    content.items = items;
    const ref = itemRefs(items, packId);
    content.creatures = records(given.creatures, 'creatures', { add, packId, check: openRecord });
    content.shops = records(given.shops, 'shops', { add, packId, check: (record, path) => checkShop(record, path, add, ref) });
    // Crafts before recipes: a recipe's `craft` is a default craft or one this pack declares.
    const crafts = given.crafts === undefined ? null : checkCrafts(given.crafts, packId, add);
    const craftIds = new Set([...DEFAULT_CRAFTS.map(craft => craft.craft), ...(crafts ?? []).map(craft => craft.slug)]);
    content.recipes = records(given.recipes, 'recipes', { add, packId, check: (record, path) => checkRecipe(record, path, add, ref, craftIds) });
    content.events = records(given.events, 'events', { add, packId, check: (record, path) => checkEvent(record, path, add, readableConditions), slugField: 'id' });
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
        if (Array.isArray(given.terms) && given.terms.length > TERMS_LIMITS.records) add('BAD_CONTENT', 'content.terms', `content.terms holds at most ${TERMS_LIMITS.records} records.`);
        else content.terms = records(given.terms, 'terms', { add, packId, check: (record, path, label) => checkTerms(record, path, label, add), slugField: 'id', named: false, autoSlug: termsSlug() });
    }
    if (given.ranks !== undefined) content.ranks = checkRanks(given.ranks, packId, add);
    if (given.markets !== undefined) content.markets = checkMarkets(given.markets, packId, add);
    // Do not create this key for old packs: their normalized bytes and hashes are history.
    if (given.dataModules !== undefined) {
        const checked = validateDataModules(given.dataModules, { packId, capabilities: requires.capabilities, definitions: dataModuleDefinitions });
        if (checked.ok) content.dataModules = checked.definitions;
        else for (const error of checked.errors) add(error.code, error.path, error.message);
    }
    if (crafts !== null) content.crafts = crafts;
    if (given.meterPresets !== undefined) {
        if (Array.isArray(given.meterPresets) && given.meterPresets.length > METER_LIMITS.presets) add('BAD_CONTENT', 'content.meterPresets', `content.meterPresets holds at most ${METER_LIMITS.presets} presets.`);
        else content.meterPresets = records(given.meterPresets, 'meterPresets', { add, packId, check: (record, path) => checkMeterPreset(record, path, add), slugField: 'id', named: false });
    }
    if (given.rpg !== undefined) content.rpg = checkRpg(given.rpg, packId, add);
    // The cast (cast.js): kept only when given, so older packs normalize as they always did.
    if (given.cast !== undefined) content.cast = checkCast(given.cast, packId, add, items);
    // Not a list: kept only when given (so older packs' bytes and hashes stay), and only when it checks.
    if (given.you !== undefined) {
        const you = checkYou(given.you, add);
        if (you) content.you = you;
    }

    const start = raw.start === undefined ? null : checkStart(raw.start, add, ref);
    let layouts = [];
    if (raw.layouts !== undefined) {
        if (!Array.isArray(raw.layouts) || raw.layouts.some(layout => !isObject(layout))) add('BAD_LAYOUTS', 'layouts', 'layouts must be a list of layout objects.');
        else layouts = raw.layouts.map(layout => ({ ...layout, pack: packId }));
    }
    const screens = raw.screens === undefined ? [] : checkScreens(raw.screens, packId, add);
    const theme = raw.theme === undefined ? {} : checkTheme(raw.theme, add, 'theme');

    return {
        id: packId,
        version: raw.version,
        name: [...oneLine(raw.name || packId)].slice(0, limits.name).join(''),
        author: [...oneLine(raw.author ?? '')].slice(0, limits.name).join(''),
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
