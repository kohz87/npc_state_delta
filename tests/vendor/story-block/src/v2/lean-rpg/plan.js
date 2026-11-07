// The plan (SPEC_RPG §2 A2): what the retired pre-call answered, as plain data the roll reads. Old chats keep their plans in the record; nothing makes one now.
//
//   { pace: 'careful' | 'normal' | 'all',
//     acts:   [{ who, skill?, then?, else?, uses?, stat?, target, edge?, why? }],  `then`: the skill rounds 2 on use (mark 3); `else`: the skill to use when the current one's resource is spent (Standard)  a party member's action against a foe
//     foes:   [{ slot, target, defend, skill? } | { slot, hold: true }],  what a foe slot does (a number 1–4); `skill`: the
//                                                                         defender's skill that counts when they defend
//     checks: [{ who, skill?, uses?, stat?, difficulty, ambush? }] }  a roll outside a fight; `ambush`: a skill used to set up the fight (ambush.js)
//
// A skill the character has brings its own stat and resource (the Skills block's `statN` and `usesN`): an act or check
// that names one carries no `stat` or `uses` of its own, and any it does carry are not read. `stat` is for an act with no
// skill (or one the character lacks, rolled untrained) and is then required.
//
// A plan made for the Standard formula (`formula: 'standard'` at its root) also carries what the roll type needs (formula.js ROLL_TYPES):
//     acts:   + type ('physical' | 'magic' | 'social' | 'check'), fit (a check's fitting stat), area: true (hits every foe), support: true
//             with a difficulty (a heal or a buff: `target` is then an ally); `stat` is no longer asked for
//     foes:   + againstMagic: true (the attack is a spell, so the defender wards); `defend` is no longer asked for
//     checks: + type ('social' | 'check'), fit; `stat` is no longer asked for
// A plan with none of these keys is read as before (an old record).
//
// `validatePlan` is the one place its shape is checked (the pieces never trust a plan without it, and the replay guard asks it).
import { FOE_SLOTS, FORMULA, LIMITS, PACE, STATS, USES } from './names.js';
import { matchCharacter, matchFoe, matchSkill } from './read.js';
import { ROLL_TYPES } from './formula.js';
import { openErrors } from './open.js';

/** The roll types a plan may name for an action (a defence is never planned: a foe's attack makes it). */
const PLAN_TYPES = Object.freeze(ROLL_TYPES.filter(type => type !== 'defence'));

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const TEXT = 60;
// A slot number counts on across the chat's Foes blocks (read.js): four a block, and a chat holds at most sixteen blocks.
const MAX_FOE_SLOT = FOE_SLOTS * 16;
const DIFFICULTIES = Object.freeze(Object.keys(LIMITS.dc));

