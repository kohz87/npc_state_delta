// Story Suite v2: the pack validator's checks for items and the character (moved out of packs/validate.js unchanged): items, shops,
// recipes and crafts, the player's starting record, the RPG settings, level ranks, skill sets and meter presets.

import {
    ITEM_FIELDS, ITEM_KINDS, RARITIES, RECORD_LIMITS, LIMITS, ITEM_CARRY, ITEM_BONUS, DEF_ID, SLUG,
    DEFAULT_CRAFTS, RECIPE_LIMITS, STAT_SUM, STAT_NAME, CRAFTS_LIMITS, CRAFT_FIELDS, TERM_SEPARATORS, YOU_FIELDS,
    YOU_RANK_FIELDS, YOU_RANK_LABEL_MAX, LEAN_RPG_FIELDS, LEAN_RPG_LIMITS, RPG_FORMULAS, RPG_NUMBER_KEYS,
    RPG_RANK_LIMITS, RPG_RANK_FIELDS, RPG_PLAYER_RANK_LIMITS, RPG_PLAYER_RANK_FIELDS, SKILL_SET_FIELDS,
    SKILL_SET_SKILL_FIELDS, METER_PRESET_FIELDS, METER_LIMITS, METER_FIELDS, METER_RESERVED, METER_STAGE_FIELDS,
} from '../limits.js';
import { oneLine, foldKey } from '../../../text.js';
import { isInt, isObject, openRecord, records, isText } from './core.js';

export function checkItem(record, path, label, add) {
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
    if (slot !== null && (typeof slot !== 'string' || !slot.trim() || slot.length > RECORD_LIMITS.word)) say('slot', 'slot must be a short name like "weapon", or null.');
    const stats = record.stats ?? {};
    if (!isObject(stats) || Object.values(stats).some(n => !Number.isInteger(n))) say('stats', 'stats must map names to whole numbers: { "STR": 2 }.');
    const effect = record.effect ?? {};
    if (!isObject(effect)) say('effect', 'effect must be an object, like { "heal": 20 }.');
    const tags = record.tags ?? [];
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > RECORD_LIMITS.word)) say('tags', 'tags must be a list of short words.');
    const aliases = record.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > LIMITS.name)) say('aliases', 'aliases must be a list of other names for the item.');
    const note = record.note ?? '';
    if (typeof note !== 'string' || note.length > RECORD_LIMITS.note) say('note', 'note must be text of at most 500 characters.');
    // The carry capacity it adds while owned (worn, for equipment): PACKS.md "Carry capacity".
    if (record.carry !== undefined && !(isInt(record.carry, ITEM_CARRY.min) && record.carry <= ITEM_CARRY.max)) say('carry', `carry must be a whole number from ${ITEM_CARRY.min} to ${ITEM_CARRY.max} (the carry capacity it adds), or left out.`);
    // The gear bonus it gives while worn instead of its rarity's: 0 to 6 (`story-block.gear`).
    if (record.bonus !== undefined && !(isInt(record.bonus, ITEM_BONUS.min) && record.bonus <= ITEM_BONUS.max)) say('bonus', `bonus must be a whole number from ${ITEM_BONUS.min} to ${ITEM_BONUS.max} (the gear bonus it gives while worn), or left out.`);
    if (!ok) return null;
    return {
        name: oneLine(record.name, LIMITS.name), kind, rarity, value, stack,
        slot: slot === null ? null : slot.trim(), stats: { ...stats }, effect: { ...effect },
        tags: tags.map(tag => tag.trim()), note,
        aliases: [...new Set(aliases.map(alias => oneLine(alias, LIMITS.name)))],
        ...(record.carry !== undefined ? { carry: record.carry } : {}),
        ...(record.bonus !== undefined ? { bonus: record.bonus } : {}),
    };
}

// How a reference to an item is written inside a pack: an item's slug or name from this
// pack, or a full def ID (`story/rope`, `pack.other/iron-sword`). Returns the full ID or null.
export function itemRefs(items, packId) {
    const bySlug = new Map(items.map(item => [item.slug, item.id]));
    const byName = new Map();
    for (const item of items) for (const name of [item.name, ...item.aliases]) if (!byName.has(foldKey(name))) byName.set(foldKey(name), item.id);
    return value => {
        if (typeof value !== 'string' || !value.trim()) return null;
        if (value.includes('/')) return DEF_ID.test(value) ? value : null;
        return bySlug.get(value) ?? byName.get(foldKey(value)) ?? null;
    };
}

