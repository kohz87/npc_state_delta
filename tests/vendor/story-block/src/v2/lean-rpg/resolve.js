// `rpg.resolve`, the RPG's prelude (SPEC_RPG §2R A3/A5, SPEC_RPG_v1 §4.5.3 and §5).
//
// What it is. The pre-call (precall.js) turns the reader's message into a plan (plan.js). beforeGenerate asks for
// `rpg.resolve { key, plan }`; turn.js previews it for the prompt (the [Rolls] cue under [Happened]) and, once the
// reply is generated, stores it on that reply before its story lines, with the same seed. So a Re-read keeps the dice
// (same payload, same seed), a swipe draws new ones (a new pre-call, a new seed) and deleting the reply removes them.
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
// the same roll seen from the defender, who rolls with the `defend` stat and no skill. Rounds = the smallest of the
// pace (careful 1, normal 5, all 8), LIMITS.roundCap, the first decisive round (a natural 1 or 20 on any die, or a
// margin of LIMITS.decisiveMargin either way) and what fits the cue budget (LIMITS.cueTokens); at least one.
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
// ---- The record for the battle log (agent B) ----------------------------------------------------------------------
// The receipt (type 'rpg.resolve', on the reply's record: message.extra.storySuite.receipts, or the query `rpg.rolls`)
// has `summary` = the cue text and `data.v2.result` =
//   { v: 1, key, pace: 'careful'|'normal'|'all',
//     stop: 'decisive'|'pace'|'cap'|'budget'|'none',        why the rounds end where they do ('none': checks only)
//     checks: [Line], rounds: [{ n, decisive, lines: [Line] }],   the rounds TOLD to the narrator, in order
//     refused: [{ who, text }],                              not rolled, or a skill refused (text is a plain sentence)
//     summary: { exchanges, acts: [{ kind, who, target, skill, stat, outcomes: ['success'|'cost'|'fail', …] }], refused: n } }
// and a Line is
//   { kind: 'act' | 'foe' | 'check', outcome: 'success'|'cost'|'fail', skill: string|null, why?: string,
//     pc:  { who, die, stat, statBonus, classValue, classBonus, rank, edge, total },
//     foe: { slot, name, die, base, classValue, classBonus, total }          (acts and foe attacks; not checks)
//     difficulty, dc                                                          (checks only) }
// Every number is final: total = die + statBonus + classBonus + rank + edge for the party and die + base + classBonus
// for a foe. 'act': the party member attacks (the outcome is theirs); 'foe': the foe attacks, `stat` is the defend
// stat and `pc` the defender (outcome 'fail' means the defender failed). `summary.exchanges` = rounds.length is the
// number B shows as "Rolled for you: N exchanges". The told count is not recorded: the narrator is not asked to count.
import { FORMULA, LIMITS, PACE, RESOLVE, STAGES } from './names.js';
import { normalizeRules, STANDARD } from './rules.js';
import { fitCue } from './cue.js';
import { matchCharacter, matchFoe, matchSkill, readSheet, strongestStat } from './read.js';
import { validatePlan } from './plan.js';
import { rng as seededRandom } from '../rng.js';

export const RESULT_VERSION = 1;
/** The version of the dice scheme a payload asks for (`dice` in the payload of `rpg.resolve`): 2 = dice per action position. */
export const DICE_VERSION = 2;
const KEY = /^\d{1,7}-[0-9a-z]{1,7}$/;
export const claimKey = key => `rpg:resolve:${key}`;
const cap = word => word.charAt(0).toUpperCase() + word.slice(1);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The outcome for the party member's die and total against `against` (see the top); `rules` are the numbers in force (default: Standard). */
export function outcomeOf(die, total, against, rules = STANDARD) {
    if (die === FORMULA.die) return 'success';
    if (die === 1) return 'fail';
    if (total >= against) return 'success';
    return total >= against - rules.costMargin ? 'cost' : 'fail';
}

// The party member's side of a roll as the sheet gives it (no die yet).
// `hidden`: the stat came from a skill whose stat the pack hides; that, or a stat the character's block hides, is used by the
// rules and not named by the cue (review 163).
function side(character, stat, rank, edge, rules, hidden = false) {
    const value = character.stats[stat];
    return {
        who: character.who, stat, statBonus: Math.floor(value / rules.statDivisor),
        classValue: character.soul, classBonus: rules.classWeight * character.soul, rank, edge,
        ...(hidden || (character.hidden ?? []).includes(stat) ? { statHidden: true } : {}),
    };
}

