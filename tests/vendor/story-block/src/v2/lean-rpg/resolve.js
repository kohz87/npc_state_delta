// `rpg.resolve`, the RPG's prelude (SPEC_RPG §2R A3/A5, SPEC_RPG_v1 §4.5.3 and §5).
//
// What it is. Today the fight board makes the rolls (board/commit.js `resolveBoard`). This file keeps what OLD chats need: the plan-based roll the
// retired planner made (`rpg.resolve { key, plan }`, Standard formula only: a record with no `formula` replays as Standard), its record and its replay
// guard. A Re-read keeps the dice (same payload, same seed) and deleting the reply removes them.
// It changes no block value: the narrator's own change lines (set-health, add-xp, practice) do that.
//
// Dice. Each planned action has dice of its own, drawn from the receipt's seed and the action's place in the plan (its index
// among the plan's acts, foes or checks), so an action that is refused, or comes back when the story before it changes, never
// moves another action's dice. A check is one d20; an act or a foe's attack is two d20s a round (the party member's, then the
// foe's), round by round while the fight goes on. (A roll made before that, whose payload has no `dice` version, drew one
// sequence from the seed: the checks first, then each round's actions in plan order; that is kept for it.) A party
// member's total is d20 + floor(stat/2) + 2×Soul Class + skill rank + edge; a foe's is d20 + 5 + 2×class (names.js
// FORMULA; those are Standard's numbers, and the roll is made with the numbers its payload carries, rules.js: the replay rule). A skilled act or check rolls with the skill's own stat and spends the skill's own resource (the Skills block's
// `statN` and `usesN`; the plan's `stat` and `uses` are not read for it); an act with no skill, or with one the character
// lacks, rolls the plan's stat at rank 0. The
// outcome is the party member's: a natural 20 succeeds, a natural 1 fails, a total that reaches the other side
// succeeds, one within FORMULA.costMargin short is "success at a cost", anything else fails. A foe's attack is
// the same roll seen from the defender, who rolls with the `defend` stat, or with a skill the plan names (`skill`, which a skill the defender
// has resolves like an act's: its own stat and rank, an Empty resource rolls without it; one they lack is rolled untrained). Rounds = the smallest of the
// pace (careful 1, normal 5, all 8), LIMITS.roundCap, the first decisive round (a natural 1 or 20 on any die, or a
// margin of LIMITS.decisiveMargin either way) and what fits the cue budget (LIMITS.cueTokens); at least one.
//
// The flow of stage 49 (`flow: 2` in the payload, FLOW_VERSION; a roll made before has none and keeps the rule above exactly): a reply's exchanges run
// until the first of: the fight is WON (every filled foe group is Down), LOST (every party member who has not Left is Down), HEAVY (a party member
// has lost 2 or more Health blocks in this reply, or went Down), the CAP (the rules' most exchanges per reply, 8 by default), the cue BUDGET, or,
// at the careful pace, one exchange. A decisive result is still labelled and still has its effect (a double hit under Standard) but no longer
// ends the reply. Rounds follow the bars round by round: a foe group or a party member who is Down does not act in later rounds ("does not act").
// Standard moves the real bars (the hurts the told rolls took or gave).
//
// Refusals (plain sentences, in the cue and in `refused`): a character the sheet does not have, a stat the character
// lacks (or none to roll with), a foe that is not there or whose slot is empty, a character who is Down: that action is
// not rolled. A skill the character does not have is rolled untrained (rank 0, no skill named); so is one whose resource
// (the skill's `uses`) is Empty, with the skill's stat, and the cue says so.
//
// Replay. Guarded (docs/v2/REPLAY.md) and `replan`: the guard asks that the sheet inputs this roll used are still what
// the prefix holds; when an earlier reply is deleted or swiped and they changed, the roll is planned again with the same
// dice on the new numbers. Claim `rpg:resolve:<key>` (the reader's message) keeps it to one roll per message.
//
// The Standard formula (rules.formula 'standard') rolls in standard/roll.js (re-exported by standard.js). Its record adds typed lines, the
// turn order, the opening action, the bars and the blocks the told rolls took or gave (`hurts`, written to the bars below).
//
// ---- The record for the battle log (agent B) ----------------------------------------------------------------------
// The receipt (type 'rpg.resolve', on the reply's record: message.extra.storySuite.receipts, or the query `rpg.rolls`)
// has `summary` = the cue text and `data.v2.result` =
//   { v: 1, key, pace: 'careful'|'normal'|'all',
//     stop: 'won'|'lost'|'heavy'|'pace'|'cap'|'budget'|'none',   why the rounds end where they do ('none': checks only); a roll made
//           before the flow of stage 49 (no `flow`) says 'decisive' (a round with a natural 1 or 20 or a margin ends it) or, Standard, 'over'
//     flow?: 2,                                                  the rule the rounds stopped by (FLOW_VERSION)
//     checks: [Line], rounds: [{ n, decisive, lines: [Line] }],   the rounds TOLD to the narrator, in order
//     refused: [{ who, text }],                              not rolled, or a skill refused (text is a plain sentence)
//     ambush?: { who, skill, outcome, total, dc, success }  an ambush check's result (ambush.js); a success gave the party's round-1 acts +2
//     summary: { exchanges, acts: [{ kind, who, target, skill, stat, outcomes: ['success'|'cost'|'fail', …] }], refused: n } }
// and a Line is
//   { kind: 'act' | 'foe' | 'check', outcome: 'success'|'cost'|'fail', skill: string|null, why?: string,
//     pc:  { who, die, stat, statBonus, classValue, classBonus, rank, edge, total },
//     foe: { slot, name, die, base, classValue, classBonus, total }          (acts and foe attacks; not checks)
//     difficulty, dc                                                          (checks only) }
// Every number is final: total = die + statBonus + classBonus + rank + edge for the party and die + base + classBonus
// for a foe. 'act': the party member attacks (the outcome is theirs); 'foe': the foe attacks, `stat` is the defend
// stat (or the defending skill's), `skill` the defending skill (null: none; a roll made before there were any has none) and `pc` the
// defender (outcome 'fail' means the defender failed). `summary.exchanges` = rounds.length is the
// number B shows as "Rolled for you: N exchanges". The told count is not recorded: the narrator is not asked to count.
import { FIGHT, FIX_VERSION, LEVEL, LV_VERSION, PRACTICE_STEP, RESOLVE, practiceOf } from './names.js';
import { fightGuard } from './fight.js';
import { boardGuard, resolveBoard } from './board/commit.js';
import { practiceGuard } from './practice.js';
import { EARLIER_RULES, hasLevels, normalizeRules, STANDARD } from './rules.js';
import { prepareStandard, rollStandard } from './standard.js';
import { cueOfResult } from './cue.js';
import { readSheet } from './read.js';
import { validatePlan } from './plan.js';
import { openFoes } from './open.js';
import { applyGear, earnedLegend, gearMarkOf, gearMatches, gearValid, noteGear, planGear, wearGear } from './gear.js';
import { condWord, stepDown } from '../domains/gear.js';
import { partyLevels, averageLevel, settleOpen } from './foes.js';
import { carriedFrom } from './ambush.js';
import { FLOW_VERSION, outcomeOf, positionalDice } from './resolve/dice.js';

