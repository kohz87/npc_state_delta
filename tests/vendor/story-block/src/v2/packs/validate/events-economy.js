// Story Suite v2: the pack validator's checks for events and the economy (moved out of packs/validate.js unchanged): events and the
// links between them, currency, economy, weather, choices, the start, skills and presets.

import {
    EVENT_FIELDS, EVENT_LIMITS, SLUG, COMMAND, ECONOMY_FIELDS, ECONOMY_LIMITS, WEATHER_LIMITS, WEATHER_FIELDS,
    WEATHER_SEASON_FIELDS, CALENDAR_LIMITS, WEATHER_TABLE_FIELDS, CHOICE_FIELDS, RECORD_LIMITS, LIMITS,
    START_FIELDS, SKILL_FIELDS, SKILL_TYPES, STAT_NAME, SKILL_TARGETS, PRESET_FIELDS,
} from '../limits.js';
import { oneLine, foldKey } from '../../../text.js';
import { MAX_COINS, MAX_COIN_VALUE, coinsOf } from '../../domains/money.js';
import { compile } from '../../events/condition.js';
import { isObject, fullId, isNumber, isText, isInt } from './core.js';

// Commands the host makes for itself (registry.js CAPTURE_PREFIX, INIT_PREFIX; events/engine.js FIRE):
// a change line the story never wrote, a module's state reset, an event firing another. Not for packs.
const HOST_COMMAND = /^(?:capture\.|module\.)|^events\.fire$/;

export function checkEvent(record, path, add, readableConditions = true) {
    const label = `Event "${record.id}"`;
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!EVENT_FIELDS.includes(key)) say(key, `"${key}" is not an event field (expected ${EVENT_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    if (typeof record.when !== 'string' || !record.when.trim() || record.when.length > EVENT_LIMITS.when) say('when', `when must be a condition of 1 to ${EVENT_LIMITS.when} characters.`);
    else if (readableConditions) {
        // The parser the events use while the story plays: a condition it cannot read would only fail at play time.
        const parsed = compile(record.when);
        if (!parsed.ok) say('when', `the condition can't be read: ${parsed.error.message}${/never closed/.test(parsed.error.message) ? ' A name with an apostrophe in it needs double quotes around it.' : ''}`);
    }
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
export function linkEvents(events, packId, add) {
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
export function checkCurrency(currency, add) {
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
export function checkEconomy(economy, add) {
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
export function checkWeather(weather, add) {
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
export function checkChoice(record, path, label, add) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!CHOICE_FIELDS.includes(key)) say(key, `"${key}" is not a field here (expected ${CHOICE_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const note = record.note ?? '';
    if (typeof note !== 'string' || note.length > RECORD_LIMITS.note) say('note', 'note must be text of at most 500 characters.');
    const stats = record.stats ?? {};
    if (!isObject(stats) || Object.values(stats).some(n => !Number.isInteger(n))) say('stats', 'stats must map names to whole numbers: { "STR": 1 }.');
    const tags = record.tags ?? [];
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > RECORD_LIMITS.word)) say('tags', 'tags must be a list of short words.');
    if (!ok) return null;
    return { name: oneLine(record.name, LIMITS.name), note, stats: { ...stats }, tags: tags.map(tag => tag.trim()) };
}

export function checkStart(start, add, ref) {
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
            if (line.note !== undefined && (typeof line.note !== 'string' || line.note.length > RECORD_LIMITS.note)) return add('BAD_START', `${at}.note`, `${at}.note must be text of at most 500 characters.`);
            out.inventory.items.push({ item: id, qty: line.qty ?? 1, note: line.note ?? '' });
        });
        // Money is one whole number of the chat's one currency, like item values (MODULES §F1).
        const money = inventory.money ?? 0;
        if (!isInt(money)) add('BAD_START', 'start.inventory.money', 'start.inventory.money must be a whole number of 0 or more.');
        else out.inventory.money = money;
    }
    return out;
}

// A skill template describes a skill; its numbers are supplied by the consuming module.
export function checkSkill(record, path, label, add) {
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
    if (element !== null && (typeof element !== 'string' || (!/^[a-z]+$/.test(element) || element.length > RECORD_LIMITS.element))) say('element', 'element must be one short lowercase word, like "fire", or left out.');
    const note = record.note ?? '';
    if (!isText(note, RECORD_LIMITS.note)) say('note', 'note must be text of at most 500 characters.');
    const tags = record.tags ?? [];
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > RECORD_LIMITS.word)) say('tags', 'tags must be a list of short words.');
    if (!ok) return null;
    return { name: oneLine(record.name, LIMITS.name), type, stat, target, element, note, tags: tags.map(tag => tag.trim()) };
}

// How a preset names a race, talent or skill of this pack: its id or slug, its name, or its
// full id (`pack.<id>/<slug>`). Returns the full id or null.
export function choiceRefs(list) {
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
export function checkPreset(record, path, label, add, choose) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!PRESET_FIELDS.includes(key)) say(key, `"${key}" is not a preset field (expected ${PRESET_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const note = record.note ?? '';
    if (!isText(note, RECORD_LIMITS.note)) say('note', 'note must be text of at most 500 characters.');
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
