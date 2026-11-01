// A saved character (Export / Import a character): the file the Party tab's Export writes and the New character wizard's Import reads.
// Pure: no DOM. It holds only what the user chose to carry between chats: Soul Class, unspent points, the seven stats, up to five skills
// (name, what it does, stat (left out for a skill whose block has none: a stat is never guessed), Stamina or Mana, rank), and, if left on, the things the character carries and the purse.
//
//   { "storySuiteCharacter": 1, "soul": 2, "points": 3, "stats": { "str": 14, … "cha": 10 },
//     "skills": [{ "name", "about", "stat"?, "uses", "rank" }], "items"?: [{ "name", "qty", "note"?, "kind"?, "rarity"? }], "money"?: <base units> }
//
// `parseCharacterFile` checks a file with the RPG's own limits (the Character and Skills fields, the inventory's name and note lengths)
// and hands back a clean copy: unknown keys are dropped, text is one line, nothing is kept that was not asked for. A bad file is
// `{ ok: false, message }` in plain words; nothing is read from it beyond that. Never throws.

import { KINDS, RARITIES } from '../domains/inventory.js';
import { formatAmount } from '../domains/money.js';
import { CREATION, RANK_NAMES, SKILL_SLOTS, STATS, USES } from './names.js';
import { RPG_STRINGS, fill } from './strings.js';

const F = RPG_STRINGS.file;

/** The key that marks the file, and the version of its shape. */
export const CHAR_FILE = 'storySuiteCharacter';
export const CHAR_VERSION = 1;

/** What the file may hold: the RPG's own limits where it has them (names.js CREATION, the Character block's fields), the inventory's elsewhere. */
export const FILE_LIMITS = Object.freeze({
    bytes: 65536, soul: Object.freeze([1, 9]), points: 60, stat: Object.freeze([1, 20]), rank: 3,
    items: 60, itemName: 60, itemNote: 300, qty: 999, money: 1_000_000_000,
});

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
// One line of text, cut by code points (the same shape the wizard keeps its text in).
const line = (value, max) => [...(typeof value === 'string' ? value.replace(/\p{Cf}+/gu, '').normalize('NFC').replace(/\s+/g, ' ').trim() : '')].slice(0, max).join('').trim();
const bad = message => ({ ok: false, message });

/**
 * A saved character file, as the plain object that is written. `character`: { soul, points, stats, skills: [{ name, about, stat?, uses, rank }] };
 * `items` (omit to leave the inventory out): [{ name, qty, note?, kind?, rarity? }]; `money` (omit to leave the purse out): whole base units.
 */
export function buildCharacterFile({ soul, points, stats, skills = [], items = null, money = null }) {
    const file = {
        [CHAR_FILE]: CHAR_VERSION, soul, points,
        stats: Object.fromEntries(STATS.map(stat => [stat, stats[stat]])),
        skills: skills.slice(0, SKILL_SLOTS).map(skill => ({ name: skill.name, about: skill.about, ...(STATS.includes(skill.stat) ? { stat: skill.stat } : {}), uses: skill.uses, rank: skill.rank })),
    };
    if (Array.isArray(items)) {
        file.items = items.map(item => ({ name: item.name, qty: item.qty, ...(item.note ? { note: item.note } : {}),
            ...(item.kind ? { kind: item.kind } : {}), ...(item.rarity ? { rarity: item.rarity } : {}) }));
    }
    if (Number.isSafeInteger(money)) file.money = money;
    return file;
}

/** The text written to the file. */
export const fileText = file => `${JSON.stringify(file, null, 2)}\n`;

