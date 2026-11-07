// Reads a reply's recorded roll (the `rpg.resolve` receipt) into the battle log's lines: Classic and Standard roll
// text, breakdowns, gear, costs, moves, turn order and an ambush check. A line that is not whole is left out.

import { RESOLVE } from '../../index.js';
import { LEVEL, CLASS_NAMES, RANK_NAMES, STAGES, LIMITS, stageWord } from '../../names.js';
import { fold } from '../../read.js';
import { soulShortOf } from '../../soul.js';
import { RPG_STRINGS, fill } from '../../strings.js';
import { wearLine, cueOfResult } from '../../cue.js';
import { memberOrderEntries } from '../../board/order.js';
import { B, IDLE } from './constants.js';
import { isRecord, list, words } from './util.js';

/** 'success' | 'cost' | 'fail' | '' for an outcome. */
export const outcomeOf = raw => (raw === 'success' || raw === 'cost' || raw === 'fail' ? raw : '');

/** "d20 14 + STR 7 + Class II 4 + Adept 1 = 26" from a roll `{ d20, parts, total }`; '' when there is nothing to show. */
export function rollText(roll) {
    if (!isRecord(roll)) return '';
    const parts = list(roll.parts).filter(part => isRecord(part) && Number.isFinite(part.value) && part.value !== 0);
    const terms = parts.map(part => `${words(part.label, 24)} ${Math.abs(part.value)}`.trim());
    const body = [Number.isFinite(roll.d20) ? `d20 ${roll.d20}` : '', ...terms.map((term, at) => (Number.isFinite(roll.d20) || at ? `${parts[at].value < 0 ? '−' : '+'} ${term}` : term))].filter(Boolean).join(' ');
    const sum = Number.isFinite(roll.total) ? ` = ${roll.total}` : '';
    return body ? `${body}${sum}` : '';
}

// "Class II", or what the Character block calls it ("Level 3"): `soul` is its soulReading (null: the template's words).
const classText = (value, soul) => `${soul ? soulShortOf(soul.label, 'Class') : 'Class'} ${soul ? soul.word(value) : CLASS_NAMES[value - 1] ?? value}`;

// A roll made under Levels (the record's `lv` mark, on the result, the line or a side) tells the level term: "Lv 14 ÷ 5 = 2"; the side keeps its
// level in `level` (else `classValue`) and the term in `levelBonus` (else `classBonus`). A record without the mark reads as it always did: "Class II 4".
const isLevelSide = (side, lv) => lv === true || side?.lv === 1 || side?.level !== undefined;
const termLabel = (side, soul, lv) => (isLevelSide(side, lv) ? `Lv ${side.level ?? side.classValue} ÷ ${side.divisor ?? LEVEL.divisor} =` : classText(side.classValue, soul));
const termValue = (side, lv) => (isLevelSide(side, lv) ? side.levelBonus ?? side.classBonus : side.classBonus);

// The party side of a Line: the die, the stat, the class, the skill's rank and the edge.
const pcRoll = (pc, skill, soul, lv) => ({ d20: pc.die, total: pc.total, parts: [
    { label: words(pc.stat, 12).toUpperCase(), value: pc.statBonus }, { label: termLabel(pc, soul, lv), value: termValue(pc, lv) },
    { label: skill ? RANK_NAMES[pc.rank] ?? `Rank ${pc.rank}` : '', value: pc.rank }, { label: 'Edge', value: pc.edge }] });
const foeRoll = (foe, soul, lv) => ({ d20: foe.die, total: foe.total, parts: [{ label: '', value: foe.base }, { label: termLabel(foe, soul, lv), value: termValue(foe, lv) }] });