const oneLine = (value, max = TEXT) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The shape of a plan: { ok, errors } (plain sentences). */
export function validatePlan(plan) {
    const errors = [];
    if (!isObject(plan)) return { ok: false, errors: ['A plan must be an object.'] };
    if (plan.formula !== undefined && plan.formula !== 'standard') errors.push('formula must be standard when a plan has one.');
    const std = plan.formula === 'standard';
    if (plan.open !== undefined) errors.push(...openErrors(plan.open));
    if (!Object.hasOwn(PACE, plan.pace)) errors.push('pace must be careful, normal or all.');
    const lists = [['acts', LIMITS.acts], ['foes', LIMITS.foes], ['checks', LIMITS.checks]];
    for (const [key, max] of lists) {
        if (plan[key] === undefined) continue;
        if (!Array.isArray(plan[key])) { errors.push(`${key} must be a list.`); continue; }
        if (plan[key].length > max) errors.push(`${key} may hold at most ${max} entries.`);
    }
    const text = (entry, key, where, required = true) => {
        const value = entry[key];
        if (value === undefined && !required) return;
        if (typeof value !== 'string' || !value.trim() || value.length > TEXT) errors.push(`${where} needs ${key} (text, at most ${TEXT} characters).`);
    };
    const stat = (entry, key, where, required = true) => {
        if (entry[key] === undefined && !required) return;
        if (!STATS.includes(entry[key])) errors.push(`${where} needs ${key} to be one of ${STATS.join(', ')}.`);
    };
    const known = (entry, allowed, where) => {
        for (const key of Object.keys(entry)) if (!allowed.includes(key)) errors.push(`${where} has "${key}", which a plan does not use.`);
    };
    (Array.isArray(plan.acts) ? plan.acts : []).forEach((act, n) => {
        const where = `act ${n + 1}`;
        if (!isObject(act)) { errors.push(`${where} must be an object.`); return; }
        known(act, ['who', 'skill', 'then', 'else', 'uses', 'stat', 'target', 'edge', 'why', ...(std ? ['type', 'fit', 'area', 'support', 'difficulty'] : [])], where);
        text(act, 'who', where); text(act, 'skill', where, false); text(act, 'then', where, false); text(act, 'else', where, false); text(act, 'target', where); text(act, 'why', where, false);
        stat(act, 'stat', where, !std && act.skill === undefined);
        if (std) {
            if (act.type !== undefined && !PLAN_TYPES.includes(act.type)) errors.push(`${where} type must be one of ${PLAN_TYPES.join(', ')}.`);
            stat(act, 'fit', where, false);
            for (const flag of ['area', 'support']) if (act[flag] !== undefined && act[flag] !== true) errors.push(`${where} ${flag} must be true.`);
            if (act.support === true && !DIFFICULTIES.includes(act.difficulty)) errors.push(`${where} needs difficulty to be one of ${DIFFICULTIES.join(', ')}.`);
            if (act.support !== true && act.difficulty !== undefined) errors.push(`${where} has "difficulty", which only a support action uses.`);
            if (act.support === true && act.area === true) errors.push(`${where} cannot be both support and area.`);
        }
        if (act.uses !== undefined && !USES.includes(act.uses)) errors.push(`${where} uses must be mana or stamina.`);
        if (act.edge !== undefined && !(Number.isInteger(act.edge) && Math.abs(act.edge) <= FORMULA.edgeMax)) errors.push(`${where} edge must be a whole number from -${FORMULA.edgeMax} to ${FORMULA.edgeMax}.`);
    });
    (Array.isArray(plan.foes) ? plan.foes : []).forEach((foe, n) => {
        const where = `foe ${n + 1}`;
        if (!isObject(foe)) { errors.push(`${where} must be an object.`); return; }
        if (!Number.isInteger(foe.slot) || foe.slot < 1 || foe.slot > MAX_FOE_SLOT) errors.push(`${where} needs a slot from 1 to ${MAX_FOE_SLOT}.`);
        if (foe.hold !== undefined) {
            known(foe, ['slot', 'hold'], where);
            if (foe.hold !== true) errors.push(`${where} hold must be true.`);
            return;
        }
        known(foe, ['slot', 'target', 'defend', 'skill', ...(std ? ['againstMagic'] : [])], where);
        text(foe, 'target', where); text(foe, 'skill', where, false);
        stat(foe, 'defend', where, !std);
        if (std && foe.againstMagic !== undefined && foe.againstMagic !== true) errors.push(`${where} againstMagic must be true.`);
    });
    (Array.isArray(plan.checks) ? plan.checks : []).forEach((check, n) => {
        const where = `check ${n + 1}`;
        if (!isObject(check)) { errors.push(`${where} must be an object.`); return; }
        known(check, ['who', 'skill', 'uses', 'stat', 'difficulty', 'ambush', ...(std ? ['type', 'fit'] : [])], where);
        if (check.ambush !== undefined && check.ambush !== true) errors.push(`${where} ambush must be true.`);
        text(check, 'who', where); text(check, 'skill', where, false);
        stat(check, 'stat', where, !std && check.skill === undefined);
        if (std) {
            if (check.type !== undefined && !['social', 'check'].includes(check.type)) errors.push(`${where} type must be social or check.`);
            stat(check, 'fit', where, false);
        }
        if (!DIFFICULTIES.includes(check.difficulty)) errors.push(`${where} needs difficulty to be one of ${DIFFICULTIES.join(', ')}.`);
        if (check.uses !== undefined && !USES.includes(check.uses)) errors.push(`${where} uses must be mana or stamina.`);
    });
    return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/** Whether a plan has anything to roll. */
export const planIsEmpty = plan => !(plan?.acts?.length || plan?.checks?.length || plan?.foes?.some(foe => !foe.hold));
