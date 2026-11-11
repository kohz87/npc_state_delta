// The deterministic Auto-fight policy and its stop rule.
// Auto chooses ordinary board actions from the live sheet: weakest standing foe, a heal for someone below half Health,
// a better payable attack skill, or a plain attack. Defence is a hint for the board's automatic guard; Auto never flees.
// Pure: it reads no DOM, changes nothing and uses no clock or random source.

import { blocksFor, statPart } from '../formula.js';
import { applyGear } from '../gear.js';
import { FORMULA } from '../names.js';
import { readSheet } from '../read.js';
import { hasLevels } from '../rules.js';
import { prepareStandard } from '../standard.js';
import { judge } from '../standard/roll.js';
import { actionSkills, exchangePlan } from './plan.js';
import { attackStat, bestDefence } from './rules.js';
import { healingSkill, isUtility, skillFlags, skillKey } from './flags.js';
import { splitFoes } from './members.js';

const number = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const healthOf = actor => {
    const value = Number(actor?.health ?? actor?.hp ?? actor?.value);
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
};
const maxHealthOf = actor => {
    const explicit = Number(actor?.size?.health ?? actor?.healthSize ?? actor?.healthMax ?? actor?.maxHealth ?? (typeof actor?.size === 'number' ? actor.size : null));
    if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
    if (actor?.stats && typeof actor.stats === 'object') return blocksFor(actor.base ?? actor.stats, actor.scale).health;
    return null;
};
const belowHalf = actor => {
    const health = healthOf(actor), max = maxHealthOf(actor);
    return health !== null && max !== null && health * 2 < max;
};
const standingActor = actor => Boolean(actor) && actor.alive !== false && (healthOf(actor) ?? 1) > 0;
const foeValue = foe => number(foe?.value ?? foe?.hurt ?? foe?.health);
const standingFoe = foe => Boolean(foe) && foe.filled !== false && foe.standing !== false && foeValue(foe) > 0;
const resourceOf = skill => (skill?.uses === 'mana' ? 'mana' : 'stamina');
const canPay = (actor, skill) => Boolean(skill) && number(actor?.[resourceOf(skill)]) > 0;

// The sheet Auto reads: an explicit sheet or plain snapshot, else the board's state with its recorded gear.
function sheetOf(boardState, setup) {
    if (boardState?.sheet) return boardState.sheet;
    if (Array.isArray(boardState?.characters) || Array.isArray(boardState?.actors)) {
        return { characters: boardState.characters ?? boardState.actors ?? [], foes: boardState.foes ?? [] };
    }
    return applyGear(readSheet(boardState?.state ?? boardState), setup?.gear);
}

// Current virtual bars keep their real group's class and level for the odds.
function membersOf(boardState, setup, sheet) {
    const explicit = Array.isArray(boardState?.members) ? boardState.members : null;
    const bars = explicit ?? (setup?.members === 1 ? splitFoes(sheet.foes, { carried: setup.carriedMembers, six: setup.foesSix === 1 }) : []);
    if (!bars.length) return null;
    const real = new Map(sheet.foes.map(foe => [Number(foe.group ?? foe.slot), foe]));
    return bars.map(member => {
        const group = Number(member.group ?? member.slot), base = real.get(group) ?? real.get(Number(member.slot)) ?? {};
        return { ...base, ...member, value: foeValue(member), hurt: foeValue(member), filled: true,
            ...(member.class === undefined && base.class !== undefined ? { class: base.class } : {}),
            ...(member.level === undefined && base.level !== undefined ? { level: base.level } : {}) };
    });
}

function weakest(foes) {
    const standing = foes.filter(standingFoe).sort((a, b) => foeValue(a) - foeValue(b) || Number(a.slot) - Number(b.slot));
    return standing[0] ?? null;
}

function healTarget(characters) {
    const hurt = characters.filter(actor => actor?.alive !== false && belowHalf(actor))
        .sort((a, b) => (healthOf(a) ?? 0) - (healthOf(b) ?? 0));
    return hurt[0] ?? null;
}

// The prepared side of one action, built by the board's own action and Standard preparation code.
function attackEntry(sheet, actor, foe, action, flags, exchangeNumber, members, rules, bars = false) {
    const one = { ...sheet, characters: [actor], foes: [foe] };
    const built = exchangePlan(one, [action], flags, exchangeNumber, { members, bars });
    if (built.error) return null;
    const prepared = prepareStandard(built.plan, one, rules, { lv: hasLevels(rules), fix: true, then: true });
    return prepared.acts[0] ?? null;
}

// The action's landed odds, using the Standard judge. A plain attack uses the board's weapon stat.
function oddsOf(entry, actor, weapon, rules, plain = false) {
    if (!entry?.pc || !entry?.foe) return -1;
    const pc = plain ? (() => {
        const part = statPart('physical', actor.stats, { skillStat: attackStat(actor, weapon) });
        return { ...entry.pc, stat: part.main, second: part.second, statBonus: part.value };
    })() : entry.pc;
    const bonus = number(pc.statBonus) + number(pc.classBonus) + number(pc.rank) + number(pc.edge);
    const against = number(entry.foe.base) + number(entry.foe.classBonus);
    let wins = 0;
    for (let mine = 1; mine <= FORMULA.die; mine += 1) {
        for (let theirs = 1; theirs <= FORMULA.die; theirs += 1) {
            if (judge(mine, mine + bonus, theirs, theirs + against, rules).pcWins) wins += 1;
        }
    }
    return wins;
}