// Gear in the roll (the record's `pc.gear`, gear.js): "Cane Sword +2 DEX, Encumbered −2 AGI". A record without it says nothing.
const gearText = gear => list(gear).filter(item => isRecord(item) && Number.isFinite(item.n) && item.n !== 0 && words(item.name, 40) && words(item.stat, 12))
    .map(item => `${words(item.name, 40)} ${item.n < 0 ? '−' : '+'}${Math.abs(item.n)} ${words(item.stat, 12).toUpperCase()}`).join(', ');

// ---- the Standard formula's lines ----

const TYPE_WORDS = Object.freeze({ physical: 'Physical', magic: 'Magic', defence: 'Defence', social: 'Social', check: 'Check' });
const signed = value => `${value < 0 ? '−' : '+'} ${Math.abs(value)}`;

// "Physical: d20 17 + (AGI 10 + DEX 6/2)/2 = 6 + Expert 2 + Class II 4 + edge 1 = 29": the party side of a Standard line.
function pcStandard(raw, skill, soul, lv) {
    const pc = raw.pc, stat = words(pc.stat, 12).toUpperCase(), second = words(pc.second, 12).toUpperCase();
    const head = `${TYPE_WORDS[raw.type] ?? 'Roll'}${words(pc.style, 12) ? `, ${words(pc.style, 12)}` : ''}`;
    const terms = [`${Number.isFinite(pc.die) ? `d20 ${pc.die} + ` : ''}(${stat} ${pc.mainValue} + ${second} ${pc.secondValue}/2)/2 = ${pc.statBonus}`];
    if (skill) terms.push(`+ ${RANK_NAMES[pc.rank] ?? `Rank ${pc.rank}`} ${pc.rank}`);
    if (termValue(pc, lv)) terms.push(`+ ${termLabel(pc, soul, lv)} ${termValue(pc, lv)}`);
    if (Number.isFinite(pc.edge) && pc.edge !== 0) terms.push(`${signed(pc.edge).replace(' ', ' edge ')}${pc.window && pc.edge !== pc.situation ? ` (luck window ${pc.window.min}..${pc.window.max})` : ''}`);
    return `${head}: ${terms.join(' ')} = ${pc.total}`;
}

// What the told roll did to a bar: "Weir-drake loses 1 block (5 of 6)", "Wessel heals 2 blocks (6 of 6)".
function damageText(damage) {
    if (!isRecord(damage) || !Number.isFinite(damage.blocks) || damage.blocks === 0 || !Number.isFinite(damage.to) || !Number.isFinite(damage.size)) return '';
    const n = Math.abs(damage.blocks);
    return fill(damage.blocks > 0 ? B.loses : B.heals, { who: words(damage.name, 40), n, blocks: n === 1 ? B.blockOne : B.blockMany, to: damage.to, size: damage.size });
}

function breakdownStandard(raw, skill, soul, foeSide, against, lv) {
    const theirs = foeSide ? `${words(foeSide.name, 40)} ${rollText(foeRoll(foeSide, soul, lv))}`.trim() : Number.isFinite(against) ? `DC ${against}` : '';
    return [`${pcStandard(raw, skill, soul, lv)}${theirs ? ` · vs ${theirs}` : ''}`, damageText(raw.damage), raw.decisive === true ? B.decisive : ''].filter(Boolean).join(' · ');
}

// The bar a skill's cost moved on a recorded line ('mana' | 'stamina'), from the cost's bar id; '' when the line has none (a record from before kept none).
const costOf = cost => (isRecord(cost) ? /:(mana|stamina)$/.exec(String(cost.id ?? ''))?.[1] ?? '' : '');

