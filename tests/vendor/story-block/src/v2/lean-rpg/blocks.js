// The Standard formula's bars (agreed 1 Nov): a bar is a row of blocks. The stored value counts the blocks left (Health 0..8, Stamina
// 0..7, Mana 0..7 on a character; a foe group's Health 0..8); how many blocks the bar has is worked out from the stats when it is read
// (formula.js `blocksFor`, `foeHealthBlocks`), never stored as the value. A field says it is such a bar with `blocks` on its schema
// ('health' | 'stamina' | 'mana' on a character, 'foe' on a foe slot's `hurtN`); a field without it is a Classic stage field and is read
// exactly as before (party-data.js, read.js, tail.js).
//
// The stage words (Down … Unhurt, Empty … Fresh) are spread over the bar's size: the first and last block are exact (0 blocks is the
// first word, a full bar the last), every other count takes the nearest of the words in between. The story still reads words, never
// numbers, and writes a word: the Standard templates turn the word into blocks for the bar's size with the same rounding (`wordToBlocks`).
// Pure: no DOM, no state, no randomness.

import { STAT_KEYS, blocksFor, foeHealthBlocks, LUCK_STEPS, luckWindow } from './formula.js';
import { STAGES } from './names.js';

const whole = value => (Number.isSafeInteger(value) ? value : 0);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The bar of a field: 'health' | 'stamina' | 'mana' | 'foe' when its schema has `blocks`, else null. */
export const barOf = schema => (schema?.type === 'int' && ['health', 'stamina', 'mana', 'foe'].includes(schema.blocks) ? schema.blocks : null);

/** The words a bar's stages go by, empty first. A foe's Health uses Health's. */
export const wordsOf = bar => (bar === 'foe' ? STAGES.health : STAGES[bar]) ?? STAGES.health;

/** The stats a block's fields hold, as `{ str … cha }` numbers. */
export const statsOfFields = fields => Object.fromEntries(STAT_KEYS.map(key => [key, whole(fields?.[key])]));

/**
 * The stage word of `value` blocks left in a bar of `size` blocks, from `words` (empty first, full last): 0 is the first word, a full bar the
 * last, anything between the nearest word in between (the first and last are kept for exactly empty and exactly full).
 */
export function spreadIndex(value, size, count) {
    const last = count - 1;
    if (!(size > 0) || value <= 0) return 0;
    if (value >= size) return last;
    return Math.min(last - 1, Math.max(1, Math.floor((2 * value * last + size) / (2 * size))));
}
export const spreadWord = (words, value, size) => words[spreadIndex(value, size, words.length)] ?? '';

/**
 * The blocks a stage word stands for in a bar of `size` blocks: the first word is 0, the last the full bar, and the word at position `index` in
 * between is `index / (words − 1)` of the bar, rounded to the nearest block. (This is the number the Standard templates' kinds work out,
 * written there as `floorDiv(index × size + (words − 1)/2, words − 1)`.)
 */
export const wordToBlocks = (index, size, count) => Math.floor((2 * index * size + (count - 1)) / (2 * (count - 1)));

/**
 * How many blocks the bar `key` of a block has now, or null when the field is not a block bar. `key` is `health`, `mana`, `stamina` or a
 * foe slot's `hurtN`; `fields` holds the stats (a character) or the slot's class (a foe).
 */
export function sizeOf(schema, fields, key) {
    const bar = barOf(schema);
    if (!bar) return null;
    if (bar === 'foe') {
        const slot = /^hurt(\d+)$/.exec(String(key))?.[1];
        return foeHealthBlocks(slot ? whole(fields?.[`class${slot}`]) || 1 : 1);
    }
    return blocksFor(statsOfFields(fields))[bar];
}

/**
 * One bar as the views read it: `{ value, size, word }` with the value held to 0..size. `schema` is the field's; the caller falls back to the
 * stage reading when `barOf(schema)` is null.
 */
export function barReading(schema, fields, key) {
    const bar = barOf(schema), size = sizeOf(schema, fields, key);
    if (!bar) return null;
    const value = Math.min(size, Math.max(0, whole(fields?.[key])));
    return { value, size, word: spreadWord(wordsOf(bar), value, size) };
}

/** The bars of a character that are blocks: `{ health, stamina, mana }` readings, or null when its Health field is not a block bar. */
export function characterBars(definition, fields) {
    const state = isRecord(definition?.state) ? definition.state : {};
    if (!barOf(state.health)) return null;
    return Object.fromEntries(['health', 'stamina', 'mana'].map(key => [key, barReading(state[key], fields, key)]));
}

/** What a new character's bars hold for `stats`: full bars, and the sizes the Standard Character block's rules compare against. */
export function barFields(stats) {
    const size = blocksFor(stats);
    return { health: size.health, stamina: size.stamina, mana: size.mana, 'health-blocks': size.health, 'stamina-blocks': size.stamina, 'mana-blocks': size.mana };
}

const nextAbove = (value, step) => (Math.floor(whole(value) / step) + 1) * step;

/**
 * The line under a character's skills: how many blocks each bar has and the stat that earns the next one, and luck with the next
 * step. `{ health: { blocks, stat, value, next }, stamina, mana, luck: { min, max, stat, current, next } }` (`next` is the stat value that
 * brings one more block, or null when there is none to come: the edge window steps at LUK 5, 7, 11, 13, 15, 17 and 19, and a bar stops growing at the stat maximum).
 */
export function growthOf(stats, { statMax = 20 } = {}) {
    const size = blocksFor(stats);
    const bar = (blocks, stat) => { const next = nextAbove(stats?.[stat], 5); return { blocks, stat, value: whole(stats?.[stat]), next: next <= statMax ? next : null }; };
    const luk = whole(stats?.luk), step = LUCK_STEPS.find(at => at > luk) ?? null;
    return { health: bar(size.health, 'vit'), stamina: bar(size.stamina, 'agi'), mana: bar(size.mana, 'int'), luck: { ...luckWindow(luk), stat: 'luk', current: luk, next: step } };
}

/** The stage word of `value` blocks left in a bar of `size` blocks, for a bar kind ('health' | 'stamina' | 'mana' | 'foe'): what the planner's sheet and the views say. */
export const stageText = (bar, value, size) => spreadWord(wordsOf(bar), Math.max(0, whole(value)), size);