// A skill phrase on a character's sheet, and what the act rolls with: { skill, rank, stat, uses, refused? }. The skill's own
// stat and resource win over the plan's; a character without the skill, or with the skill's resource Empty, rolls untrained
// (rank 0, no skill named), the first with the plan's stat and the second with the skill's. With no stat anywhere (a skill the
// character lacks and none given, or a skill of an old Skills block that has no stat and none given) the roll is untrained with
// the character's best stat, and the cue says so.
//
// A refusal that would name something the pack hides is said without it (review 163); `refusedPlain` is the wording as if nothing
// were hidden, which only measures the cue (fitCue), so hiding never changes how many rounds are told (review 166). The hidden
// wording is never longer than the plain one.
function skillFor(character, phrase, planned) {
    if (!phrase) return { skill: null, rank: 0, stat: planned.stat, uses: null };
    const found = matchSkill(character, phrase);
    const best = () => strongestStat(character);
    const named = stat => ` with ${stat?.toUpperCase()}, their best stat`;
    const bestly = (stat, plain = false) => (stat ? '' : !plain && (character.hidden ?? []).includes(best()) ? ' with their best stat' : named(best()));
    const say = (fields, text) => ({ ...fields, refused: text(false), refusedPlain: text(true) });
    if (!found) {
        const stat = planned.stat ?? best();
        return say({ skill: null, rank: 0, stat, uses: null }, plain => `${character.who} has no skill called ${phrase}: rolled untrained${bestly(planned.stat, plain)}.`);
    }
    if (!found.stat && !planned.stat) return say({ skill: null, rank: 0, stat: best(), uses: null }, plain => `${character.who}'s ${found.name} has no stat of its own: rolled untrained${bestly(null, plain)}.`);
    const stat = found.stat ?? planned.stat, resource = found.uses ?? (planned.uses === 'mana' ? 'mana' : 'stamina');
    // A skill's stat or resource the pack hides still counts for the rules; the cue and the refusal leave it out (review 163).
    const hiddenStat = found.stat && (found.hidden ?? []).includes('stat') ? { statHidden: true } : {};
    if (character[resource] === 0) {
        const hidden = Boolean(found.uses) && (found.hidden ?? []).includes('uses');
        return say({ skill: null, rank: 0, stat, uses: resource, ...hiddenStat }, plain => `${character.who} cannot use ${found.name}${hidden && !plain ? '' : ` (${cap(resource)} ${STAGES[resource][0]})`}: rolled without it.`);
    }
    return { skill: found.name, rank: found.rank, stat, uses: resource, ...hiddenStat };
}

/**
 * The plan against the sheet: what can be rolled, what is refused and why, and the witness (every sheet number the
 * roll depends on, which the replay guard asks again). `rules` are the numbers in force (rules.js; default: Standard).
 * → { acts, foes, checks, refused: [{ who, text }], witness }
 */