// The flow version, outcome rule and dice streams live in resolve/dice.js; this file keeps the record and the guard.
// `prepare` is the Standard preparation.
export { FLOW_VERSION, outcomeOf, positionalDice };
export const prepare = (plan, sheet, rules = STANDARD, options = {}) => prepareStandard(plan, sheet, rules, options);

export const RESULT_VERSION = 1;
/** The version of the dice scheme a payload asks for (`dice` in the payload of `rpg.resolve`): 2 = dice per action position. */
export const DICE_VERSION = 2;
const KEY = /^\d{1,7}-[0-9a-z]{1,7}$/;
export const claimKey = key => `rpg:resolve:${key}`;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Rolls a prepared plan: `source` is positionalDice's answer (each action draws from its own stream). → { checks, rounds, stop, text, summary } with the
 * rounds already cut to the stop and the cue budget. `rules` are the numbers in force (default: Standard); the most rounds is `rules.roundCap`. `earlier`: the
 * cue is fitted as it was for a roll of the earlier scheme (cue.js fitCue). Standard is the only formula: a roll with no `formula` replays as Standard.
 */
export function rollPrepared(plan, prepared, source, rules = STANDARD, { earlier = false, carried = null, flow = 1, wearOf = null, drop = null, opened = null, fix = false, then = false } = {}) {
    // (`fix`: a roll of stage 65, FIX_VERSION; `then`: of mark 3; without it the cue is told exactly as before, because its length decides how many rounds are told)
    return rollStandard(plan, prepared, source, rules, { carried, flow, wearOf, drop, opened, fix, then });
}

