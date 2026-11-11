// The three d20 a reply offers outside a fight, and what is recorded with them: one seeded stream per reply, the rules and difficulty numbers it was
// offered under, the practice one use gives, and each party member's exact bonuses (the table the note tells). Pure: the same seed gives the same dice, so a
// Re-read asks again (the prelude's recorded payload and seed) without rolling anything new, and nothing here reads today's settings. (The note's text lives in
// cue.js, a shared helper, so the tail can tell it without loading this.)

import { rng } from '../../rng.js';
import { offerLine } from '../cue.js';
import { FORMULA, LEVEL, LIMITS, PRACTICE, STATS, practiceOf } from '../names.js';
import { normalizeRules, packRulesOf, rulesFromSettings } from '../rules.js';
import { bonusTable } from './result.js';

/** How many dice one reply offers. */
export const CHECK_DICE_COUNT = 3;

/** The reply's dice, in order, from its uint32 seed: three whole numbers from 1 to 20. */
export function replyDice(seed) {
    const random = rng(seed);
    return Array.from({ length: CHECK_DICE_COUNT }, () => 1 + Math.floor(random() * FORMULA.die));
}

export { offerLine };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inRange = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** The numbers a check is worked with, from the numbers in force: the level term's (every check is a levelled one), and the margins. */
const rulesOf = value => {
    const full = normalizeRules(value);
    return { levelDivisor: full.levelDivisor ?? LEVEL.divisor, classWeight: full.classWeight, costMargin: full.costMargin, decisiveMargin: full.decisiveMargin };
};

/** What the pre-call records with a reply's dice: the rules, difficulty numbers and practice in force now, and the party's bonus table. */
export function dicePayload(party, values, packRecords = null) {
    let pack = null;
    try { pack = packRulesOf(packRecords); } catch { /* no pack rules */ }
    const rules = rulesOf(rulesFromSettings(values, pack));
    return { rules, dc: { ...LIMITS.dc }, perUse: practiceOf(values?.rpgPracticePerUse) ?? PRACTICE.perUse, table: bonusTable(party, rules) };
}

/** A recorded set of dice, rules, difficulty numbers and practice, checked: { list, rules, dc, perUse } or null. */
export function diceOf(value) {
    if (!isObject(value) || !Array.isArray(value.list) || value.list.length !== CHECK_DICE_COUNT || !value.list.every(die => Number.isSafeInteger(die) && die >= 1 && die <= FORMULA.die)) return null;
    const rules = isObject(value.rules) ? value.rules : null, dc = isObject(value.dc) ? value.dc : null;
    if (!rules || !dc || !['costMargin', 'decisiveMargin', 'classWeight'].every(key => inRange(rules[key], 40)) || !(rules.levelDivisor === undefined || inRange(rules.levelDivisor, 8))) return null;
    if (!Object.keys(LIMITS.dc).every(key => inRange(dc[key], 60)) || practiceOf(value.perUse) === null) return null;
    return { list: [...value.list], rules: { ...(rules.levelDivisor ? { levelDivisor: rules.levelDivisor } : {}), classWeight: rules.classWeight, costMargin: rules.costMargin, decisiveMargin: rules.decisiveMargin },
        dc: Object.fromEntries(Object.keys(LIMITS.dc).map(key => [key, dc[key]])), perUse: value.perUse };
}

export const tableOf = value => (Array.isArray(value) ? value.slice(0, 8).filter(row => isObject(row) && typeof row.who === 'string' && row.who && Array.isArray(row.stats) && row.stats.length === STATS.length
    && row.stats.every(Number.isSafeInteger) && Array.isArray(row.skills)).map(row => ({ who: [...row.who].slice(0, 40).join(''), stats: [...row.stats],
    skills: row.skills.slice(0, 11).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1])).map(entry => [[...entry[0]].slice(0, 40).join(''), entry[1]]) })) : []);

/**
 * `rpg.dice { rules, dc, perUse, table }`: the prelude's handler. The dice come from the receipt's seed (a swipe draws anew, a Re-read keeps them); the rules and
 * the table are the payload's, recorded as they were when the reply was sent. The note is told from this record (cue.js), never stored as text.
 */
export function diceRecord(ctx, payload = {}) {
    if (ctx.cause !== 'system' || ctx.caller !== null) ctx.fail('REFUSED', 'The dice are rolled by Story Block before a reply, not by an action.');
    const list = replyDice(Math.floor(ctx.rng() * 4294967296) >>> 0);
    const kept = diceOf({ list, rules: payload?.rules, dc: payload?.dc, perUse: payload?.perUse }) ?? diceOf({ list, rules: rulesOf(null), dc: { ...LIMITS.dc }, perUse: PRACTICE.perUse });
    return { summary: '', narrate: false, replan: true, data: { v2: { dice: { v: 1, ...kept, table: tableOf(payload?.table) } } } };
}