export function prepare(plan, sheet, rules = STANDARD) {
    // `plainRefused`: each refusal as if nothing were hidden, to measure the cue only (never saved, never told; review 166).
    const out = { acts: [], foes: [], checks: [], refused: [], plainRefused: [] };
    const refuse = (who, text, plain = text) => { out.refused.push({ who, text }); out.plainRefused.push(plain); };
    const ready = who => {
        const character = matchCharacter(sheet, who);
        if (!character) return { refusal: `no character called ${who}` };
        if (character.alive === false || character.health === 0) return { refusal: `${character.who} is Down` };
        return { character };
    };
    // The stat the act rolls with, once the skill has had its say: it must be on the sheet.
    // `hidden`: the stat is a skill's hidden one, so the refusal does not name it (review 164); `plain` names it, to measure.
    const statOf = (character, stat, hidden = false) => {
        if (!stat) return { refusal: `${character.who} has no stat to roll with` };
        const plain = `${character.who} has no ${stat.toUpperCase()} on the sheet`;
        if (!Number.isInteger(character.stats[stat])) return { refusal: hidden ? `${character.who} lacks the skill's stat` : plain, plain };
        return {};
    };
    for (const [at, act] of (plan.acts ?? []).entries()) {
        const foe = matchFoe(sheet, act.target);
        const actor = ready(act.who);
        const label = `${act.who} → ${act.target}`;
        if (actor.refusal) { refuse(act.who, `${label}: not rolled (${actor.refusal}).`); continue; }
        if (!foe) { refuse(act.who, `${label}: not rolled (no foe called ${act.target}).`); continue; }
        const skill = skillFor(actor.character, act.skill, act);
        const stat = statOf(actor.character, skill.stat, skill.statHidden);
        if (stat.refusal) { refuse(act.who, `${label}: not rolled (${stat.refusal}).`, `${label}: not rolled (${stat.plain ?? stat.refusal}).`); continue; }
        if (skill.refused) refuse(act.who, skill.refused, skill.refusedPlain);
        const edge = Math.max(-FORMULA.edgeMax, Math.min(FORMULA.edgeMax, act.edge ?? 0));
        out.acts.push({ at, kind: 'act', skill: skill.skill, ...(act.why ? { why: act.why } : {}), pc: side(actor.character, skill.stat, skill.rank, edge, rules, skill.statHidden), foe });
    }
    for (const [at, entry] of (plan.foes ?? []).entries()) {
        if (entry.hold) continue;
        const foe = (sheet.foes ?? []).find(slot => slot.slot === entry.slot && slot.filled);
        const label = `${foe?.name ?? `Foe ${entry.slot}`} attacks ${entry.target}`;
        if (!foe) { refuse(`foe${entry.slot}`, `${label}: not rolled (that foe slot is empty).`); continue; }
        const defender = ready(entry.target);
        const stat = defender.refusal ? defender : statOf(defender.character, entry.defend);
        if (stat.refusal) { refuse(entry.target, `${label}: not rolled (${stat.refusal}).`); continue; }
        out.foes.push({ at, kind: 'foe', skill: null, pc: side(defender.character, entry.defend, 0, 0, rules), foe });
    }
    for (const [at, check] of (plan.checks ?? []).entries()) {
        const actor = ready(check.who);
        const label = `${check.who} — ${check.skill ?? check.stat?.toUpperCase() ?? 'check'}`;
        if (actor.refusal) { refuse(check.who, `${label}: not rolled (${actor.refusal}).`); continue; }
        const skill = skillFor(actor.character, check.skill, check);
        const stat = statOf(actor.character, skill.stat, skill.statHidden);
        if (stat.refusal) { refuse(check.who, `${label}: not rolled (${stat.refusal}).`, `${label}: not rolled (${stat.plain ?? stat.refusal}).`); continue; }
        if (skill.refused) refuse(check.who, skill.refused, skill.refusedPlain);
        out.checks.push({ at, kind: 'check', skill: skill.skill, difficulty: check.difficulty, dc: LIMITS.dc[check.difficulty], pc: side(actor.character, skill.stat, skill.rank, 0, rules, skill.statHidden) });
    }
    const foeSide = foe => ({ slot: foe.slot, name: foe.name, base: rules.foeBase, classValue: foe.class, classBonus: rules.classWeight * foe.class });
    for (const entry of [...out.acts, ...out.foes]) entry.foe = foeSide(entry.foe);
    // (Where an action stands in the plan is for its dice; the witness is the sheet numbers only, as it always was.)
    // Whether a stat is hidden is not a sheet number: it changes what the cue says, never the dice (review 164).
    const bare = list => list.map(({ at: _, ...entry }) => ({ ...entry, pc: (({ statHidden: _hidden, ...pc }) => pc)(entry.pc) }));
    out.witness = { acts: bare(out.acts), foes: bare(out.foes), checks: bare(out.checks), refused: out.refused };
    return out;
}