function attackChoice(actor, foe, skill = null, area = false, group = null) {
    return { who: actor.who, kind: skill ? 'skill' : 'attack', ...(skill ? { skill: skill.name } : {}),
        target: foe.slot, ...(area ? { area: true } : {}), ...(area && Number.isInteger(group) ? { group } : {}) };
}

/**
 * Auto's action for every standing actor in sheet order.
 * `boardState` is `{ state, setup?, sheet?, members?, number? }` (or the state itself, or `{ characters, foes }`).
 * `setup` is the board setup (`flags`, `weapons`, `gear`, `members`, `carriedMembers`); `members` are current virtual bars.
 * The result is the `actions` array `stageExchange` takes. Heals carry `support: true` and `difficulty: 'normal'`;
 * a below-half actor with a usable defence skill carries `defence: '<skill name>'`. Auto never returns a flee action.
 */
export function autoPicks(boardState, rules) {
    const setup = boardState?.setup ?? {}, flags = setup.flags ?? {};
    const sheet = sheetOf(boardState, setup);
    const characters = sheet.characters ?? [];
    const members = membersOf(boardState, setup, sheet);
    const foes = members ?? (sheet.foes ?? []);
    const target = weakest(foes);
    const actors = characters.filter(standingActor);
    const exchangeNumber = Number.isInteger(boardState?.number) ? boardState.number : (Number(setup.offset) + 1 || 1);
    const out = [], bars = setup.bars === 2;
    if (!target) return out;
    const guard = actor => {
        if (!belowHalf(actor)) return {};
        const skill = bestDefence(actor, item => flags[skillKey(actor.module, item)]);
        return skill ? { defence: skill.name } : {};
    };
    for (const actor of actors) {
        const healer = (actor.skills ?? []).find(skill => !isUtility(skill) && healingSkill(skill) && canPay(actor, skill)
            && (!bars || skillFlags(skill, flags[skillKey(actor.module, skill)]).target));
        const mate = healer ? healTarget(characters) : null;
        if (healer && mate) {
            out.push({ who: actor.who, kind: 'skill', skill: healer.name, target: mate.who, support: true,
                difficulty: healer.difficulty ?? 'normal', ...guard(actor) });
            continue;
        }
        const plainAction = attackChoice(actor, target);
        const plainEntry = attackEntry(sheet, actor, target, plainAction, flags, exchangeNumber, Boolean(members), rules, bars);
        const plainOdds = oddsOf(plainEntry, actor, setup.weapons?.[actor.key], rules, true);
        let best = null;
        for (const option of actionSkills(actor, flags, { bars })) {
            if (option.reason || healingSkill(option.skill)) continue;
            const scope = skillFlags(option.skill, flags[skillKey(actor.module, option.skill)]);
            if (!scope.target && !scope.area) continue;
            // (an area use the actor cannot pay for, 2 in a fight with the doubled bars, is never picked)
            for (const area of [scope.target ? false : null, scope.area && !option.areaReason ? true : null].filter(value => value !== null)) {
                const action = attackChoice(actor, target, option.skill, area, members ? target.group : null);
                const entry = attackEntry(sheet, actor, target, action, flags, exchangeNumber, Boolean(members), rules, bars);
                const odds = oddsOf(entry, actor, null, rules);
                if (odds > plainOdds && (!best || odds > best.odds)) best = { action, odds };
            }
        }
        out.push({ ...(best?.action ?? plainAction), ...guard(actor) });
    }
    return out;
}

// The heroes the last exchange hurt badly (names; the id when a line has none): 2 or more Health blocks, or in a fight with the doubled bars (`result.bars`) a fifth of the bar.
export function hurtHeroes(result) {
    const rounds = Array.isArray(result?.rounds) ? result.rounds : (Array.isArray(result) ? result : []);
    const last = rounds.at(-1);
    const lines = last?.lines ?? result?.lines ?? [];
    const lost = new Map(), names = new Map(), sizes = new Map();
    for (const line of lines) {
        const damage = line?.damage;
        if (!damage) continue;
        const id = String(damage.id ?? '');
        if (!((damage.kind === 'char' || id.startsWith('c:')) && /^c:[^:]+$/u.test(id))) continue;
        const blocks = Number.isFinite(Number(damage.blocks)) ? Number(damage.blocks) : number(damage.from) - number(damage.to);
        lost.set(id, (lost.get(id) ?? 0) + Math.max(0, blocks));
        if (Number.isFinite(Number(damage.size))) sizes.set(id, Number(damage.size));
        if (line?.pc?.who && !names.has(id)) names.set(id, line.pc.who);
    }
    return [...lost].filter(([id, blocks]) => (result?.bars === 2 && sizes.has(id) ? blocks * 5 >= sizes.get(id) : blocks >= 2)).map(([id]) => names.get(id) ?? id);
}
const badlyHurt = result => hurtHeroes(result).length > 0;

/**
 * After an exchange: `won`/`lost` first, then `hurt` (a hero lost 2+ Health blocks in the last exchange),
 * then `cap` once `done` exchanges have run. `done` may be a count or a list of exchanges. Otherwise null.
 */
export function autoStop(result, { cap, done } = {}) {
    if (result?.stop === 'won') return 'won';
    if (result?.stop === 'lost') return 'lost';
    if (badlyHurt(result)) return 'hurt';
    const completed = Array.isArray(done) ? done.length : Number.isFinite(Number(done)) ? Number(done)
        : Array.isArray(result?.rounds) ? result.rounds.length : 0;
    return Number.isFinite(Number(cap)) && Number(cap) > 0 && completed >= Number(cap) ? 'cap' : null;
}