// The turn order a Standard roll is given (resolve.js carries it forward in the payload): a short list of { id, name, total, die?, bonus?, agi,
// party }, or null when there is none or it is damaged (the fight then starts here).
const ORDER_ID = /^(?:c:.{1,80}|f:\d{1,3})$/u;
export function orderOf(value) {
    if (!Array.isArray(value) || !value.length || value.length > 24) return null;
    const ok = value.every(entry => isObject(entry) && ORDER_ID.test(entry.id) && typeof entry.name === 'string' && entry.name.length <= 80
        && Number.isSafeInteger(entry.total) && Number.isSafeInteger(entry.agi) && typeof entry.party === 'boolean'
        && (entry.die === undefined || entry.die === null || Number.isSafeInteger(entry.die)) && (entry.bonus === undefined || entry.bonus === null || Number.isSafeInteger(entry.bonus))
        && (entry.left === undefined || (Number.isSafeInteger(entry.left) && entry.left >= 0)));
    return ok && new Set(value.map(entry => entry.id)).size === value.length ? value : null;
}

// The most a block's own field holds (the pinned definition's `max`): a block of an older definition holds at most 5 Health stages.
export const fieldMax = domain => (module, field) => {
    const max = domain?.pins?.[domain?.active?.[module]?.hash]?.definition?.state?.[field]?.max;
    return Number.isSafeInteger(max) ? max : Infinity;
};

// The blocks the told rolls took or gave, written to the bars: the same fields the narrator's change lines and the reader's pencils set.
function writeBars(ctx, hurts) {
    if (!hurts.length) return;
    const instances = ctx.draft('dataModules')?.instances;
    for (const hurt of hurts) {
        const fields = instances?.[hurt.module]?.chat?.fields;
        if (fields && Object.hasOwn(fields, hurt.field)) fields[hurt.field] = hurt.to;
    }
}

// The levels a roll gave its opened foes, in the plan's order (recorded with the roll, as the guard cannot draw them again).
const levelsOf = settled => settled.map(entry => entry.level);
const levelsValid = levels => Array.isArray(levels) && levels.length <= 4 && levels.every(level => Number.isInteger(level) && level >= 1 && level <= 99);

// The numbers a payload rolls with: the ones it carries, or, for a roll recorded before the numbers were kept, those it was made with (the cap of 5 included).
const rulesOfPayload = value => (value === undefined ? EARLIER_RULES : normalizeRules(value));
// A payload that says `lv: 1` rolls with levels (rules.levelDivisor, 5 if the numbers carry none); one that does not rolls with the Soul Class, as before.
const levelledRules = (rules, lv) => (lv === LV_VERSION && !hasLevels(rules) ? { ...rules, levelDivisor: LEVEL.divisor } : rules);
// The flow a payload asks for: FLOW_VERSION only when it says so (a roll of the earlier flow stops as it did).
const flowOf = (asked, positional) => (asked === FLOW_VERSION && positional ? FLOW_VERSION : 1);