const rolled = (entry, pcDie, foeDie, rules) => {
    const pcTotal = pcDie + entry.pc.statBonus + entry.pc.classBonus + entry.pc.rank + entry.pc.edge;
    const line = { kind: entry.kind, skill: entry.skill, ...(entry.why ? { why: entry.why } : {}), pc: { ...entry.pc, die: pcDie, total: pcTotal } };
    if (entry.kind === 'check') return { ...line, difficulty: entry.difficulty, dc: entry.dc, outcome: outcomeOf(pcDie, pcTotal, entry.dc, rules) };
    const foeTotal = foeDie + entry.foe.base + entry.foe.classBonus;
    const decisive = [pcDie, foeDie].some(die => die === 1 || die === FORMULA.die) || Math.abs(pcTotal - foeTotal) >= rules.decisiveMargin;
    return { ...line, foe: { ...entry.foe, die: foeDie, total: foeTotal }, outcome: outcomeOf(pcDie, pcTotal, foeTotal, rules), decisive };
};

/**
 * The dice of one roll, one stream per planned action: `streams(kind, at)` → a function that gives that action's next d20 (1–20),
 * `kind` 'act', 'foe' or 'check' and `at` the action's index in the plan's list of that kind. `base` is one number drawn from the
 * receipt's seed; each action's stream is seeded from it and the action's place, so the streams never depend on one another.
 */
export function positionalDice(base) {
    const KIND = { act: 1, foe: 2, check: 3 };
    return Object.assign((kind, at) => {
        const random = seededRandom((base ^ Math.imul(KIND[kind] * 64 + at + 1, 0x9E3779B1)) >>> 0);
        return () => 1 + Math.floor(random() * FORMULA.die);
    }, { positional: true });
}

/**
 * Rolls a prepared plan: `source` is positionalDice's answer (each action draws from its own stream), or, for a roll of the earlier
 * scheme, one `roll()` that gives every d20 in turn (the checks first, then each round's actions in order). → { checks, rounds,
 * stop, text, summary } with the rounds already cut to the stop and the cue budget (the dice of rounds that are cut were drawn and
 * are dropped). `rules` are the numbers in force (default: Standard); the most rounds is `rules.roundCap`. `earlier`: the cue is fitted as it
 * was for a roll of the earlier scheme (cue.js fitCue), so that its rounds and stop never change.
 */
export function rollPrepared(plan, prepared, source, rules = STANDARD, { earlier = false } = {}) {
    const own = new Map();
    const diceOf = entry => {
        if (source.positional !== true) return source;
        if (!own.has(entry)) own.set(entry, source(entry.kind, entry.at ?? 0));
        return own.get(entry);
    };
    const checks = prepared.checks.map(entry => { const roll = diceOf(entry); return rolled(entry, roll(), 0, rules); });
    const fight = [...prepared.acts, ...prepared.foes];
    const most = fight.length ? Math.min(PACE[plan.pace], rules.roundCap) : 0;
    const all = [];
    for (let n = 1; n <= most; n += 1) {
        const lines = fight.map(entry => { const roll = diceOf(entry); return rolled(entry, roll(), roll(), rules); });
        const decisive = lines.some(line => line.decisive);
        all.push({ n, decisive, lines: lines.map(({ decisive: _, ...line }) => line) });
        if (decisive) break;
    }
    const refused = prepared.refused.map(entry => entry.text);
    const cue = fitCue({ checks, rounds: all, refused, plainRefused: prepared.plainRefused, decisive: all.length > 0 && all.at(-1).decisive }, undefined, { earlier });
    const fits = cue.count;
    const rounds = all.slice(0, fits);
    const decisive = rounds.length > 0 && rounds.at(-1).decisive;
    const stop = !rounds.length ? 'none' : fits < all.length ? 'budget' : decisive ? 'decisive' : rounds.length === PACE[plan.pace] ? 'pace' : 'cap';
    const text = cue.text;
    return { checks, rounds, stop, text, summary: summaryOf(checks, rounds, prepared.refused) };
}

// "Rolled for you: N exchanges": one entry per action of the plan with its outcome in each round told.
function summaryOf(checks, rounds, refused) {
    const acts = [];
    const entry = (line, target) => ({ kind: line.kind, who: line.kind === 'foe' ? line.foe.name : line.pc.who, target, skill: line.skill, stat: line.pc.stat, outcomes: [] });
    for (const line of checks) acts.push({ ...entry(line, null), outcomes: [line.outcome] });
    const index = new Map();
    for (const round of rounds) round.lines.forEach((line, at) => {
        if (!index.has(at)) { index.set(at, acts.length); acts.push(entry(line, line.kind === 'foe' ? line.pc.who : line.foe.name)); }
        acts[index.get(at)].outcomes.push(line.outcome);
    });
    return { exchanges: rounds.length, acts, refused: refused.length };
}

