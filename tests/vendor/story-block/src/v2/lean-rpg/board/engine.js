// Plays a sequence of board exchanges on a private copy of the sheet.
// The UI and the reply's resolver call this same function with the fixed setup and choices.
// It reads the existing Standard rules and writes only the returned copy and result.

import { applyGear, dressOf, noteGear, wearGear } from '../gear.js';
import { condWord, gearAnswer, stepDown } from '../../domains/gear.js';
import { condOf, defCarry, ENCUMBERED_PENALTY } from '../../domains/inventory.js';
import { mountRows } from '../../domains/mounts.js';
import { hashJson } from '../../replay.js';
import { statPart } from '../formula.js';
import { readSheet } from '../read.js';
import { hasLevels, isStandard } from '../rules.js';
import { prepareStandard, rollStandard, summaryStd } from '../standard.js';
import { boardDice } from './dice.js';
import { fleeRoll } from './flee.js';
import { memberRolls } from './member-rolls.js';
import { boardFoes, collapseFoes, memberSize, splitFoes } from './members.js';
import { areaGroupName } from './order.js';
import { exchangePlan } from './plan.js';
import { attackStat } from './rules.js';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const gearQuery = state => (_name, args) => gearAnswer(state, args, { condOf, carryOf: defCarry, penalty: ENCUMBERED_PENALTY, mounts: mountRows(state) });

/** A segment's sheet and equipped pieces must still be the ones used to roll it. */
export function boardWitness(state, setup) {
    const domain = state?.domains?.dataModules, input = { sheet: readSheet(state), active: domain?.active ?? null, pins: domain?.pins ?? null };
    if (setup?.gear) {
        const query = gearQuery(state), inventory = state?.domains?.inventory;
        const owners = [...new Set(['party', ...Object.values(setup.gear.who ?? {}).flatMap(entry => entry.own ?? [])])].sort();
        input.gear = owners.map(owner => ({ owner, answer: query('inventory.gear', { owner }) }));
        input.equipped = Object.values(inventory?.stacks ?? {}).filter(stack => owners.includes(stack.owner) && stack.equipped)
            .sort(byId).map(stack => ({ id: stack.id, def: stack.def, owner: stack.owner, equipped: stack.equipped, cond: condOf(stack, inventory) }));
    }
    return hashJson(input);
}

/** Rebuild the recorded owners' bonuses and weapons from the private, worn-down inventory. */
export function equipmentForBoard(state, recorded, liveQuery = null) {
    const query = liveQuery ?? gearQuery(state), party = query('inventory.gear', { owner: 'party' }) ?? {}, who = {}, weapons = {};
    const answerOf = owner => query('inventory.gear', { owner });
    for (const [key, entry] of Object.entries(recorded.who)) {
        // Wear changes condition and stat bonuses, but not the recorded carry penalty. A new
        // segment may refresh it from the live, feature-aware inventory query.
        const dress = dressOf(entry.own, party, answerOf), enc = liveQuery ? dress.enc : entry.enc;
        for (const answer of entry.own.map(answerOf)) {
            if (!weapons[key] && answer.slots?.weapon && !answer.slots.weapon.broken) weapons[key] = answer.slots.weapon;
        }
        who[key] = { own: structuredClone(entry.own), ...(dress.add ? { add: dress.add } : {}), ...(enc ? { enc } : {}), ...(dress.items ? { items: dress.items } : {}) };
    }
    return { gear: { v: recorded.v, who }, weapons };
}

// Only this private copy is mutated: the real event is written later by gear.wear on the reply.
function stagingWear(state, gear, options) {
    const query = gearQuery(state), inventory = state.domains.inventory;
    const ctx = { query, call(_type, { owner, slot, steps }) {
        const stacks = Object.values(inventory?.stacks ?? {}).filter(stack => stack.owner === owner);
        const at = place => stacks.filter(stack => stack.equipped === place).sort(byId)[0];
        const stack = at(slot === 'defence' ? (at('body') ? 'body' : 'off-hand') : slot);
        const before = condOf(stack, inventory), now = stepDown(before, steps);
        stack.cond = now;
        if (inventory.condLog) delete inventory.condLog[stack.id];
        return { data: { before, now } };
    } };
    return wearGear(ctx, gear, { ...options, condWord });
}

const maxOf = domain => (module, field) => {
    const max = domain?.pins?.[domain?.active?.[module]?.hash]?.definition?.state?.[field]?.max;
    return Number.isSafeInteger(max) ? max : Infinity;
};

