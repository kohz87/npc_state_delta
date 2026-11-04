// A fight opened by the pre-call (stage 47): the planner may list foes that are not on the Foes block yet (`foe <name> | new |
// count: n | class: X`) when the reader's message starts a fight against them. Code checks each one (vetOpen) and, only
// when the plan is rolled, fills a free foe slot through the block's own `set-slot-N` kind (openFoes), as part of the
// `rpg.resolve` step on the reply, so a swipe plans again, a Re-read keeps it, deleting the reply takes it back and a
// rebuild, the live state and a reload agree. The accepted foes travel in the plan as `plan.open`:
//     open: [{ name, count (1–12), level (1–99) | rank (a name) with from, to (its band, 1–99) | nothing more }]
// A foe with no `level` gets one when the plan is rolled (resolve.js): a seeded level inside the rank's band, or within ±2 of the party's average level.
// (A plan made before the Levels rules has `class` (1–9) instead and is read as it was.)
// Pure except openFoes, which writes the domain it is given (the transaction's draft, or a copy to look ahead).
import { createEvaluation } from '../data-modules/interpreter.js';
import { CLASS_NAMES, FIX_VERSION, FOE_SLOTS } from './names.js';
import { FOE_LEVEL, bandOfRank, classOfLevel, foeLevelCap, levelOf, levelOfClass, partyLevels } from './foes.js';
import { fold, readSheet } from './read.js';

export const OPEN_MAX_COUNT = 12;
export const OPEN_MAX_NAME = 40;
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on']);

const oneLine = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