const guardOf = (ctx, predicate, witness) => ({ owner: ctx.module, version: 2, epoch: ctx.epoch, rulesHash: null, predicate, inputHash: ctx.hash({ source: ctx.source, predicate, witness }) });

/**
 * `rpg.resolve { key, plan }`: the command (a prelude: turn.js previews it with a seed and stores it on the generated
 * reply with the same seed). `key` is the reader's message (its index and a hash of its text), as Assist's pre-roll keys it.
 */
export function resolve(ctx, payload = {}) {
    if (ctx.cause !== 'system' || ctx.caller !== null) ctx.fail('REFUSED', 'Rolls are made by Story Block before a reply, not by an action.');
    const key = String(payload?.key ?? '');
    if (!KEY.test(key)) ctx.fail('INVALID', 'A roll needs the key of the message it was made for.');
    const checked = validatePlan(payload?.plan);
    if (!checked.ok) ctx.fail('INVALID', `That is not a plan: ${checked.errors[0]}`);
    const plan = payload.plan;
    // The numbers this roll is made with are the ones the payload carries (chosen when it was planned, from the settings of that
    // moment); a Re-read, a rebuild and a reload run the same payload, so they roll with them again. The settings are never read here.
    const rules = normalizeRules(payload.rules);
    const sheet = readSheet({ domains: { dataModules: ctx.read('dataModules') } });
    const prepared = prepare(plan, sheet, rules);
    if (!prepared.acts.length && !prepared.foes.length && !prepared.checks.length) ctx.fail('NO_LONGER_DONE', 'Nothing is left to roll on this sheet.');
    if (!ctx.claim(claimKey(key))) ctx.fail('CLAIMED', 'This message has already been rolled for.');
    // A roll that asks for the dice version draws one number from the seed, and each action's dice come from that and its place in
    // the plan; one made before has no version and draws its dice in one sequence, as it did.
    const source = payload.dice === DICE_VERSION ? positionalDice(Math.floor(ctx.rng() * 4294967296) >>> 0) : () => ctx.roll(`d${FORMULA.die}`).total;
    const dice = rollPrepared(plan, prepared, source, rules, { earlier: payload.dice !== DICE_VERSION });
    const predicate = { kind: RESOLVE, key, plan: ctx.hash(plan), rules: ctx.hash(rules) };
    ctx.replayGuard(guardOf(ctx, predicate, prepared.witness), { key, plan, rules });
    const result = {
        v: RESULT_VERSION, key, pace: plan.pace, rules, stop: dice.stop, checks: dice.checks, rounds: dice.rounds,
        refused: prepared.refused, summary: dice.summary,
    };
    return { summary: dice.text, narrate: true, replan: true, data: { v2: { key: claimKey(key), result } } };
}

/**
 * The replay guard (docs/v2/REPLAY.md): the roll stands while the sheet numbers it used are what the prefix holds. Pure:
 * the state before the block and what it recorded, nothing else.
 */
export function leanRpgGuard({ state, hash }, { guard, source, recorded }) {
    const bad = reason => ({ ok: false, reason });
    try {
        const predicate = guard?.predicate;
        if (guard?.version !== 2 || guard.rulesHash !== null || !isObject(predicate) || predicate.kind !== RESOLVE) return bad('Malformed roll guard.');
        if (!isObject(recorded) || !validatePlan(recorded.plan).ok || hash(recorded.plan) !== predicate.plan || recorded.key !== predicate.key) return bad('The roll\'s plan was damaged.');
        // The numbers are the ones recorded with the roll, not today's settings; damaged numbers are not guessed at.
        // A roll recorded before the numbers were kept has none: it was made with Standard's.
        const rules = normalizeRules(recorded.rules);
        const kept = recorded.rules !== undefined || predicate.rules !== undefined;
        if (kept && (hash(recorded.rules ?? null) !== hash(rules) || hash(rules) !== predicate.rules)) return bad('The roll\'s numbers were damaged.');
        const witness = prepare(recorded.plan, readSheet(state), rules).witness;
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