// One Line as the panel draws it: who acts, on whom, the acting side's total against the other's, and the roll behind it. A party
// act or check reads the party's total first; a foe's attack reads from the attacker's side, so the foe's total and roll come first.
function lineOf(raw, soulOf = () => null, lv = false, divisor = null, members = null) {
    if (!isRecord(raw) || !isRecord(raw.pc) || !Number.isFinite(raw.pc.total)) return null;
    // The divisor the roll was made with is the result's own (rules.levelDivisor): both sides of the line tell it, not today's default.
    if (lv && divisor !== null) raw = { ...raw, pc: { ...raw.pc, divisor: raw.pc.divisor ?? divisor }, ...(isRecord(raw.foe) ? { foe: { ...raw.foe, divisor: raw.foe.divisor ?? divisor } } : {}) };
    const outcome = outcomeOf(raw.outcome);
    const foeSide = isRecord(raw.foe) && Number.isFinite(raw.foe.total) ? raw.foe : null;
    const skill = words(raw.skill, 40), why = words(raw.why, 120), told = words(raw.breakdown, 400);
    // A foe's class is told in the words of the party member it is rolled against, so one line reads in one set of words.
    const soul = soulOf(words(raw.pc.who, 40));
    lv = lv || raw.lv === 1;
    const mine = pcRoll(raw.pc, skill, soul, lv);
    const against = raw.kind === 'check' ? (Number.isFinite(raw.dc) ? raw.dc : null) : foeSide?.total ?? null;
    const theirs = foeSide ? rollText(foeRoll(foeSide, soul, lv)) : against !== null ? `DC ${against}` : '';
    const detail = (raw.kind === 'foe' ? [theirs, rollText(mine)] : [rollText(mine), theirs]).filter(Boolean).join(' vs ');
    // A Standard line (typed, with both stats of the pair recorded) tells its roll as the formula makes it; a Classic one is as it was.
    const standard = typeof raw.type === 'string' && Number.isFinite(raw.pc.mainValue) && Number.isFinite(raw.pc.secondValue);
    const breakdown = told || (standard ? breakdownStandard(raw, skill, soul, foeSide, against, lv) : why ? `${detail} · ${why}` : detail);
    const gear = gearText(raw.pc.gear);
    // New-board virtual bars never reach the Foes block. Their own recorded moves, and each actual skill cost,
    // belong on the line that made them, rather than on a line chosen from the reply's final state.
    const arrows = [], cost = costOf(raw.cost);
    const movement = (move, kind, name) => {
        if (!isRecord(move) || !Number.isFinite(move.from) || !Number.isFinite(move.to) || !Number.isFinite(move.size) || move.size <= 0 || !name) return false;
        const to = stageWord(STAGES[kind], move.to, move.size);
        if (move.from !== move.to) arrows.push(kind === 'health' ? `${name} ${to}` : fill(B.arrowBar, { name, bar: RPG_STRINGS.bars[kind], word: to }));
        return true;
    };
    const member = members?.get(raw.damage?.id);
    if (member) movement(raw.damage, 'health', words(member.name, 40));
    const recordedCost = members && cost && movement(raw.cost, cost, words(raw.cost?.name ?? raw.pc.who, 40));
    const base = { outcome, total: raw.pc.total, vs: against, skill, breakdown: gear && breakdown ? `${breakdown} · ${gear}` : breakdown, arrows, ...(cost ? { cost } : {}),
        ...(recordedCost ? { recordedCost: cost } : {}), ...(raw.decisive === true ? { decisive: true } : {}), ...(raw.area === true ? { area: true } : {}), ...(gear ? { gear } : {}) };
    // A support action (a heal or a buff, a `check` line that names the one helped) reads like an act on that character.
    if (raw.kind === 'check' && raw.support === true && words(raw.target, 40)) return { ...base, who: words(raw.pc.who, 40), target: words(raw.target, 40), stat: words(raw.pc.stat, 12).toUpperCase(), foe: false, support: true, heals: isRecord(raw.damage) && raw.damage.blocks < 0 };
    if (raw.kind === 'foe') return { ...base, total: foeSide?.total ?? null, vs: raw.pc.total, who: words(foeSide?.name, 40), target: words(raw.pc.who, 40), skill: '', defence: skill, stat: words(raw.pc.stat, 12).toUpperCase(), foe: true };
    if (raw.kind === 'check') return { ...base, who: words(raw.pc.who, 40), target: '', stat: words(raw.pc.stat, 12).toUpperCase(), foe: false, what: skill || words(raw.pc.stat, 12).toUpperCase() };
    return { ...base, who: words(raw.pc.who, 40), target: words(foeSide?.name, 40), stat: words(raw.pc.stat, 12).toUpperCase(), foe: false };
}

