// The result of one validated story check: d20 + stat part + the level (or class) term + rank, against the difficulty number, with the margins recorded with the
// reply's dice (success, success at a cost, fail; decisive as in fights). `workChecks` runs a reply's lines in order; `bonusTable` is what the narrator is told
// beforehand (the same numbers, for every stat and skill). A skilled check gives its skill one practice use; checks never give XP. Pure: the rules come in.

import { statPart } from '../formula.js';
import { FORMULA, LIMITS, PARTY_MAX, RANK_NAMES, STATS } from '../names.js';
import { classTerm, STANDARD } from '../rules.js';
import { fold } from '../read.js';
import { outcomeOf } from '../resolve/dice.js';
import { parseCheckLine, validateCheck } from './line.js';

const whole = value => (Number.isInteger(value) ? value : null);
const statOrNull = value => (STATS.includes(String(value ?? '').trim().toLowerCase()) ? String(value).trim().toLowerCase() : null);
const cut = value => [...String(value ?? '')].slice(0, 40).join('');

/** The level (or class) term a check adds, when the member carries the numbers it needs. */
function classBonusOf(member, rules) {
    if (Number.isInteger(rules?.levelDivisor)) return Number.isInteger(member?.level) ? classTerm(rules, member).classBonus : 0;
    return Number.isInteger(member?.soul) ? classTerm(rules, member).classBonus : 0;
}

/** The stat part of a check: a skill's own stat (a skill with none: the type's main stat, as the fight code does) or the plain stat the story named. */
const partOf = (member, skill, stat) => statPart('check', member.stats, skill ? { skillStat: statOrNull(skill.stat) } : { fittingStat: stat });

/** The bonus code adds to the die, for every stat and skill of each party member: [{ who, stats: [7 numbers in STATS order], skills: [[name, bonus]] }]. */
export function bonusTable(party, rules = STANDARD) {
    const numbers = { ...STANDARD, ...(rules && typeof rules === 'object' ? rules : {}) };
    return (Array.isArray(party) ? party : []).slice(0, PARTY_MAX).map(member => {
        const level = classBonusOf(member, numbers);
        return { who: cut(member.name), stats: STATS.map(stat => partOf(member, null, stat).value + level),
            skills: (Array.isArray(member.skills) ? member.skills : []).slice(0, 11).map(skill => [cut(skill.name), partOf(member, skill, null).value + level + (whole(skill.rank) ?? 0)]) };
    });
}

// What the note's table showed for this check: { bonus } (the number it told), or { bonus: 0, unlisted: 'member' | 'skill' } when the table had no such member or skill.
function shownBonus(table, member, skill, stat) {
    const row = table.find(entry => fold(entry.who) === fold(cut(member.name)));
    if (!row) return { bonus: 0, unlisted: 'member' };
    const found = skill ? row.skills.find(entry => fold(entry[0]) === fold(cut(skill.name))) : [null, row.stats[STATS.indexOf(stat)]];
    return Number.isInteger(found?.[1]) ? { bonus: found[1] } : { bonus: 0, unlisted: 'skill' };
}

/**
 * A validated check (`validateCheck`), its die (the same one) and the rules recorded with the dice.
 * → { who, member, skill, stat, what, difficulty, dc, die, statBonus, classBonus, rank, bonus, total, outcome, decisive, practice }.
 */
export function resolveCheck(check, die, rules = STANDARD, table = null) {
    const numbers = { ...STANDARD, ...(rules && typeof rules === 'object' ? rules : {}) };
    const member = check.member;
    const skill = check.skill ?? null;
    const part = partOf(member, skill, check.stat);
    const classBonus = classBonusOf(member, numbers);
    const rank = whole(skill?.rank) ?? 0;
    // A reply with the note's table (`table` an array) is worked at the bonuses the note showed; someone or a skill it did not show rolls with no bonus.
    const shown = table ? shownBonus(table, member, skill, part.main) : null;
    const bonus = shown ? shown.bonus : part.value + classBonus + rank;
    const total = die + bonus;
    const outcome = outcomeOf(die, total, check.dc, numbers);
    const decisive = outcome !== 'fail' && (die === FORMULA.die || total - check.dc >= (numbers.decisiveMargin ?? LIMITS.decisiveMargin));
    return {
        who: member.name, member, skill, stat: part.main, what: skill?.name ?? part.main.toUpperCase(), difficulty: check.difficulty, dc: check.dc,
        die, statBonus: part.value, classBonus, rank, rankName: RANK_NAMES[rank] ?? `Rank ${rank}`, bonus,
        total, outcome, decisive, utility: skill?.type === 'utility', ...(shown?.unlisted ? { unlisted: shown.unlisted } : {}),
        practice: skill ? { who: member.name, skill: skill.name, n: 1 } : null,
    };
}

// A result as the record keeps it: plain numbers and words only (no member or skill objects).
function keptResult(result, perUse) {
    return { who: result.who, what: result.what, stat: result.stat, utility: result.utility === true, rank: result.rank, rankName: result.rankName, difficulty: result.difficulty, dc: result.dc,
        die: result.die, bonus: result.bonus, total: result.total, outcome: result.outcome, decisive: result.decisive === true,
        ...(result.unlisted ? { unlisted: result.unlisted } : {}),
        ...(result.practice ? { practice: { skill: result.practice.skill, n: 1 }, practiceGained: perUse } : {}) };
}

/**
 * A reply's check lines worked in order against `party`, with `dice` = { list, rules, dc, perUse } as recorded with the reply (null: none was offered)
 * and `table` the note's bonus table when the reply was worked by it (null: the sheet's bonuses, as older replies were).
 * → { results (kept records), notes (one reason for each refused line), uses (practice: [{ who, skill, n }]) }.
 */
export function workChecks(party, lines, dice, table = null) {
    const results = [], notes = [], used = [], count = new Map();
    for (const raw of lines) {
        const check = dice ? validateCheck(parseCheckLine(raw), { party, offeredDice: dice.list, usedDice: used, dc: dice.dc }) : { ok: false, reason: 'no dice were offered this reply' };
        if (!check.ok) { notes.push(`"${raw}" was not used: ${check.reason}.`); continue; }
        used.push(check.die);
        const done = resolveCheck(check, check.die, dice.rules, table);
        if (done.unlisted) notes.push(`${done.who} rolled ${done.what} with no bonus: ${done.unlisted === 'member' ? 'they were' : 'it was'} not in the table the note showed.`);
        results.push(keptResult(done, dice.perUse));
        if (!done.practice) continue;
        const key = `${fold(done.who)}\u0000${fold(done.practice.skill)}`;
        const found = count.get(key) ?? { who: done.who, skill: done.practice.skill, n: 0 };
        found.n += 1;
        count.set(key, found);
    }
    const uses = [...count.values()].sort((a, b) => fold(a.who).localeCompare(fold(b.who)) || fold(a.skill).localeCompare(fold(b.skill)));
    return { results, notes, uses };
}
