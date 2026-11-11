// One narrator check line: "? roll Name | skill or stat | difficulty | die" parsed and checked against a reply's party and dice.
// Pure: names and aliases match a whole folded name only; a refused line carries one short reason and is never rolled.

import { ROLL_KIND, LIMITS, STATS } from '../names.js';
import { fold } from '../read.js';

const LINE = new RegExp(`^\\s*\\?\\s*${ROLL_KIND}(?:\\s+|$)(.*)$`, 'iu');
const DIE = /^\d+$/u;

const refusal = reason => ({ ok: false, reason });
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const difficultyOf = value => clean(value).toLowerCase().replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ');

/** Parse one line into { name, what, difficulty, die }, or a refusal. Syntax only; the party and dice are checked by validateCheck. */
export function parseCheckLine(line) {
    const match = LINE.exec(String(line ?? ''));
    if (!match) return refusal('not a check line');
    const parts = match[1].split('|').map(clean);
    if (parts.length !== 4 || parts.some(part => !part)) return refusal('needs four parts');
    const [name, what, difficulty, dieText] = parts;
    if (!DIE.test(dieText)) return refusal('die is not a whole number');
    const die = Number(dieText);
    if (!Number.isSafeInteger(die)) return refusal('die is not a whole number');
    return { ok: true, name, what, difficulty: difficultyOf(difficulty), die };
}

/** A whole name wins over aliases; a shared alias is ambiguous and names nobody. */
export function memberNamed(party, name) {
    const wanted = fold(clean(name));
    if (!wanted) return null;
    const members = Array.isArray(party) ? party : [];
    const named = members.filter(member => fold(member?.name) === wanted);
    if (named.length) return named.length === 1 ? named[0] : null;
    const aliases = members.filter(member => Array.isArray(member?.aliases) && member.aliases.some(alias => fold(alias) === wanted));
    return aliases.length === 1 ? aliases[0] : null;
}

/**
 * Validate a parsed check against { party, offeredDice, usedDice }.
 * → { ok, member, skill, stat (null for a skill with none), what, difficulty, dc, die, used } or { ok: false, reason }.
 */
export function validateCheck(parsed, { party = [], offeredDice = [], usedDice = [], dc = LIMITS.dc } = {}) {
    if (!parsed || parsed.ok !== true) return parsed?.ok === false ? parsed : refusal('not a check line');
    if ((Array.isArray(usedDice) ? usedDice : []).length >= 3) return refusal('more than 3');

    const difficulty = difficultyOf(parsed.difficulty);
    if (!Object.hasOwn(dc, difficulty)) return refusal('unknown difficulty');

    // A narrator who puts the action where the name goes still means the one person there is; with two or more people the line is refused.
    const member = memberNamed(party, parsed.name) ?? (Array.isArray(party) && party.length === 1 ? party[0] : null);
    if (!member) return refusal('unknown person');

    const what = clean(parsed.what);
    const skill = (Array.isArray(member.skills) ? member.skills : []).find(entry => fold(entry?.name) === fold(what)) ?? null;
    const plain = skill ? null : what.toLowerCase();
    // A skill from an older Skills block has no stored stat: it is worked out as the fight code does (formula.js statPart: no stat of its own, the type's main one).
    const skillStat = skill && STATS.includes(clean(skill.stat).toLowerCase()) ? clean(skill.stat).toLowerCase() : null;
    const stat = skill ? skillStat : (STATS.includes(plain) ? plain : null);
    if (!skill && !stat) return refusal('unknown skill or stat');

    const used = Array.isArray(usedDice) ? usedDice : [];
    const offered = Array.isArray(offeredDice) ? offeredDice : [];
    const die = parsed.die;
    if (!offered.includes(die)) return refusal('die not offered');
    if (used.filter(value => value === die).length >= offered.filter(value => value === die).length) return refusal('die reused');
    if (die !== offered[used.length]) return refusal('out of order');

    return { ok: true, member, skill, stat, what: skill?.name ?? stat.toUpperCase(), difficulty, dc: dc[difficulty], die, used: used.length };
}