/** "wessel.character.json" for a name (letters and digits only; "character" when the name leaves none). */
export function fileNameOf(name) {
    const slug = [...String(name ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')].slice(0, 40).join('').replace(/-+$/, '');
    return `${slug || 'character'}.character.json`;
}

function readSkill(entry) {
    if (!isRecord(entry)) return null;
    const name = line(entry.name, CREATION.skillName);
    // A skill with no stat (an old Skills block had none) is read without one: both a missing key and null mean "none"; any other value is not valid.
    const hasStat = entry.stat !== undefined && entry.stat !== null;
    if (!name || (hasStat && !STATS.includes(entry.stat)) || !USES.includes(entry.uses) || !whole(entry.rank, 0, FILE_LIMITS.rank)) return null;
    return { name, about: line(entry.about, CREATION.skillAbout), ...(hasStat ? { stat: entry.stat } : {}), uses: entry.uses, rank: entry.rank };
}

function readItem(entry) {
    if (!isRecord(entry)) return null;
    const name = line(entry.name, FILE_LIMITS.itemName);
    if (!name || !whole(entry.qty, 1, FILE_LIMITS.qty)) return null;
    const note = line(entry.note, FILE_LIMITS.itemNote);
    // A kind or rarity this build does not know is left out, so the thing is added as the inventory would add it.
    return { name, qty: entry.qty, ...(note ? { note } : {}), ...(KINDS.includes(entry.kind) ? { kind: entry.kind } : {}), ...(RARITIES.includes(entry.rarity) ? { rarity: entry.rarity } : {}) };
}

/**
 * Reads a file's text. → `{ ok: true, file }` with `file` = { soul, points, stats, skills, items?, money? } (clean copies, `items` and `money`
 * only when the file had them), or `{ ok: false, message }`.
 */
export function parseCharacterFile(text) {
    try {
        if (typeof text !== 'string' || !text.trim()) return bad(F.empty);
        if (new TextEncoder().encode(text).length > FILE_LIMITS.bytes) return bad(F.tooBig);
        let data;
        try { data = JSON.parse(text); } catch { return bad(F.notJson); }
        if (!isRecord(data) || !Object.hasOwn(data, CHAR_FILE)) return bad(F.notCharacter);
        if (data[CHAR_FILE] !== CHAR_VERSION) return bad(F.version);
        if (!whole(data.soul, ...FILE_LIMITS.soul)) return bad(F.soul);
        if (!whole(data.points, 0, FILE_LIMITS.points)) return bad(fill(F.points, { max: FILE_LIMITS.points }));
        if (!isRecord(data.stats)) return bad(F.stats);
        const stats = {};
        for (const stat of STATS) {
            if (!whole(data.stats[stat], ...FILE_LIMITS.stat)) return bad(fill(F.stat, { stat: stat.toUpperCase() }));
            stats[stat] = data.stats[stat];
        }
        const rawSkills = data.skills ?? [];
        if (!Array.isArray(rawSkills) || rawSkills.length > SKILL_SLOTS) return bad(fill(F.skills, { max: SKILL_SLOTS }));
        const skills = [];
        for (const [at, entry] of rawSkills.entries()) {
            const skill = readSkill(entry);
            if (!skill) return bad(fill(F.skill, { n: at + 1 }));
            skills.push(skill);
        }
        const file = { soul: data.soul, points: data.points, stats, skills };
        if (data.items !== undefined) {
            if (!Array.isArray(data.items) || data.items.length > FILE_LIMITS.items) return bad(fill(F.items, { max: FILE_LIMITS.items }));
            file.items = [];
            for (const [at, entry] of data.items.entries()) {
                const item = readItem(entry);
                if (!item) return bad(fill(F.item, { n: at + 1, max: FILE_LIMITS.qty }));
                file.items.push(item);
            }
        }
        if (data.money !== undefined) {
            if (!whole(data.money, 0, FILE_LIMITS.money)) return bad(fill(F.money, { max: FILE_LIMITS.money.toLocaleString('en-US') }));
            file.money = data.money;
        }
        return { ok: true, file };
    } catch {
        return bad(F.notJson);
    }
}

/**
 * The things a character carries as the file keeps them, from the inventory's rows (`inventory.items`): one entry for each
 * name, note, kind and rarity (counts added up), the first `FILE_LIMITS.items`. Rows the file cannot hold are left out.
 */
export function itemsForFile(rows) {
    const out = [], at = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const item = readItem({ name: row?.name, qty: row?.qty, note: row?.note, kind: row?.kind, rarity: row?.rarity });
        if (!item) continue;
        const key = JSON.stringify([item.name.toLowerCase(), item.note ?? '', item.kind ?? '', item.rarity ?? '']);
        if (at.has(key)) {
            const had = out[at.get(key)];
            had.qty = Math.min(FILE_LIMITS.qty, had.qty + item.qty);
        } else if (out.length < FILE_LIMITS.items) {
            at.set(key, out.length);
            out.push(item);
        }
    }
    return out;
}

/** "Torch ×2", "Oilskin Coat (waxed, a little too big)": one thing as the dialogs list it. */
export const itemLine = item => `${item.name}${item.qty === 1 ? '' : ` ×${item.qty}`}${item.note ? ` (${item.note})` : ''}`;

/** "Iron Breath (Expert)": one skill with its rank. */
export const skillLine = skill => `${skill.name} (${RANK_NAMES[skill.rank] ?? RANK_NAMES[0]})`;

/** An amount of money as the wallet words it (the chat's coins), with thousands separators on every long number: "10,000,000 gold", "1,200 silver 5 copper". */
export const moneyText = (amount, currency) => formatAmount(amount, currency).replace(/\d{4,}/g, digits => Number(digits).toLocaleString('en-US'));

/** "4 things" / "1 thing" for a number of things (stacks as the file lists them). */
export const thingsWord = n => fill(n === 1 ? RPG_STRINGS.wizard.thing : RPG_STRINGS.wizard.things, { n });