// Why the roll stopped and the numbers it ran under, read from the record only (nothing is stored new). `receipt` is the cue the narrator was told,
// rebuilt by cueOfResult; a record with no stop, pace or rules (an old chat) gets none, so it draws as it always did.
function whyOf(result, shape) {
    const stop = typeof result.stop === 'string' ? result.stop : '';
    const pace = typeof result.pace === 'string' ? result.pace : '';
    const flow = result.flow === 2 ? 2 : 0;
    const cap = Number.isSafeInteger(result.rules?.roundCap) ? result.rules.roundCap : flow === 2 ? LIMITS.roundCapDefault : LIMITS.roundCap;
    const margin = Number.isSafeInteger(result.rules?.decisiveMargin) ? result.rules.decisiveMargin : null;
    const recorded = stop || pace || isRecord(result.rules);
    const receipt = recorded ? cueOfResult(result, shape) : '';
    return { stop, pace, flow, cap, board: isRecord(result.board) || result.board === true, ...(margin !== null ? { margin } : {}), ...(receipt ? { receipt } : {}) };
}

/**
 * A's result record as the panel draws it: `{ rounds: [{ n, lines, skipped?: [{ who, why }] }], checks, order, orderEntries?, quickStart?, opening?, refused, stop, pace, flow, cap, board, margin?, receipt }` or null when the
 * record holds nothing to show. A Line that is not whole is left out, never thrown on.
 */