export function checkShop(record, path, add, ref) {
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

export function checkRecipe(record, path, add, ref, craftIds) {
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
export function checkCrafts(list, packId, add) {
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

// Your look (`content.you`, MODULES §F126): `{ "rank": { "label": "Guild rank" } }` makes a Rank part of {{user}}'s look in a story
// that uses this pack. The label is plain text of 1 to 30 characters that goes into the narrator's instructions, so no markup
// or macro; unknown keys are refused like any other content.
export function checkYou(value, add) {
    if (!isObject(value)) { add('BAD_CONTENT', 'content.you', 'content.you must be an object: { "rank": { "label": "Guild rank" } }.'); return null; }
    let ok = true;
    for (const key of Object.keys(value)) if (!YOU_FIELDS.includes(key)) { ok = false; add('UNKNOWN_FIELD', `content.you.${key}`, `"${key}" is not a content.you field (expected ${YOU_FIELDS.join(', ')}).`); }
    const rank = value.rank;
    if (rank === undefined) return ok ? {} : null;
    if (!isObject(rank)) { add('BAD_CONTENT', 'content.you.rank', 'content.you.rank must be an object: { "label": "Guild rank" }.'); return null; }
    for (const key of Object.keys(rank)) if (!YOU_RANK_FIELDS.includes(key)) { ok = false; add('UNKNOWN_FIELD', `content.you.rank.${key}`, `"${key}" is not a content.you.rank field (expected ${YOU_RANK_FIELDS.join(', ')}).`); }
    const label = typeof rank.label === 'string' ? oneLine(rank.label) : '';
    if (!label || label.length > YOU_RANK_LABEL_MAX || /[<>{}]/.test(label)) {
        add('BAD_CONTENT', 'content.you.rank.label', `content.you.rank.label must be plain text of 1 to ${YOU_RANK_LABEL_MAX} characters (no < > { }), such as "Guild rank".`);
        return null;
    }
    return ok ? { rank: { label } } : null;
}

// The RPG's skill sets (`content.rpg.skillSets`): ready-made skills the New character wizard offers, each with what the
// skill does, the stat it rolls with and what it uses (stamina unless it says mana). A set is 1 to 5 skills; a pack has up to 12 sets.
// Normalized to the list of sets, each `{ id, slug, pack, name, about, skills: [{ name, about, stat, uses }] }`.
export function checkRpg(value, packId, add) {
    if (!isObject(value)) { add('BAD_CONTENT', 'content.rpg', 'content.rpg must be an object: { "skillSets": [ … ] }.'); return []; }
    for (const key of Object.keys(value)) if (!LEAN_RPG_FIELDS.includes(key)) add('UNKNOWN_FIELD', `content.rpg.${key}`, `"${key}" is not a content.rpg field (expected ${LEAN_RPG_FIELDS.join(', ')}).`);
    if (Array.isArray(value.skillSets) && value.skillSets.length > LEAN_RPG_LIMITS.sets) {
        add('BAD_CONTENT', 'content.rpg.skillSets', `content.rpg.skillSets holds at most ${LEAN_RPG_LIMITS.sets} sets.`);
        return [];
    }
    const sets = records(value.skillSets, 'rpg.skillSets', { add, packId, check: (record, path, label) => checkSkillSet(record, path, label, add) });
    // The stat formula and its numbers (optional): one more record of the list, after the skill sets.
    const formula = value.formula, numbers = value.numbers;
    const levels = checkLevelRanks(value, packId, add);
    if (formula === undefined && numbers === undefined) return levels ? [...sets, levels] : sets;
    let ok = true;
    if (formula !== undefined && !RPG_FORMULAS.includes(formula)) { ok = false; add('BAD_CONTENT', 'content.rpg.formula', `content.rpg.formula must be one of ${RPG_FORMULAS.join(', ')}.`); }
    const given = {};
    if (numbers !== undefined) {
        if (!isObject(numbers)) { ok = false; add('BAD_CONTENT', 'content.rpg.numbers', 'content.rpg.numbers must be an object of whole numbers, like { "foeBase": 5 }.'); } else {
            for (const [key, number] of Object.entries(numbers)) {
                if (!RPG_NUMBER_KEYS.includes(key)) { ok = false; add('UNKNOWN_FIELD', `content.rpg.numbers.${key}`, `"${key}" is not an RPG number (expected ${RPG_NUMBER_KEYS.join(', ')}).`); } else if (!Number.isSafeInteger(number)) { ok = false; add('BAD_CONTENT', `content.rpg.numbers.${key}`, `content.rpg.numbers.${key} must be a whole number.`); } else given[key] = number;
            }
        }
    }
    return [...sets, ...(ok ? [{ id: `${packId}/formula`, slug: 'formula', pack: packId, ...(formula !== undefined ? { formula } : {}), ...(Object.keys(given).length ? { numbers: given } : {}) }] : []), ...(levels ? [levels] : [])];
}

// The level ranks (`content.rpg.ranks`: names for bands of levels, `[{ name, from, to }]`) and the level cap (`content.rpg.levelCap`, 1..99). The bands run
// on from level 1 with no gap or overlap (each `from` is the one after the last `to`), up to 99 at most; a name is plain text of 1 to 12 characters and
// is not repeated; up to 20 bands. → one record `{ id, slug: 'ranks', pack, ranks?, levelCap? }`, or null when nothing valid is given (the problems are said).
function checkLevelRanks(value, packId, add) {
    const L = RPG_RANK_LIMITS;
    const { ranks, levelCap, playerRank } = value;
    if (ranks === undefined && levelCap === undefined && playerRank === undefined) return null;
    let ok = true;
    const bad = (path, message) => { ok = false; add('BAD_CONTENT', `content.rpg.${path}`, message); };
    const out = [];
    if (ranks !== undefined) {
        if (!Array.isArray(ranks) || !ranks.length) bad('ranks', 'content.rpg.ranks must be a list of bands: [{ "name": "F", "from": 1, "to": 9 }, …].');
        else if (ranks.length > L.entries) bad('ranks', `content.rpg.ranks holds at most ${L.entries} bands.`);
        else ranks.forEach((rank, index) => {
            const at = `ranks[${index}]`;
            if (!isObject(rank)) return bad(at, `content.rpg.${at} must be an object: { "name": "F", "from": 1, "to": 9 }.`);
            for (const key of Object.keys(rank)) if (!RPG_RANK_FIELDS.includes(key)) { ok = false; add('UNKNOWN_FIELD', `content.rpg.${at}.${key}`, `"${key}" is not a rank field (expected ${RPG_RANK_FIELDS.join(', ')}).`); }
            const name = typeof rank.name === 'string' ? oneLine(rank.name) : '';
            if (!name || name.length > L.name || /[<>{}]/.test(name)) bad(`${at}.name`, `content.rpg.${at}.name must be plain text of 1 to ${L.name} characters (no < > { }).`);
            else if (out.some(other => foldKey(other.name) === foldKey(name))) { ok = false; add('DUPLICATE', `content.rpg.${at}.name`, `content.rpg.${at}.name repeats "${name}"; a rank is named once.`); }
            const { from, to } = rank;
            if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to > L.maxLevel || to < from) return bad(at, `content.rpg.${at} needs whole levels 1 to ${L.maxLevel} with "from" not above "to".`);
            const next = out.length ? out[out.length - 1].to + 1 : 1;
            if (from !== next) return bad(`${at}.from`, `content.rpg.${at}.from must be ${next}: ranks run on from level 1 in order, with no gap and no overlap.`);
            if (name && name.length <= L.name) out.push({ name, from, to });
        });
    }
    let cap;
    if (levelCap !== undefined) {
        if (!Number.isSafeInteger(levelCap) || levelCap < 1 || levelCap > L.maxLevel) bad('levelCap', `content.rpg.levelCap must be a whole number from 1 to ${L.maxLevel}.`);
        else cap = levelCap;
    }
    let player;
    if (playerRank !== undefined) {
        const P = RPG_PLAYER_RANK_LIMITS;
        if (!isObject(playerRank)) bad('playerRank', 'content.rpg.playerRank must be an object: { "module": "guild-membership", "field": "letter", "label": "Guild" }.');
        else {
            for (const key of Object.keys(playerRank)) if (!RPG_PLAYER_RANK_FIELDS.includes(key)) { ok = false; add('UNKNOWN_FIELD', `content.rpg.playerRank.${key}`, `"${key}" is not a playerRank field (expected ${RPG_PLAYER_RANK_FIELDS.join(', ')}).`); }
            const given = {};
            for (const [key, max] of [['module', P.ref], ['field', P.ref], ['label', P.label]]) {
                const text = typeof playerRank[key] === 'string' ? oneLine(playerRank[key]) : '';
                if (!text || text.length > max || /[<>{}]/.test(text)) bad(`playerRank.${key}`, `content.rpg.playerRank.${key} must be plain text of 1 to ${max} characters (no < > { }).`);
                else given[key] = text;
            }
            if (ok) player = given;
        }
    }
    if (!ok) return null;
    return { id: `${packId}/ranks`, slug: 'ranks', pack: packId, ...(out.length ? { ranks: out } : {}), ...(cap !== undefined ? { levelCap: cap } : {}), ...(player ? { playerRank: player } : {}) };
}

function checkSkillSet(record, path, label, add) {
    const L = LEAN_RPG_LIMITS;
    let ok = true;
    const say = (field, message, code = 'BAD_RECORD') => { ok = false; add(code, `${path}.${field}`, `${label}: ${message}`); };
    for (const key of Object.keys(record)) if (!SKILL_SET_FIELDS.includes(key)) say(key, `"${key}" is not a skill set field (expected ${SKILL_SET_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
    if (oneLine(record.name).length > L.name) say('name', `name must be text of at most ${L.name} characters.`);
    const about = record.about === undefined ? '' : record.about;
    if (typeof about !== 'string' || oneLine(about).length > L.about) say('about', `about must be text of at most ${L.about} characters.`);
    const skills = [];
    if (!Array.isArray(record.skills) || !record.skills.length || record.skills.length > L.skills) say('skills', `skills must be a list of 1 to ${L.skills} skills: [{ "name": "Spark", "about": "A small burst of magic.", "stat": "int", "uses": "mana" }].`);
    else record.skills.forEach((skill, index) => {
        const at = `skills[${index}]`;
        if (!isObject(skill)) return say(at, `${at} must be an object.`);
        for (const key of Object.keys(skill)) if (!SKILL_SET_SKILL_FIELDS.includes(key)) say(`${at}.${key}`, `"${key}" is not a skill field (expected ${SKILL_SET_SKILL_FIELDS.join(', ')}).`, 'UNKNOWN_FIELD');
        const name = typeof skill.name === 'string' ? oneLine(skill.name) : '';
        if (!name || name.length > L.skillName) say(`${at}.name`, `${at}.name must be text of 1 to ${L.skillName} characters.`);
        else if (skills.some(other => foldKey(other.name) === foldKey(name))) say(`${at}.name`, `${at}.name repeats "${name}"; a set names each skill once.`, 'DUPLICATE');
        const what = typeof skill.about === 'string' ? oneLine(skill.about) : '';
        if (!what || what.length > L.skillAbout) say(`${at}.about`, `${at}.about must be text of 1 to ${L.skillAbout} characters (what the skill does; the story reads it).`);
        const stat = typeof skill.stat === 'string' ? skill.stat.trim().toLowerCase() : '';
        if (!L.stats.includes(stat)) say(`${at}.stat`, `${at}.stat must be one of ${L.stats.join(', ')}.`);
        const uses = skill.uses === undefined ? L.uses[0] : typeof skill.uses === 'string' ? skill.uses.trim().toLowerCase() : '';
        if (!L.uses.includes(uses)) say(`${at}.uses`, `${at}.uses must be ${L.uses.join(' or ')}.`);
        if (name && what && L.stats.includes(stat) && L.uses.includes(uses)) skills.push({ name, about: what, stat, uses });
    });
    return ok ? { name: oneLine(record.name), about: oneLine(about), skills } : null;
}

// One ready-made set of NPC meters for NPC State Delta (MODULES §F81, §F90). Each meter is a whole-number
// range with a start; `bands` name stretches of it (a band reaches from its `at` to the next band's),
// `drift` pulls it toward a value by `perDay` each story day. A stage is reached when every one of its
// `needs` is: `at` 0 or more means the meter at or above it, a negative `at` at or below it (NPC State
// Delta's own rule). Code moves meters and stages; the story only proposes.
export function checkMeterPreset(record, path, add) {
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