function weaponSides(prepared, sheet, weapons) {
    for (const entry of prepared.acts) {
        if (entry.skill) continue;
        const actor = sheet.characters.find(character => character.key === entry.actor.slice(2));
        if (!actor) continue;
        const stat = attackStat(actor, weapons?.[actor.key]);
        const part = statPart('physical', actor.stats, { skillStat: stat });
        entry.pc = { ...entry.pc, stat: part.main, second: part.second, mainValue: actor.stats[part.main], secondValue: actor.stats[part.second], statBonus: part.value };
    }
}

function openingOrder(state, setup, fightSheet, rules) {
    const plan = { formula: 'standard', pace: 'careful', acts: [], foes: [], checks: [] };
    const prepared = prepareStandard(plan, fightSheet, rules, { maxOf: maxOf(state.domains.dataModules), lv: hasLevels(rules), fix: true, then: true });
    return rollStandard(plan, prepared, boardDice(setup.seed, setup.offset + 1), rules,
        { carried: setup.order, flow: 2, fix: true, then: true, board: true }).order;
}

export function applyHurts(domain, hurts) {
    for (const hurt of hurts) {
        const fields = domain?.instances?.[hurt.module]?.chat?.fields;
        if (fields && Object.hasOwn(fields, hurt.field)) fields[hurt.field] = hurt.to;
    }
}

const foeField = (prefix, foe) => `${prefix}${foe?.local ?? (((foe?.slot ?? 1) - 1) % 4) + 1}`;

// A member fight keeps its bars as virtual foes, so only the final ordinary count/hurt moves are written to the Foes block.
function collapseMoves(realFoes, changes, maxOf) {
    const bySlot = new Map(realFoes.map(foe => [foe.slot, foe])), out = [];
    for (const change of changes) {
        const real = bySlot.get(change.slot);
        if (!real) continue;
        const id = `f:${change.slot}`;
        if (change.count.from !== change.count.to) out.push({ id, kind: 'foe', name: real.name, module: change.module,
            field: foeField('count', real), from: change.count.from, to: change.count.to });
        if (change.hurt.from !== change.hurt.to) out.push({ id, kind: 'foe', name: real.name, module: change.module,
            field: foeField('hurt', real), from: change.hurt.from, to: change.hurt.to, size: memberSize(real, maxOf) });
    }
    return out;
}