export function readResolve(result, { soulOf = () => null, shape = 0 } = {}) {
    if (!isRecord(result)) return null;
    const lv = result.lv === 1;
    const divisor = Number.isInteger(result.rules?.levelDivisor) ? result.rules.levelDivisor : null;
    const memberList = Array.isArray(result.members) ? result.members.filter(isRecord) : null;
    const virtual = memberList ? memberList.filter(item => Number.isInteger(item.slot) && Number.isInteger(item.group) && item.slot !== item.group) : [];
    const members = memberList ? new Map(virtual.map(item => [`f:${item.slot}`, item])) : null;
    const rounds = list(result.rounds).map((round, at) => {
        // Who does not act this round: Standard's `idle` entries (with why), or plain names (read as beaten before their turn).
        const skipped = list(round?.idle ?? round?.skipped).map(item => ({ who: words(isRecord(item) ? item.who ?? item.name : item, 40), why: IDLE[item?.why] ? item.why : 'beaten' })).filter(item => item.who);
        const n = Number.isSafeInteger(round?.n) ? round.n : at + 1;
        // What the round wore out (gear.js): "Boiled Leather Jerkin is worn (Torn)", from the roll's own record.
        const wear = list(result.wear).filter(item => isRecord(item) && item.n === n && words(item.item, 60)).map(item => wearLine({ ...item, item: words(item.item, 60) }));
        return { n, lines: list(round?.lines).map(line => lineOf(line, soulOf, lv, divisor, members)).filter(line => line?.who), ...(skipped.length ? { skipped } : {}), ...(wear.length ? { wear } : {}) };
    }).filter(round => round.lines.length || round.skipped?.length);
    const opening = list(result.opening).map(line => lineOf(line, soulOf, lv, divisor, members)).filter(line => line?.who);
    const checks = list(result.checks).map(line => lineOf(line, soulOf, lv, divisor)).filter(line => line?.who);
    const refused = list(result.refused).filter(isRecord).map(item => ({ who: words(item.who, 40), why: words(item.text, 160) })).filter(item => item.why);
    if (!rounds.length && !checks.length) return null;
    // The order they act in: the names of the first round, each once.
    // The Standard formula records the order itself, with the totals rolled (result.order); else it is the names of the first round.
    // The level each one rolled with (the sides of the recorded lines), so the turn order says the level of the roll, not of the state after the reply.
    const rolledAt = new Map();
    if (lv) for (const raw of [...list(result.opening), ...list(result.rounds).flatMap(round => list(round?.lines)), ...list(result.checks)]) {
        if (!isRecord(raw)) continue;
        if (isRecord(raw.pc) && raw.pc.who) rolledAt.set(fold(words(raw.pc.who, 40)), raw.pc.level ?? raw.pc.classValue);
        if (isRecord(raw.foe) && raw.foe.name) rolledAt.set(fold(words(raw.foe.name, 40)), raw.foe.level ?? raw.foe.classValue);
    }
    const entries = list(result.order).filter(isRecord).map(item => ({ ...(memberList ? { id: item.id, slot: item.slot } : {}), name: words(item.name, 40), total: Number.isFinite(item.total) ? item.total : null, party: item.party === true,
        ...(rolledAt.has(fold(words(item.name, 40))) && Number.isFinite(rolledAt.get(fold(words(item.name, 40)))) ? { level: rolledAt.get(fold(words(item.name, 40))) } : {}) })).filter(item => item.name);
    if (memberList) {
        for (const item of entries) if (item.level === undefined && !item.party) {
            const member = memberList.find(entry => `f:${entry.slot}` === item.id);
            const level = memberList.filter(entry => entry.group === member?.group).map(entry => rolledAt.get(fold(words(entry.name, 40)))).find(Number.isFinite);
            if (level !== undefined) item.level = level;
        }
        entries.splice(0, entries.length, ...memberOrderEntries(entries, memberList));
    }
    const order = entries.length ? entries.map(item => item.name) : [...new Set(rounds[0]?.lines.map(line => line.who) ?? [])];
    const quickStart = list(result.quickStart).filter(isRecord).map(item => ({ who: words(item.who, 40), against: words(item.against, 40) })).filter(item => item.who && item.against);
    // An ambush check's result (ambush.js): told in one line before Round 1.
    const ambush = isRecord(result.ambush) && words(result.ambush.who, 40) && typeof result.ambush.success === 'boolean'
        ? { who: words(result.ambush.who, 40), what: words(result.ambush.skill, 40) ? `${words(result.ambush.skill, 40)} check` : 'check', success: result.ambush.success, half: result.ambush.outcome === 'cost', drop: result.ambush.drop === true, total: Number.isFinite(result.ambush.total) ? result.ambush.total : '?', dc: Number.isFinite(result.ambush.dc) ? result.ambush.dc : '?' } : null;
    return { rounds, checks, refused, order, ...(memberList ? { virtualGroups: [...new Set(virtual.map(item => item.group))] } : {}), ...(ambush ? { ambush } : {}), ...(entries.length ? { orderEntries: entries } : {}), ...(quickStart.length ? { quickStart } : {}), ...(opening.length ? { opening } : {}), ...whyOf(result, shape) };
}

/** The recorded rolls of a reply's record: the result of its `rpg.resolve` receipt that the replay kept, or null. */
export function resolveOf(record, problems = [], options = {}) {
    const skipped = new Set(list(problems).flatMap(problem => list(problem?.receipts)));
    const receipts = list(record?.receipts);
    const board = receipts.findLast(receipt => receipt?.type === RESOLVE && receipt?.data?.v2?.result?.board && !skipped.has(receipt.id));
    for (const receipt of board ? [board, ...receipts.filter(item => item !== board)] : receipts) {
        if (receipt?.type !== RESOLVE || skipped.has(receipt.id)) continue;
        const read = readResolve(receipt.data?.v2?.result, { ...options, shape: Number.isSafeInteger(receipt.data?.v2?.shape) ? receipt.data.v2.shape : 0 });
        if (read) return read;
    }
    return null;
}
