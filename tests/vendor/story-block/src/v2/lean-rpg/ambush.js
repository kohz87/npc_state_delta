// The ambush check (PRACTICE-FIX 4): a skill used before a fight to gain the drop on the foes (hiding, sneaking, luring, slipping behind them)
// is a plan `check` that carries `ambush`. Pure: the roll reads the check's own outcome.
//
// A successful ambush check gives the party's acts of round 1 an edge of +2 (inside the 3 an edge may reach), and under Standard the quick start: each
// character with an act against a foe gets the opening action without the lead the margin asks. A failed one (a cost counts as failed) gives nothing: no
// surprise. Without such a check there is no ambush edge: an act's own "+2 ambush" edge is dropped when the plan has none
// (plan.js). The check's skill earns practice through the existing path (it is one of the roll's checks).
import { FORMULA } from './names.js';

export const AMBUSH_EDGE = 2;

/** The ambush the roll's checks made: `{ who, skill, outcome, total, dc, success }`, or null when no check of the roll carries `ambush`. */
export function ambushOf(checks, drop = null, acts = true) {
    const line = (Array.isArray(checks) ? checks : []).find(item => item?.ambush === true);
    // With no act to strike with in this roll the check's line says the party has the drop (for the next reply), not that it strikes first.
    if (line && !acts) line.ambushDrop = true;
    if (!line) return drop && acts ? { ...drop, outcome: 'success', success: true, carried: true } : null;
    return { who: line.pc.who, skill: line.skill ?? null, outcome: line.outcome, total: line.pc.total, dc: line.dc, success: line.outcome === 'success' };
}

/**
 * The ambush a roll with no fight left for the next reply (A2): a successful ambush check made in a reply whose roll had no acts is spent once, on the very
 * next reply's roll that has acts. The pre-call reads it from the previous reply's receipt (`drop: true` in its `result.ambush`) into the payload, so a replay
 * rolls with what the payload recorded. → `{ who, skill, total, dc }` or null (a damaged value is no ambush).
 */
export function carriedFrom(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const { who, skill, total, dc } = value;
    if (typeof who !== 'string' || !who || who.length > 60 || !(skill === null || (typeof skill === 'string' && skill.length <= 60)) || !Number.isSafeInteger(total) || !Number.isSafeInteger(dc)) return null;
    return { who, skill, total, dc };
}
/** The drop a previous roll's record left (`result.ambush` of a reply with no fight in it), as `carriedFrom` takes it, or null. */
export function dropOf(result) {
    const ambush = result?.ambush;
    return ambush && ambush.success === true && ambush.drop === true && ambush.carried !== true ? carriedFrom({ who: ambush.who, skill: ambush.skill ?? null, total: ambush.total, dc: ambush.dc }) : null;
}

/**
 * The ambush part of a roll's result: `{ ambush }` or nothing. A roll with a fight tells it (a carried one is marked `spent`); a roll with no acts
 * to strike with and a successful ambush check keeps it as `drop: true` for the next reply (ambush.js carriedFrom), and its check line says the party has the drop.
 */
export function ambushRecord(ambush, _checks, fight) {
    if (!ambush) return {};
    if (fight.some(entry => entry.kind === 'act')) return { ambush: { ...ambush, ...(ambush.carried ? { spent: true } : {}) } };
    return { ambush: { ...ambush, ...(ambush.success ? { drop: true } : {}) } };
}

// Standard: the situation edge goes up and passes through LUK's window again (formula.js edgeWithLuck), from the window the side recorded.
const sideStd = pc => {
    const situation = Math.min(FORMULA.edgeMax, (pc.situation ?? 0) + AMBUSH_EDGE);
    const window = pc.window ?? { min: -3, max: 3 };
    return { ...pc, situation, edge: situation >= 3 ? window.max : Math.max(window.min, situation) };
};

/**
 * Standard: the act as it rolls in round 1 (or as its opening action) of an ambush that worked. A support action is not an attack and keeps its numbers;
 * `base` keeps the entry's place for its dice.
 */
export function ambushedStandard(entry, round, ambush) {
    if (!ambush?.success || round !== 1 || entry.kind !== 'act' || entry.support) return entry;
    return { ...entry, base: entry.base ?? entry, pc: sideStd(entry.pc), ...(entry.plain ? { plain: { ...entry.plain, pc: sideStd(entry.plain.pc) } } : {}) };
}