const guardOf = (ctx, predicate, witness) => ({ owner: ctx.module, version: 2, epoch: ctx.epoch, rulesHash: null, predicate, inputHash: ctx.hash({ source: ctx.source, predicate, witness }) });

/**
 * `rpg.resolve { key, plan }`: the command (a prelude: turn.js previews it with a seed and stores it on the generated
 * reply with the same seed). `key` is the reader's message (its index and a hash of its text), as Assist's pre-roll keys it.
 */
export function resolve(ctx, payload = {}) {
    if (payload?.board !== undefined) return resolveBoard(ctx, payload);
    if (ctx.cause !== 'system' || ctx.caller !== null) ctx.fail('REFUSED', 'Rolls are made by Story Block before a reply, not by an action.');
    const key = String(payload?.key ?? '');
    if (!KEY.test(key)) ctx.fail('INVALID', 'A roll needs the key of the message it was made for.');
    const start = payload.start;
    if (start !== undefined && (typeof start !== 'string' || !start || start.length > 120)) ctx.fail('INVALID', 'The fight opening is damaged.');
    const checked = validatePlan(payload?.plan);
    if (!checked.ok) ctx.fail('INVALID', `That is not a plan: ${checked.errors[0]}`);
    const plan = payload.plan;
    const order = orderOf(payload.order);
    // A drop an earlier reply's ambush check gave (precall.js carries it in the payload, as it does a fight's turn order): spent on this roll's acts.
    const drop = carriedFrom(payload.ambush);
    // The numbers this roll is made with are the ones the payload carries (chosen when it was planned, from the settings of that
    // moment); a Re-read, a rebuild and a reload run the same payload, so they roll with them again. The settings are never read here.
    const rules = levelledRules(rulesOfPayload(payload.rules), payload.lv);
    const lv = hasLevels(rules) ? LV_VERSION : undefined;
    // The flow of stage 49 is asked for by the payload (precall.js) and needs the dice by position; a roll made before has none and stops as it did.
    const flow = flowOf(payload.flow, true);
    // A fight the pre-call opened (open.js): its foes are put in free slots of the Foes block first, through the block's own set-slot kind, and the
    // roll is made on the sheet that leaves. A plan with no `open` reads the block as it stands, as ever.
    // From the Levels rules (`lv` in the payload) each foe has a level: the one the plan gave, or one drawn inside a rank's band or near the party's average level,
    // from the reply's own seed (the first number it gives, which the dice by position then use as well), so a swipe draws anew and a Re-read keeps it.
    const base = Math.floor(ctx.rng() * 4294967296) >>> 0;
    const opening = Array.isArray(plan.open) && plan.open.length > 0;
    const domain = opening ? ctx.draft('dataModules') : ctx.read('dataModules');
    const settled = opening && lv ? settleOpen(plan.open, averageLevel(partyLevels(readSheet({ domains: { dataModules: domain } }))), base) : null;
    const fix = [2, FIX_VERSION].includes(payload.fix) ? payload.fix : undefined;
    const opened = opening ? openFoes(domain, settled ?? plan.open, { fix: fix ?? 1 }) : null;
    // From a roll that carries the gear mark (precall.js, while `story-block.gear` is on) the worn pieces and the load, worked out here from the state before the
    // roll (the inventory's `recorded` answers: the mark decides, not today's switch), are laid over the stats it rolls with (gear.js). The record is kept with the
    // roll, so a later change never moves it; a change before it is seen by the guard.
    const standing = readSheet({ domains: { dataModules: domain } });
    const mark = gearMarkOf(payload.gear);
    const gear = mark ? planGear(standing, (name, args) => ctx.query(name, ['inventory.gear', 'party.actors', 'party.pc'].includes(name) ? { ...args, recorded: true } : args), mark.lead ?? '') ?? undefined : undefined;
    const sheet = applyGear(standing, gear);
    const prepared = prepare(plan, sheet, rules, { maxOf: fieldMax(domain), flow, lv: Boolean(lv), fix: fix >= 2, then: fix >= 3 });
    if (opening) prepared.witness = { ...prepared.witness, opened };
    if (!opening && !prepared.acts.length && !prepared.foes.length && !prepared.checks.length) ctx.fail('NO_LONGER_DONE', 'Nothing is left to roll on this sheet.');
    const claim = start ? `${claimKey(`start:${encodeURIComponent(start)}`)}:reply:${ctx.reply?.sid ?? ''}` : claimKey(key);
    if (!ctx.claim(claim)) ctx.fail('CLAIMED', 'This message has already been rolled for.');
    // A roll that asks for the dice version draws one number from the seed, and each action's dice come from that and its place in
    // the plan; one made before has no version and draws its dice in one sequence, as it did.
    const source = positionalDice(base);
    const dice = rollPrepared(plan, prepared, source, rules, { earlier: payload.dice !== DICE_VERSION, carried: order, drop, opened: opened ?? null, fix: fix >= 2, then: fix >= 3, flow, wearOf: gear ? (rounds, opening) => wearGear(ctx, gear, { opening, rounds, rules, condWord, stepDown }) : null });
    // From stage 50 a payload may carry the practice per skill use (practice.js); a roll made before has none and gives none.
    const practice = practiceOf(payload.practice) ?? undefined;
    // Gear: each told line names what it rolled with, and a decisive hit taken or miss made wears a piece (gear.js); the wear is part of the roll's receipt.
    let wear = [], legend = false;
    if (gear) {
        noteGear([...dice.checks, ...(dice.opening ?? []), ...dice.rounds.flatMap(round => round.lines)], gear);
        wear = wearGear(ctx, gear, { opening: dice.opening ?? [], rounds: dice.rounds, rules, condWord });
        legend = earnedLegend(dice, sheet, lv === LV_VERSION);
    }
    const predicate = { kind: RESOLVE, key, ...(start ? { start } : {}), plan: ctx.hash(plan), rules: ctx.hash(rules), ...(order ? { order: ctx.hash(order) } : {}), ...(drop ? { ambush: ctx.hash(drop) } : {}), ...(flow === FLOW_VERSION ? { flow } : {}), ...(fix ? { fix } : {}), ...(practice ? { practice } : {}), ...(lv ? { lv } : {}), ...(settled ? { levels: ctx.hash(levelsOf(settled)) } : {}), ...(gear ? { gear: ctx.hash(gear) } : {}) };
    ctx.replayGuard(guardOf(ctx, predicate, prepared.witness), { key, ...(start ? { start } : {}), plan, rules, ...(order ? { order } : {}), ...(drop ? { ambush: drop } : {}), ...(flow === FLOW_VERSION ? { flow } : {}), ...(fix ? { fix } : {}), ...(practice ? { practice } : {}), ...(lv ? { lv } : {}), ...(settled ? { levels: levelsOf(settled) } : {}), ...(gear ? { gear } : {}) });
    const result = {
        v: RESULT_VERSION, key, pace: plan.pace, rules, ...(flow === FLOW_VERSION ? { flow } : {}), ...(fix ? { fix } : {}), ...(practice ? { practice } : {}), ...(lv ? { lv } : {}), ...(gear ? { gear } : {}), stop: dice.stop, checks: dice.checks, rounds: dice.rounds,
        refused: prepared.refused, summary: dice.summary, ...(dice.ambush ? { ambush: dice.ambush } : {}), ...(opening ? { opened } : {}), ...(wear.length ? { wear } : {}), ...(legend ? { legend: 1 } : {}),
        order: dice.order, quickStart: dice.quickStart, opening: dice.opening, idle: dice.idle, hurts: dice.hurts,
    };
    writeBars(ctx, dice.hurts);
    // From stage 51 the receipt keeps no copy of the cue text: it is rebuilt from the record (cue.js cueOfResult) wherever it is told or shown. The text is
    // kept as it always was only if the record would not give back exactly the same bytes (so what is told never changes).
    // (with gear the wear lines were fitted into the cue's budget with the dice (cue.js fitCue `wearOf`); what was really worn is in the record, so the text is the record's)
    if (gear) dice.text = cueOfResult(result, dice.shape);
    const text = cueOfResult(result, dice.shape) === dice.text ? '' : dice.text;
    // (the shape the cue was fitted to is kept beside the record, not in it: a roll made before it is replanned without its record changing)
    return { summary: text, narrate: true, replan: true, data: { v2: { key: claim, result, ...(dice.shape ? { shape: dice.shape } : {}) } } };
}