// A word as compared: lower case, a plural -s ignored.
const stem = word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);
const wordsOf = text => String(text ?? '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem);

/** The distinctive words of a foe's name: not an article or a small joining word. */
export const distinctiveWords = name => wordsOf(name).filter(word => !STOP.has(word));

/** Whether at least one distinctive word of `name` appears, as a whole word, in any of `texts` (the reader's message, the shown text before). */
export function isNamedIn(name, texts) {
    const wanted = distinctiveWords(name);
    if (!wanted.length) return false;
    const seen = new Set(texts.flatMap(wordsOf));
    return wanted.some(word => seen.has(word));
}

// A level as the planner wrote it: "14", "Lv 14" or "level 14". An old "class: III" (or 3) stands for the level of that class.
const levelWritten = value => {
    const word = oneLine(value).replace(/^(?:level|lv\.?)\s*/iu, '');
    return /^\d+$/u.test(word) ? levelOf(Number(word)) : null;
};
const classWritten = value => {
    const word = oneLine(value).replace(/^class\s*/iu, '').toUpperCase();
    const soulClass = /^\d+$/u.test(word) ? Number(word) : CLASS_NAMES.indexOf(word) + 1;
    return levelOfClass(soulClass);
};
const RANK_MAX = 12;

/**
 * The foes a pre-call asked for as new, held to the rules: `requested` = [{ name, count?, level?, rank?, class? }] (text as written), `sheet` = readSheet, `texts` = the
 * reader's latest message and the shown text of the reply before, `rankAt(level)` → `{ name } | null` (the `rpg.rank` query; none: ranks are not known).
 * → { open: [{ name, count, level } | { name, count, rank, from, to } | { name, count }], refused: [{ name, why }] }.
 * A name must share a distinctive word with the texts (never invented); one already on the sheet, or asked twice, is not new; the count is
 * held to 1–12 (none: 1). The level is the one written (held to 1–99); else the rank's band (a rank no pack names is passed over); else an old class
 * stands for its level; else the level is left to be drawn when the plan is rolled.
 */
export function vetOpen(requested, sheet, texts, { rankAt = null } = {}) {
    const open = [], refused = [];
    // A new foe is at most one band (10 levels) above the party's highest level: a level or rank above that is held down to it.
    const cap = foeLevelCap(partyLevels(sheet));
    // (a standing group is already there; a Down one is beaten and a new group of its name is new: openFoes replaces it)
    const known = new Set((sheet?.foes ?? []).filter(foe => foe.filled && foe.hurt > 0).map(foe => fold(foe.name)));
    for (const entry of requested ?? []) {
        const name = oneLine(entry?.name).slice(0, OPEN_MAX_NAME).trim();
        if (!name) continue;
        const key = fold(name);
        if (known.has(key)) continue;
        if (!isNamedIn(name, texts)) { refused.push({ name, why: 'not named' }); continue; }
        known.add(key);
        const count = Number.parseInt(oneLine(entry.count), 10);
        const counted = Number.isInteger(count) ? Math.max(1, Math.min(OPEN_MAX_COUNT, count)) : 1;
        const level = levelWritten(entry.level) ?? (oneLine(entry.rank) ? null : classWritten(entry.class));
        if (level !== null) { open.push({ name, count: counted, level: Math.min(level, cap) }); continue; }
        const rank = oneLine(entry.rank).slice(0, RANK_MAX), band = rank ? bandOfRank(rank, rankAt) : null;
        open.push(band ? (band.from > cap ? { name, count: counted, level: cap } : { name, count: counted, rank, from: band.from, to: Math.min(band.to, cap) }) : { name, count: counted });
    }
    return { open: open.slice(0, FOE_SLOTS), refused };
}

/** Whether `open` is a list the plan may carry (plan.js validatePlan asks). */
export function openErrors(open) {
    if (!Array.isArray(open)) return ['open must be a list.'];
    const errors = [];
    if (open.length > FOE_SLOTS) errors.push(`open may hold at most ${FOE_SLOTS} entries.`);
    open.forEach((entry, n) => {
        const where = `open ${n + 1}`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${where} must be an object.`); return; }
        for (const key of Object.keys(entry)) if (!['name', 'count', 'class', 'level', 'rank', 'from', 'to'].includes(key)) errors.push(`${where} has "${key}", which a plan does not use.`);
        if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > OPEN_MAX_NAME) errors.push(`${where} needs a name (text, at most ${OPEN_MAX_NAME} characters).`);
        if (!Number.isInteger(entry.count) || entry.count < 1 || entry.count > OPEN_MAX_COUNT) errors.push(`${where} count must be a whole number from 1 to ${OPEN_MAX_COUNT}.`);
        // (A plan from before the Levels rules has a class; one from after has a level, a rank with its band, or neither.)
        if (entry.class !== undefined) {
            if (!Number.isInteger(entry.class) || entry.class < 1 || entry.class > CLASS_NAMES.length) errors.push(`${where} class must be a whole number from 1 to ${CLASS_NAMES.length}.`);
            if (['level', 'rank', 'from', 'to'].some(key => entry[key] !== undefined)) errors.push(`${where} has a class and a level, which it cannot have together.`);
        }
        const whole = value => Number.isInteger(value) && value >= FOE_LEVEL.min && value <= FOE_LEVEL.max;
        if (entry.level !== undefined && !whole(entry.level)) errors.push(`${where} level must be a whole number from ${FOE_LEVEL.min} to ${FOE_LEVEL.max}.`);
        if ((entry.from !== undefined || entry.to !== undefined || entry.rank !== undefined) && !(typeof entry.rank === 'string' && entry.rank.length > 0 && entry.rank.length <= RANK_MAX && whole(entry.from) && whole(entry.to) && entry.from <= entry.to)) errors.push(`${where} needs a rank (at most ${RANK_MAX} characters) with the band it names: from and to, 1 to ${FOE_LEVEL.max}, from first.`);
        if (entry.level !== undefined && entry.from !== undefined) errors.push(`${where} has a level and a rank band, which it cannot have together.`);
    });
    return errors;
}

// The level and class an entry stands for, so a Foes block of either rules takes it (a block of the earlier rules has a class, one of the Levels rules a level).
const argsOf = entry => (entry.level !== undefined
    ? { level: entry.level, class: classOfLevel(entry.level) }
    : { class: entry.class ?? 1, level: levelOfClass(entry.class) ?? 1 });

export { FIX_VERSION };

/**
 * Fills a free slot (empty or Down) of the Foes blocks in `domain` (the data-module domain) for each entry of `open`, in order, through the block's
 * own `set-slot-N` kind (its effects, run by the block interpreter); a block with no such kind (a bare sheet) has the same four fields set, the
 * health full. An entry whose name is on a standing slot already, or that finds no free (empty or Down) slot, is passed over; a Down group of the same name is replaced in its own slot. The domain is changed in place.
 * An entry carries its `level` (the Levels rules, once resolve.js has settled it) or its `class` (a plan from before). → [{ slot, module, name, count, level | class }] the
 * slots filled (the sheet's slot numbers).
 */
export function openFoes(domain, open, { fix = FIX_VERSION } = {}) {
    const placed = [];
    for (const entry of open ?? []) {
        const sheet = readSheet({ domains: { dataModules: domain } });
        // A group of that name that is standing is the one already there. A Down group (filled, hurt 0) is a beaten one and no longer holds its slot: a new
        // group of the same name replaces it, else the first empty or Down slot takes the new group, so five fights in a row never stall the block.
        const same = sheet.foes.find(foe => foe.filled && fold(foe.name) === fold(entry.name));
        // (A roll made before `fix: 2` keeps the earlier rule exactly: a filled group of the name stops the entry, only an empty slot is free, nothing is cleared.)
        if (fix < 2 ? same : same && same.hurt > 0) continue;
        const free = fix < 2 ? sheet.foes.find(foe => foe.count === 0) : same ?? sheet.foes.find(foe => foe.count === 0 || (foe.filled && foe.hurt === 0));
        if (!free) continue;
        const n = ((free.slot - 1) % FOE_SLOTS) + 1;
        const pin = domain.pins?.[domain.active?.[free.module]?.hash];
        const definition = pin?.definition;
        const instance = domain.instances?.[free.module]?.chat;
        if (!instance?.fields) continue;
        const kind = definition?.kinds?.[`set-slot-${n}`];
        if (kind?.effects && definition.state) {
            const evaluation = createEvaluation(definition, instance, { inputs: {}, source: {}, cursor: null, subject: 'chat' });
            evaluation.effects(kind.effects, { arg: { name: entry.name, count: entry.count, ...argsOf(entry) } });
            evaluation.rules();
            evaluation.finish();
        } else Object.assign(instance.fields, { [`foe${n}`]: entry.name, [`count${n}`]: entry.count, ...(entry.level !== undefined ? { [`level${n}`]: entry.level } : { [`class${n}`]: entry.class ?? 1 }), [`hurt${n}`]: 5 });
        placed.push({ slot: free.slot, module: free.module, name: entry.name, count: entry.count, ...(entry.level !== undefined ? { level: entry.level } : { class: entry.class ?? 1 }) });
    }
    // A new fight has opened: the Down groups left from earlier replies are cleared in the same step (the block's own clear kind, else its four fields), so the Foes
    // block, the log's Status and the prompts show only this fight's foes. Opening happens before this reply's rolls, so a group that goes Down in this reply stays
    // until the next fight opens and its XP is still paid.
    if (placed.length && fix >= 2) {
        const taken = new Set(placed.map(entry => entry.slot));
        for (const stale of readSheet({ domains: { dataModules: domain } }).foes.filter(foe => foe.filled && foe.hurt === 0 && !taken.has(foe.slot))) {
            const n = ((stale.slot - 1) % FOE_SLOTS) + 1;
            const definition = domain.pins?.[domain.active?.[stale.module]?.hash]?.definition;
            const instance = domain.instances?.[stale.module]?.chat;
            if (!instance?.fields) continue;
            const kind = definition?.kinds?.[`clear-${n}`];
            if (kind?.effects && definition.state) {
                const evaluation = createEvaluation(definition, instance, { inputs: {}, source: {}, cursor: null, subject: 'chat' });
                evaluation.effects(kind.effects, { arg: { why: 'gone' } });
                evaluation.rules();
                evaluation.finish();
            } else Object.assign(instance.fields, { [`foe${n}`]: '', [`count${n}`]: 0, [`hurt${n}`]: 5 });
        }
    }
    return placed;
}
