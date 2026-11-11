// Story Suite v2: the pack validator's checks for the world (moved out of packs/validate.js unchanged): places and routes, terms,
// ranks, markets and the calendar with its holidays.

import {
    PLACE_FIELDS, LIMITS, RECORD_LIMITS, MARKET_WORD, MARKET_LIMITS, RARITIES, ROUTE_FIELDS, TERMS_FIELDS,
    TERMS_LIMITS, TERM_SEPARATORS, TERMS_TIER_FIELDS, TERMS_NUMERALS, RANKS_LIMITS, RANK_FIELDS, RANK_ID,
    MARKET_FIELDS, CALENDAR_FIELDS, CALENDAR_LIMITS, CALENDAR_HOLIDAY_FIELDS, CALENDAR_START_FIELDS,
    NAMES_FIELDS, NAMES_LIMITS, SLUG,
} from '../limits.js';
import { oneLine, foldKey } from '../../../text.js';
import { isNumber, isText, isObject, slugify, isInt } from './core.js';

// A place on the map: a name, coordinates in map units (x east, y north) and what it is.
export function checkPlace(record, path, label, add) {
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!PLACE_FIELDS.includes(key)) say(key, `"${key}" is not a place field (expected ${PLACE_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    for (const axis of ['x', 'y']) if (!isNumber(record[axis]) || Math.abs(record[axis]) > 1e6) say(axis, `${axis} must be a number (map units).`);
    for (const field of ['region', 'kind', 'layer']) if (record[field] !== undefined && !isText(record[field], LIMITS.name)) say(field, `${field} must be text of at most ${LIMITS.name} characters.`);
    const aliases = record.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > LIMITS.name)) say('aliases', 'aliases must be a list of other names for the place.');
    const note = record.note ?? '';
    if (!isText(note, RECORD_LIMITS.note)) say('note', 'note must be text of at most 500 characters.');
    for (const flag of ['hidden', 'secret']) if (record[flag] !== undefined && typeof record[flag] !== 'boolean') say(flag, `${flag} must be true or false.`);
    // Its market (PACKS.md "Markets"): a settlement type and environment tags, each a lowercase word.
    if (record.market !== undefined && !(typeof record.market === 'string' && MARKET_WORD.test(record.market))) say('market', 'market must be a settlement type, a lowercase word like "village" or "city".');
    const placeTags = record.tags ?? [];
    if (!Array.isArray(placeTags) || placeTags.length > MARKET_LIMITS.tags || placeTags.some(tag => typeof tag !== 'string' || !MARKET_WORD.test(tag))) say('tags', `tags must be a list of at most ${MARKET_LIMITS.tags} lowercase words like "river" or "port".`);
    // The most the story's items may be here (`story-block.gear`): { maxRarity }, one of the five; absent = no extra limit.
    if (record.loot !== undefined && !(isObject(record.loot) && Object.keys(record.loot).every(key => key === 'maxRarity') && RARITIES.includes(record.loot.maxRarity))) say('loot', `loot must be { "maxRarity": ${RARITIES.map(word => `"${word}"`).join(' | ')} }.`);
    if (!ok) return null;
    return {
        name: oneLine(record.name, LIMITS.name), aliases: [...new Set(aliases.map(alias => oneLine(alias, LIMITS.name)))],
        region: oneLine(record.region ?? '', LIMITS.name), kind: oneLine(record.kind ?? '', LIMITS.name), layer: oneLine(record.layer ?? '', LIMITS.name),
        x: record.x, y: record.y, note,
        // `secret` is another word for `hidden`; the map reads either.
        ...(record.hidden === true || record.secret === true ? { hidden: true } : {}),
        ...(record.market !== undefined ? { market: record.market } : {}),
        ...(record.loot !== undefined ? { loot: { maxRarity: record.loot.maxRarity } } : {}),
        ...(placeTags.length ? { tags: [...new Set(placeTags)] } : {}),
    };
}

// A route names two places of this pack by name, alias or slug; it is stored with their names.
export function placeRefs(places) {
    const byKey = new Map();
    for (const place of places) for (const key of [place.slug, ...[place.name, ...place.aliases].map(foldKey)]) if (!byKey.has(key)) byKey.set(key, place.name);
    return value => (typeof value === 'string' && value.trim() ? byKey.get(value) ?? byKey.get(foldKey(value)) ?? null : null);
}

export const routeSlug = record => slugify(`${record.from ?? ''} ${record.to ?? ''} ${record.kind ?? ''}`);

export function checkRoute(record, path, add, place) {
    const label = typeof record.from === 'string' && typeof record.to === 'string' ? `Route "${record.from}" to "${record.to}"` : path;
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!ROUTE_FIELDS.includes(key)) say(key, `"${key}" is not a route field (expected ${ROUTE_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    const from = place(record.from);
    const to = place(record.to);
    if (!from) say('from', `"${record.from ?? ''}" is not a place of this pack.`, 'UNKNOWN_REF');
    if (!to) say('to', `"${record.to ?? ''}" is not a place of this pack.`, 'UNKNOWN_REF');
    if (from && to && from === to) say('to', 'a route joins two different places.');
    if (typeof record.kind !== 'string' || !record.kind.trim() || record.kind.length > RECORD_LIMITS.word) say('kind', 'kind must say what the route is, like "road" or "river" (at most 40 characters).');
    for (const field of ['km', 'hours']) if (record[field] !== undefined && (!isNumber(record[field]) || record[field] <= 0 || record[field] > 1e6)) say(field, `${field} must be a number above 0, or left out.`);
    if (record.corridor !== undefined && !isText(record.corridor, LIMITS.name)) say('corridor', `corridor must be text of at most ${LIMITS.name} characters.`);
    const note = record.note ?? '';
    if (!isText(note, RECORD_LIMITS.note)) say('note', 'note must be text of at most 500 characters.');
    if (!ok) return null;
    return { from, to, kind: oneLine(record.kind, RECORD_LIMITS.word), km: record.km ?? null, hours: record.hours ?? null, corridor: oneLine(record.corridor ?? '', LIMITS.name), note };
}

// A record of display terms gets the slug from its `id`, else its name, else `terms`, `terms-2` … in
// file order (a pack usually has one).
export function termsSlug() {
    let count = 0;
    return record => {
        const named = typeof record.name === 'string' ? slugify(record.name) : '';
        if (named) return named;
        count += 1;
        return count === 1 ? 'terms' : `terms-${count}`;
    };
}

// The words a world uses for levels and XP (MODULES §F25), for a consuming module:
// `{ id?, name?, levelName?, xpName?, tiers?: true | { size?, numerals?, enabled? } }`. The reader's
// own terms win over these. A term is a label in a module's blocks, so it may not hold `| : # < >`
// or a line break; checkPlain has already refused any markup or script link in it.
export function checkTerms(record, path, label, add) {
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

// A ladder of ranks, lowest first for a module that reads them. The id is
// the rank as the story writes it ('F', 'SS'), kept as given and unique ignoring case, not a slug;
// `levels`, `reward` and `xp` are whole-number ranges, the reward in units of the chat's one currency and the xp (2.5.0, optional,
// at most RANKS_LIMITS.xp) the experience a job of the rank may give.
// A rank never starts below the one before it, so a ladder written highest first is caught.
export function checkRanks(list, packId, add) {
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
    // The last rank (id and range) that gave levels, the last that gave a reward and the last that gave xp.
    const last = { levels: null, reward: null, xp: null };
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
        const xp = range('xp', 0, RANKS_LIMITS.xp, `whole amounts of experience from 0 to ${RANKS_LIMITS.xp.toLocaleString('en-US')}`);
        if (!good) { ok = false; return; }
        const rank = { id: record.id, ...(title !== undefined ? { title: oneLine(title) } : {}), ...(levels ? { levels } : {}), ...(reward ? { reward } : {}), ...(xp ? { xp } : {}), pack: packId };
        for (const field of ['levels', 'reward', 'xp']) {
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

// Markets (PACKS.md "Markets"): settlement types and environment tags with their price factors.
// A module can read these alongside its own defaults. Each record is a type (`type`, with `buy`, `sell`
// and `stock`) or a tag (`tag`, with `prices` per item category); one of each name per pack.
export function checkMarkets(list, packId, add) {
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
export function checkCalendar(calendar, add) {
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

// The name lists (`content.names`, limits.js NAMES_*): one object of culture id -> { regions, given, family? } plus an optional `banned`
// list. A culture id is a slug (not `banned`). Names are one line of at most NAMES_LIMITS.name characters, kept trimmed and
// de-duplicated ignoring case. Any problem is a pack Problem and the whole section is left out (null), like a bad weather table.
export function checkNames(names, add) {
    if (!isObject(names)) {
        add('BAD_CONTENT', 'content.names', 'content.names must be an object: { "banned": [ … ], "river": { "regions": [ … ], "given": [ … ] } }.');
        return null;
    }
    let ok = true;
    const say = (code, path, message) => { ok = false; add(code, path, message); };
    const list = (value, path, max, longest, what, min = 0) => {
        if (!Array.isArray(value) || value.length < min || value.length > max || value.some(item => typeof item !== 'string' || !oneLine(item) || [...oneLine(item)].length > longest)) {
            say('BAD_CONTENT', path, `${path} must be a list of ${min ? `1 to ${max}` : `at most ${max}`} ${what}, each 1 to ${longest} characters.`);
            return [];
        }
        const seen = new Set();
        return value.map(item => oneLine(item)).filter(item => !seen.has(foldKey(item)) && seen.add(foldKey(item)));
    };
    const out = {};
    if (names.banned !== undefined) out.banned = list(names.banned, 'content.names.banned', NAMES_LIMITS.banned, NAMES_LIMITS.bannedName, 'overused names');
    const ids = Object.keys(names).filter(key => key !== 'banned');
    if (ids.length > NAMES_LIMITS.cultures) say('BAD_CONTENT', 'content.names', `content.names holds at most ${NAMES_LIMITS.cultures} cultures.`);
    for (const id of ids) {
        const path = `content.names.${id}`;
        const culture = names[id];
        if (!SLUG.test(id) || id === 'names') say('BAD_CONTENT', path, `"${id}" is not a culture id (use a lowercase slug like "river"; "names" is reserved and "banned" is the list of overused names).`);
        if (!isObject(culture)) { say('BAD_CONTENT', path, `${path} must be an object: { "regions": [ … ], "given": [ … ] }.`); continue; }
        for (const key of Object.keys(culture)) if (!NAMES_FIELDS.includes(key)) say('UNKNOWN_FIELD', `${path}.${key}`, `"${key}" is not a names field (expected ${NAMES_FIELDS.join(', ')}).`);
        const regions = list(culture.regions, `${path}.regions`, NAMES_LIMITS.regions, NAMES_LIMITS.region, 'region names', 1);
        const given = list(culture.given, `${path}.given`, NAMES_LIMITS.given, NAMES_LIMITS.name, 'given names', 1);
        const family = culture.family === undefined ? null : list(culture.family, `${path}.family`, NAMES_LIMITS.family, NAMES_LIMITS.name, 'family names');
        out[id] = { regions, given, ...(family ? { family } : {}) };
    }
    return ok ? out : null;
}