/**
 * The replay guard (docs/v2/REPLAY.md): the roll stands while the sheet numbers it used are what the prefix holds. Pure:
 * the state before the block and what it recorded, nothing else.
 */
export function leanRpgGuard({ state, hash }, { guard, source, recorded }) {
    if (guard?.predicate?.board === 1) return boardGuard({ state, hash }, { guard, source, recorded });
    const bad = reason => ({ ok: false, reason });
    if (guard?.predicate?.kind === FIGHT) return fightGuard({ state, hash }, { guard, source, recorded });
    if (guard?.predicate?.kind === PRACTICE_STEP) return practiceGuard({ state, hash }, { guard, source, recorded });
    try {
        const predicate = guard?.predicate;
        if (guard?.version !== 2 || guard.rulesHash !== null || !isObject(predicate) || predicate.kind !== RESOLVE) return bad('Malformed roll guard.');
        if (!isObject(recorded) || !validatePlan(recorded.plan).ok || hash(recorded.plan) !== predicate.plan || recorded.key !== predicate.key) return bad('The roll\'s plan was damaged.');
        if (recorded.start !== predicate.start || (recorded.start !== undefined && (typeof recorded.start !== 'string' || !recorded.start || recorded.start.length > 120))) return bad('The fight opening was damaged.');
        // The numbers are the ones recorded with the roll, not today's settings; damaged numbers are not guessed at.
        // A roll recorded before the numbers were kept has none: it was made with Standard's.
        const rules = rulesOfPayload(recorded.rules);
        // The level mark is hashed with the roll: the numbers carry a divisor exactly when the roll says `lv: 1`; a roll made before has neither.
        if (recorded.lv !== predicate.lv || (recorded.lv !== undefined && recorded.lv !== LV_VERSION) || hasLevels(rules) !== (recorded.lv === LV_VERSION)) return bad('The roll\'s level mark was damaged.');
        const kept = recorded.rules !== undefined || predicate.rules !== undefined;
        if (kept && (hash(recorded.rules ?? null) !== hash(rules) || hash(rules) !== predicate.rules)) return bad('The roll\'s numbers were damaged.');
        // The flow it stopped by is hashed with it; a roll of the earlier flow has none.
        const flow = recorded.flow === undefined && predicate.flow === undefined ? 1 : recorded.flow === FLOW_VERSION && predicate.flow === FLOW_VERSION ? FLOW_VERSION : null;
        if (flow === null) return bad('The roll\'s flow was damaged.');
        // The stage-65 rules mark (foe slots, spent-skill fallback) is hashed with the roll; a roll made before has none and keeps the earlier rules.
        if (recorded.fix !== predicate.fix || (recorded.fix !== undefined && ![2, FIX_VERSION].includes(recorded.fix))) return bad('The roll\'s rules mark was damaged.');
        // Practice by code is hashed with the roll that asked for it; a roll made before has none.
        if (recorded.practice !== predicate.practice || (recorded.practice !== undefined && practiceOf(recorded.practice) === null)) return bad('The roll\'s practice mark was damaged.');
        // The drop an earlier reply's ambush check gave is hashed with the roll that spent it.
        if (predicate.ambush !== undefined || recorded.ambush !== undefined) {
            if (carriedFrom(recorded.ambush) === null || hash(recorded.ambush) !== predicate.ambush) return bad('The roll\'s ambush was damaged.');
        }
        // The turn order a Standard roll was given (carried from the fight's earlier reply) is hashed with it.
        if (predicate.order !== undefined || recorded.order !== undefined) {
            if (orderOf(recorded.order) === null || hash(recorded.order) !== predicate.order) return bad('The roll\'s turn order was damaged.');
        }
        // The Levels rules are hashed with the roll that used them; the levels its opened foes were given (drawn from the reply's seed when it was rolled) are recorded and hashed too.
        // Gear (gear.js) is hashed with the roll that carried it: a record that has it must be one this version reads; a roll made before has none.
        if ((recorded.gear === undefined) !== (predicate.gear === undefined) || (recorded.gear !== undefined && (!gearValid(recorded.gear) || hash(recorded.gear) !== predicate.gear))) return bad('The roll\'s gear was damaged.');
        const gear = recorded.gear;
        // (what the roll was worked out from must still be what the state before it holds)
        if (gear && !gearMatches(state, gear, hash)) return bad('The gear before this roll changed; Re-read this reply.');
        const lv = recorded.lv === LV_VERSION;
        const levels = lv && recorded.levels !== undefined ? recorded.levels : null;
        if (levels !== null && (!levelsValid(levels) || hash(levels) !== predicate.levels)) return bad('The roll\'s foe levels were damaged.');
        if (levels === null && predicate.levels !== undefined) return bad('The roll\'s foe levels were damaged.');
        // A roll that opened a fight is asked again on the block with those foes put in, as it was rolled.
        const opening = Array.isArray(recorded.plan.open) && recorded.plan.open.length > 0;
        if (opening && lv && (!levels || levels.length !== recorded.plan.open.length)) return bad('The roll\'s foe levels were damaged.');
        const domain = opening ? structuredClone(state.domains?.dataModules) : state.domains?.dataModules;
        const opened = opening ? openFoes(domain, lv ? recorded.plan.open.map((entry, at) => ({ name: entry.name, count: entry.count, level: levels[at] })) : recorded.plan.open, { fix: recorded.fix ?? 1 }) : null;
        const witness = prepare(recorded.plan, applyGear(readSheet(opening ? { domains: { dataModules: domain } } : state), gear), rules, { maxOf: fieldMax(domain), flow, lv, fix: recorded.fix >= 2, then: recorded.fix >= 3 }).witness;
        if (opening) witness.opened = opened;
        if (hash({ source, predicate, witness }) !== guard.inputHash) return bad('The sheet before this roll changed; Re-read this reply.');
        return { ok: true };
    } catch { return bad('Damaged roll record.'); }
}

// ---- reading a reply's rolls --------------------------------------------------------------------------------------

/**
 * The rolls kept on one reply: `entries` = [{ index, receipt }] (store.receipts(), or the receipts of one record with an
 * `index`), `index` = the reply. → { receipt, result, summary } for the last `rpg.resolve` receipt there that has a
 * result record, else null.
 */
export function rollsOf(entries, index) {
    const found = (Array.isArray(entries) ? entries : []).findLast(entry => entry?.receipt?.type === RESOLVE && entry.index === index
        && isObject(entry.receipt.data?.v2?.result) && entry.receipt.data.v2.result.v === RESULT_VERSION);
    if (!found) return null;
    const result = found.receipt.data.v2.result;
    return { receipt: found.receipt, result, summary: result.summary ?? { exchanges: result.rounds?.length ?? 0, acts: [], refused: 0 } };
}
