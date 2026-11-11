// Builds the board's numbered action and target lines from its staged sheet.
// It reads skill flags and current bars; the view only renders the returned plain data.
// Unusable skills stay visible with a reason and cannot be chosen.

import { PRACTICE, PRACTICE_SETTING, STAGES, practiceOf, stageWord } from '../names.js';
import { fold, readSheet } from '../read.js';
import { applyGear } from '../gear.js';
import { fightOf, memberLevel, memberXp } from '../fight.js';
import { scaleXp, xpRateFrom } from '../levels.js';
import { usesOf } from '../practice.js';
import { actionSkills } from './plan.js';
import { areaGroupName, memberBaseName, memberOrderEntries, pluralName } from './order.js';
import { attackStat, bestDefence } from './rules.js';
import { healingSkill, skillKey } from './flags.js';
import { stageTone } from '../view/party-data.js';

export function boardChoices(state, setup, chosen = [], memberGroupList = null) {
    const sheet = applyGear(readSheet(state), setup?.gear), actors = sheet.characters.filter(actor => actor.alive !== false && actor.health !== 0);
    const actor = actors.find(entry => !chosen.some(action => action.who === entry.who));
    const foes = sheet.foes.filter(foe => foe.filled && foe.hurt > 0);
    if (!actor) return { sheet, actors, foes, actor: null, choices: [] };
    const weapon = setup?.weapons?.[actor.key], stat = attackStat(actor, weapon).toUpperCase();
    const bars = setup?.bars === 2, paid = area => (area && bars ? 2 : 1);   // what plan.js and the roll charge: 1 of the resource, 2 for an area skill in a doubled-bars fight
    const choices = [{ label: `Attack${weapon?.name ? ` with ${weapon.name}` : ''} (${stat})`, view: { name: `Attack${weapon?.name ? ` with ${weapon.name}` : ''}`, stat }, action: { who: actor.who, kind: 'attack' } }];
    const areaLabel = Array.isArray(memberGroupList) && memberGroupList.length > 1 ? (setup?.aoe === 1 ? ' — every group' : ' — one group') : ' — every foe';
    for (const { skill, target, area, reason, areaReason } of actionSkills(actor, setup?.flags, { bars })) {
        const detail = [skill.stat?.toUpperCase(), skill.uses === 'mana' ? 'Mana' : 'Stamina'].filter(Boolean).join(', ');
        const base = `${skill.name}${skill.about ? `: ${skill.about}` : ''} (${detail})`;
        if (setup?.bars === 2 && healingSkill(skill) && target) {
            for (const mate of sheet.characters.filter(person => person.alive !== false)) choices.push({ label: `${base} — heal ${mate.who}`, reason, view: { name: `${skill.name} → ${mate.who}`, stat: skill.stat, uses: skill.uses, cost: paid(false), about: skill.about }, action: { who: actor.who, kind: 'skill', skill: skill.name, target: mate.who, support: true } });
            continue;
        }
        if (target) choices.push({ label: `${base}${area ? ' — one foe' : ''}`, reason, view: { name: `${skill.name}${area ? ' · one foe' : ''}`, stat: skill.stat, uses: skill.uses, cost: paid(false), about: skill.about }, action: { who: actor.who, kind: 'skill', skill: skill.name } });
        if (area) choices.push({ label: `${base}${areaLabel}`, reason: areaReason, view: { name: skill.name, stat: skill.stat, uses: skill.uses, cost: paid(true), area: true, about: skill.about }, action: { who: actor.who, kind: 'skill', skill: skill.name, area: true } });
    }
    choices.push({ label: 'Flee', view: { name: 'Flee' }, action: { who: actor.who, kind: 'flee' } });
    const defence = bestDefence(actor, skill => setup?.flags?.[skillKey(actor.module, skill)]);
    return { sheet, actors, foes, actor, choices, defence: defence?.name ?? null, resources: resourcesOf(actor) };
}

/** The choosing member's Mana and Stamina as `{ value, max }` (blocks left, blocks in the bar); a bar of no size is null (no Mana: Stamina only). Null when the sheet has no block sizes. */
export function resourcesOf(actor) {
    const size = actor?.size;
    if (!size) return null;
    const pick = key => (Number.isFinite(size[key]) && size[key] > 0 ? { value: Math.max(0, Number(actor[key]) || 0), max: size[key] } : null);
    return { mana: pick('mana'), stamina: pick('stamina') };
}

export function targetLabel(foe) {
    const size = foe.size ?? 5, health = stageWord(STAGES.health, foe.hurt, size);
    return `${foe.name} (Lv ${foe.level}, ${health})`;
}

const memberValue = member => {
    const value = Number(member?.value ?? member?.hurt);
    return Number.isFinite(value) ? Math.trunc(value) : 0;
};

/** The members still standing, in board order. */
export const standingMembers = members => (Array.isArray(members) ? members : [])
    .filter(member => member?.standing !== false && memberValue(member) > 0);

/** A member's or pack's health word over its own bar ("Unhurt", "Hurt", "Down"). */
export function memberHealthWord(member) {
    const size = Math.max(1, Math.trunc(Number(member?.size) || 1));
    return stageWord(STAGES.health, memberValue(member), size);
}

/** A numbered target line in the board's own wording: "1. Bristle-boar 1  Unhurt". */
export const memberTargetLine = (member, number) => `${number}. ${member?.name ?? ''}  ${memberHealthWord(member)}`;

/** A pack's thinning line: "About 8 left · 2 attacks each exchange". */
export function memberPackLine(member) {
    const left = Math.max(0, Math.trunc(Number(member?.left) || 0));
    const attacks = Math.max(0, Math.trunc(Number(member?.attacks) || 0));
    return `About ${left} left · ${attacks} ${attacks === 1 ? 'attack' : 'attacks'} each exchange`;
}