/** Run the saved setup and choices; errors leave the caller's state untouched. */
export function playBoard(state, setup, exchanges) {
    if (!state?.domains?.dataModules || !Number.isInteger(setup?.seed) || setup.seed < 0 || setup.seed > 0xFFFFFFFF || !isStandard(setup?.rules)
        || !Number.isInteger(setup.offset) || setup.offset < 0 || !Array.isArray(exchanges) || exchanges.length > 99) return { error: 'The fight setup is damaged.' };
    if (setup.invalidated) return { error: 'The earlier fight was taken back. Restore that reply or discard this fight.' };
    if (setup.witness?.offset === setup.offset && setup.witness.hash !== boardWitness(state, setup))
        return { error: 'The sheet or gear changed after the fight was rolled. Restore it or discard the fight (Fight tab, Discard fight).' };
    const bars = setup.bars === 2, soak = setup.soak === 1;
    if (setup.soak !== undefined && !(soak && bars)) return { error: 'The fight setup is damaged.' };
    if (setup.bars !== undefined && !(bars && readSheet(state).characters.every(actor => actor.scale === 2))) return { error: 'The sheet changed after the fight was rolled. Restore it or discard the fight (Fight tab, Discard fight).' };
    const copy = structuredClone(state), domain = copy.domains.dataModules, rules = setup.rules, limits = maxOf(domain);
    const startSheet = readSheet(copy), members = setup.members === 1, realFoes = members ? startSheet.foes : null;
    const six = setup.foesSix === 1, boardFoeList = members ? splitFoes(realFoes, { carried: setup.carriedMembers, maxOf: limits, six }) : null;
    const virtual = (boardFoeList ?? []).filter(foe => Number.isInteger(foe.group));
    const virtualSlots = new Set(virtual.map(foe => foe.slot)), virtualGroups = new Set(virtual.map(foe => foe.group));
    const values = members ? new Map(boardFoeList.map(foe => [foe.slot, foe.hurt])) : null;
    const rounds = [], opening = [], quickStart = [], idle = [], moved = new Map(), refused = [], wear = [];
    let order = setup.order ?? null, stop = 'open';
    for (const [at, choices] of exchanges.entries()) {
        if (stop !== 'open') return { error: 'The fight has already ended.' };
        const equipment = setup.gear ? equipmentForBoard(copy, setup.gear) : { gear: setup.gear, weapons: setup.weapons };
        const number = setup.offset + at + 1, sheet = applyGear(readSheet(copy), equipment.gear);
        const fightSheet = members ? { ...sheet, foes: boardFoeList.map(foe => ({ ...foe, hurt: values.get(foe.slot) })) } : sheet;
        const built = exchangePlan(fightSheet, choices?.actions, setup.flags, number, { members, aoe: setup.aoe === 1, areaAll: setup.areaAll === 1 && setup.aoe === 1, bars });
        if (built.error) return { error: built.error };
        const standingGroups = real => (boardFoeList ?? []).some(foe => (Number.isInteger(foe.group) ? foe.group : foe.slot) === real.slot && values.get(foe.slot) > 0);
        const fleeFoes = members ? realFoes.filter(standingGroups) : sheet.foes;
        const source = boardDice(setup.seed, number), flee = built.flee ? fleeRoll(built.flee, fleeFoes, rules, source('flee', 0)) : null;
        if (flee && flee.outcome !== 'fail') {
            rounds.push({ n: number, decisive: false, lines: [flee] });
            stop = 'fled';
            continue;
        }
        const hooks = members ? memberRolls(built.plan) : null;
        const prepared = prepareStandard(built.plan, fightSheet, rules, { maxOf: limits, lv: hasLevels(rules), fix: true, then: true, memberRolls: hooks });
        weaponSides(prepared, fightSheet, equipment.weapons);
        const rolled = rollStandard(built.plan, prepared, source, rules, { carried: order, flow: 2, fix: true, then: true, board: true, scaled: bars, soak, memberRolls: hooks, ...(number === 1 && setup.drop ? { drop: setup.drop } : {}) });
        const lines = rolled.rounds[0]?.lines ?? [];
        for (const line of lines) if (line.aoe) line.aoeName = areaGroupName(realFoes.find(foe => foe.slot === line.aoeGroup));
        if (equipment.gear) {
            noteGear([...rolled.opening, ...lines], equipment.gear);
            wear.push(...stagingWear(copy, equipment.gear, { opening: rolled.opening, rounds: [{ n: number, lines }], rules }));
        }
        rounds.push({ n: number, decisive: rolled.rounds[0]?.decisive === true, lines: flee ? [flee, ...lines] : lines, ...(rolled.rounds[0]?.idle?.length ? { idle: rolled.rounds[0].idle } : {}) });
        opening.push(...rolled.opening);
        quickStart.push(...rolled.quickStart);
        idle.push(...rolled.idle);
        refused.push(...prepared.refused);
        order = rolled.order;
        const virtualHurt = hurt => {
            const foe = /^f:(\d+)$/u.exec(hurt.id);
            return Boolean(foe && virtualSlots.has(Number(foe[1])));
        };
        applyHurts(domain, members ? rolled.hurts.filter(hurt => !virtualHurt(hurt)) : rolled.hurts);
        for (const hurt of rolled.hurts) {
            const previous = moved.get(hurt.id);
            moved.set(hurt.id, { ...hurt, from: previous?.from ?? hurt.from });
            const member = /^f:(\d+)$/u.exec(hurt.id);
            if (values && member && values.has(Number(member[1]))) values.set(Number(member[1]), hurt.to);
        }
        if (rolled.stop === 'won' || rolled.stop === 'lost') stop = rolled.stop;
    }
    let hurts = [...moved.values()].filter(hurt => hurt.from !== hurt.to);
    if (members) {
        hurts = hurts.filter(hurt => {
            const foe = /^f:(\d+)$/u.exec(hurt.id);
            return !(foe && virtualSlots.has(Number(foe[1])));
        });
    }
    if (members && stop !== 'open') {
        const collapsed = collapseMoves(realFoes, collapseFoes(realFoes.filter(foe => virtualGroups.has(foe.slot)), values, { maxOf: limits, six }), limits);
        hurts = [...hurts, ...collapsed];
        applyHurts(domain, collapsed);
    }
    if (members && !exchanges.length) {
        const equipment = setup.gear ? equipmentForBoard(copy, setup.gear) : { gear: setup.gear, weapons: setup.weapons };
        const sheet = applyGear(readSheet(copy), equipment.gear);
        const fightSheet = { ...sheet, foes: boardFoeList.map(foe => ({ ...foe, hurt: values.get(foe.slot) })) };
        order = openingOrder(copy, setup, fightSheet, rules);
    }
    const result = { ...(bars ? { bars: 2 } : {}), ...(six ? { foesSix: 1 } : {}), ...(soak ? { soak: 1 } : {}), rounds, opening, order: order ?? [], quickStart, idle, hurts, refused, stop, ...(setup.opening ? { fromApproach: true } : {}), ...(setup.approach ? { checks: structuredClone(setup.approach) } : {}), ...(wear.length ? { wear } : {}),
        summary: summaryStd([], rounds, refused) };
    if (members) result.members = boardFoes(realFoes, values, { maxOf: limits, carried: setup.carriedMembers, six });
    return { state: copy, result };
}
