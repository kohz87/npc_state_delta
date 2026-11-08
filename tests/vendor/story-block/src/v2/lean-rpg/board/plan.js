// Turns one exchange of reader choices into an ordinary prepared fight plan.
// It validates the current sheet, skills and targets before automatic foe actions are added.
// It reads no DOM and writes no state; the board and the committed roll both use it.

import { fold } from '../read.js';
import { packAttacks } from './members.js';
import { bestDefence } from './rules.js';
import { healingSkill, skillFlags, skillKey } from './flags.js';

const find = (entries, name, field) => entries.find(entry => fold(entry[field]) === fold(name));
const standing = character => character.alive !== false && character.health !== 0;
const up = foe => foe.filled && foe.hurt > 0;
const groupOf = foe => (Number.isInteger(foe?.group) ? foe.group : foe?.slot);
const isEmpty = (name) => `${name} is Empty`;
const flagsFor = (flags, actor, skill) => flags?.[skillKey(actor.module, skill)];

/**
 * The skills usable for an action, with the resource reason when one is empty. `bars`: a fight with the doubled bars (setup.bars === 2), where an area skill costs
 * 2 of its resource: `areaReason` says so when only 1 is left (a single-target use of the same skill is still open).
 */
export function actionSkills(actor, flags = {}, { bars = false } = {}) {
    return (actor?.skills ?? []).flatMap(skill => {
        const scope = skillFlags(skill, flagsFor(flags, actor, skill));
        if (!scope.target && !scope.area) return [];
        const resource = skill.uses === 'mana' ? 'mana' : 'stamina';
        const name = resource === 'mana' ? 'Mana' : 'Stamina', reason = actor[resource] === 0 ? isEmpty(name) : '';
        return [{ skill, ...scope, reason, areaReason: reason || (bars && scope.area && actor[resource] === 1 ? `Not enough ${name} (an area skill costs 2)` : '') }];
    });
}

/** Build a Standard plan from one choice for each standing member, or one flee choice. */
// `aoe`: the newer area rule (setup.aoe === 1): an area skill hits every standing group, the picked group is its main target. `bars`: the doubled bars (setup.bars === 2): an area skill needs 2 of its resource.
export function exchangePlan(sheet, actions, flags = {}, number = 1, { members = false, aoe = false, bars = false } = {}) {
    const actors = (sheet?.characters ?? []).filter(standing), foes = (sheet?.foes ?? []).filter(up);
    if (!actors.length || !foes.length) return { error: 'The fight has already ended.' };
    const grouped = members;
    const fleeing = Array.isArray(actions) && actions.length === 1 && actions[0]?.kind === 'flee';
    if (!Array.isArray(actions) || !actions.length || actions.length > actors.length || (!fleeing && actions.length !== actors.length)) return { error: 'Choose an action for each standing member.' };
    const seen = new Set(), acts = [];
    let runner = null;
    for (const action of actions) {
        if (!action || typeof action !== 'object' || !['attack', 'skill', 'flee'].includes(action.kind)) return { error: 'That action is not available.' };
        const actor = find(actors, action.who, 'who');
        if (!actor || seen.has(actor.key)) return { error: 'That member cannot act twice.' };
        seen.add(actor.key);
        if (action.kind === 'flee') {
            if (!fleeing) return { error: 'Flee is the whole exchange.' };
            runner = actor;
            continue;
        }
        const skill = action.kind === 'skill' ? find(actor.skills, action.skill, 'name') : null;
        if (action.kind === 'skill' && !skill) return { error: 'That skill is no longer on the sheet.' };
        const scope = skill ? skillFlags(skill, flagsFor(flags, actor, skill)) : { target: true, area: false };
        const area = action.area === true;
        if (area ? !scope.area : !scope.target) return { error: 'That skill cannot be used on that target.' };
        const resource = skill?.uses === 'mana' ? 'mana' : 'stamina';
        if (skill && actor[resource] === 0) return { error: `${isEmpty(resource === 'mana' ? 'Mana' : 'Stamina')}.` };
        if (skill && area && bars && actor[resource] < 2) return { error: `Not enough ${resource === 'mana' ? 'Mana' : 'Stamina'} for an area skill (it costs 2).` };
        if (bars && action.support === true) {
            if (!skill || !healingSkill(skill) || area) return { error: 'That skill cannot heal a party member.' };
            const mate = find((sheet?.characters ?? []).filter(person => person.alive !== false), action.target, 'who');
            if (!mate) return { error: 'That party member is no longer here.' };
            acts.push({ who: actor.who, skill: skill.name, target: mate.who, type: skill.uses === 'mana' ? 'magic' : 'physical', support: true, difficulty: 'normal' });
            continue;
        }
        let target = null, group;
        if (area) {
            if (grouped) {
                const groups = [...new Set(foes.map(groupOf))];
                const chosen = Number.isInteger(action.group) ? action.group
                    : Number.isInteger(action.target) ? groupOf(foes.find(foe => foe.slot === action.target))
                        : groups.length === 1 ? groups[0] : null;
                if (!Number.isInteger(chosen)) return { error: 'Choose a group for that area skill.' };
                target = foes.find(foe => groupOf(foe) === chosen);
                group = chosen;
            } else target = foes[0];
        } else target = foes.find(foe => foe.slot === action.target);
        if (!target) return { error: 'That foe is no longer standing.' };
        acts.push({ who: actor.who, ...(skill ? { skill: skill.name } : {}), target: `foe${target.slot}`, type: skill?.uses === 'mana' ? 'magic' : 'physical',
            ...(area ? { area: true } : {}), ...(group !== undefined ? { group } : {}), ...(area && group !== undefined && aoe ? { aoe: true } : {}) });
    }
    // Every member attacks once and a pack attacks as its thinning bar allows. The flattened attacker index rotates targets.
    // A new-board defence is charged on its first executed attack, so Standard decides `paid` at the table, not here.
    const attackers = foes.flatMap(foe => Array.from({ length: foe.pack === true ? packAttacks(foe.count, foe.hurt, foe.size) : 1 }, () => foe));
    const guards = actors.map(target => {
        const skill = bestDefence(target, item => flagsFor(flags, target, item));
        return { target: target.who, ...(skill ? { skill: skill.name } : {}) };
    });
    const attacks = attackers.map((foe, at) => {
        const target = actors[(at + number - 1) % actors.length];
        const skill = bestDefence(target, item => flagsFor(flags, target, item));
        return { slot: foe.slot, target: target.who, ...(skill ? { skill: skill.name } : {}), ...(members ? { once: true } : {}) };
    });
    return { plan: { formula: 'standard', pace: 'careful', acts, foes: attacks, checks: [], ...(members ? { rotation: { number, targets: guards } } : {}) }, ...(runner ? { flee: runner } : {}) };
}