/** The standing real-slot groups, each with the display name an area asks for. */
export function memberGroups(members, realFoes = [], { aoe = false } = {}) {
    const list = standingMembers(members), out = [], seen = new Set();
    for (const member of list) {
        const group = Number(member?.group);
        if (!Number.isFinite(group) || seen.has(group)) continue;
        seen.add(group);
        const real = (Array.isArray(realFoes) ? realFoes : []).find(foe => Number(foe?.slot) === group);
        out.push({ group, label: aoe && real ? areaGroupName(real) : pluralName(memberBaseName(member, real)), members: list.filter(item => Number(item?.group) === group) });
    }
    return out;
}

/**
 * The member fight's turn-order sentence: one entry per rolled group (its member numbers in brackets), then the attacks
 * the reader faces each exchange. Down members remain in the group's shared roll; only standing members attack.
 */
export function memberOrderLine(order, members, realFoes = []) {
    const list = standingMembers(members);
    const parts = memberOrderEntries(order, members, realFoes).map(item => item.name).filter(Boolean);
    const attacks = list.reduce((sum, member) => sum + Math.max(0, Math.trunc(Number(member?.attacks) || 0)), 0);
    if (attacks) parts.push(`${attacks} ${attacks === 1 ? 'attack' : 'attacks'} on you each exchange`);
    return parts.length ? `Order: ${parts.join(' · ')}` : '';
}

/** Awards for the unsent segment; earlier segments have already paid their own practice. */
export function pendingAwards(state, session, result, settings = {}) {
    const sheet = readSheet(state), fight = fightOf(sheet, session.groups ?? []);
    const rate = xpRateFrom(settings), perUse = practiceOf(session.setup?.opening?.payload?.practice) ?? practiceOf(settings[PRACTICE_SETTING]) ?? PRACTICE.perUse;
    const xp = result.stop === 'won' && fight.won ? sheet.characters.filter(actor => actor.alive !== false && Number.isSafeInteger(actor.xp))
        .map(actor => ({ who: actor.who, amount: scaleXp(memberXp(fight.groups, memberLevel(actor), session.setup?.bars === 2, session.setup?.bars === 2), rate) })) : [];
    const practice = usesOf(result).filter(use => {
        const actor = sheet.characters.find(entry => entry.key === fold(use.who));
        return actor?.skills.some(skill => fold(skill.name) === fold(use.skill));
    }).map(use => ({ who: use.who, skill: use.skill, amount: Math.min(PRACTICE.max, use.n * perUse) }));
    return { xp, practice };
}

/** Compact phone wording; keep the owner on practice when it could otherwise be ambiguous. */
export function pendingAwardsLine({ xp = [], practice = [] } = {}) {
    const earned = xp.filter(item => item.amount > 0);
    const owners = new Set(earned.map(item => item.who));
    const oneOwner = owners.size === 1 && practice.every(item => owners.has(item.who));
    const parts = [
        ...earned.map(item => `${item.who} +${item.amount} XP`),
        ...practice.map(item => `${oneOwner ? '' : `${item.who}: `}${item.skill} +${item.amount}`),
    ];
    return `Pending: ${parts.join(' · ') || 'none'}`;
}

const sumOf = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const whole = value => Math.max(0, Math.trunc(Number(value)) || 0);

/** The foe groups as chips: one per real slot (a Down group stays, dimmed), "×N" the foes standing (a pack: about how many are left), Health the blocks left over the blocks in its bars. */
export function foeChips(members, realFoes = []) {
    const groups = new Map();
    for (const member of Array.isArray(members) ? members : []) {
        const group = Number(member?.group ?? member?.slot);
        if (Number.isFinite(group)) groups.set(group, [...(groups.get(group) ?? []), member]);
    }
    return [...groups].map(([group, list]) => {
        const real = (Array.isArray(realFoes) ? realFoes : []).find(foe => Number(foe?.slot) === group), up = standingMembers(list);
        const max = sumOf(list, member => Math.max(1, whole(member?.size))), value = Math.min(max, sumOf(list, memberValue));
        return { group, name: memberBaseName(list[0], real), level: real?.level, count: sumOf(up, member => (member?.pack ? whole(member.left) : 1)) || list.length, value, max, tone: stageTone(value, max) };
    });
}

/** The party as chips: name, level and Health blocks over its bar. */
export const partyChips = party => (Array.isArray(party) ? party : []).map(character => {
    const bar = character?.bars?.health ?? {}, max = whole(bar.max), value = Math.min(max, whole(bar.value));
    return { name: character?.name ?? '', level: character?.level, value, max, tone: stageTone(value, max) };
});

/** A group as a target button: its label ("1. Ridge hounds ×4") and Health. `group` carries the standing members. */
export function groupTarget(group, at) {
    const up = group.members, max = sumOf(up, member => Math.max(1, whole(member?.size))), value = Math.min(max, sumOf(up, memberValue));
    const count = sumOf(up, member => (member?.pack ? whole(member.left) : 1));
    return { label: `${at + 1}. ${group.label}${count > 1 ? ` ×${count}` : ''}`, value, max, tone: stageTone(value, max) };
}

/** The staged line for one chosen action: "Astra · Flash" for an area skill, "Astra · Cut → Bristle-boar 2" for one foe. */
export function stagedLine(action, targetName = '') {
    const what = action.kind === 'attack' ? 'Attack' : action.kind === 'flee' ? 'Flee' : action.skill ?? '';
    return `${action.who} · ${what}${!action.area && targetName ? ` → ${targetName}` : ''}`;
}
