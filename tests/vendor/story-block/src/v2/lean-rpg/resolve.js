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
// Standard moves the real bars; Classic (where the narrator sets the bars) keeps a count of its own for the stop only: a hit takes 1 stage, a
// decisive one 2, from the sheet's Health and the foes' Health, and writes nothing.
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
// The Standard formula (rules.formula 'standard') rolls in standard.js, which documents its own additions to this record: typed lines, the
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
import { FIGHT, FIX_VERSION, FORMULA, LEVEL, LIMITS, LV_VERSION, PACE, PRACTICE_STEP, RESOLVE, STAGES, practiceOf } from './names.js';
import { fightGuard } from './fight.js';
import { practiceGuard } from './practice.js';
import { classTerm, EARLIER_RULES, hasLevels, isStandard, normalizeRules, STANDARD, statShare } from './rules.js';
import { prepareStandard, rollStandard, summaryStd } from './standard.js';
import { cueOfResult, fitCue } from './cue.js';
import { matchCharacter, matchFoe, matchSkill, readSheet, strongestStat } from './read.js';
import { validatePlan } from './plan.js';
import { openFoes } from './open.js';
import { levelBonus } from './formula.js';
import { applyGear, earnedLegend, gearMarkOf, gearMatches, gearValid, noteGear, planGear, wearGear } from './gear.js';
import { condWord, stepDown } from '../domains/gear.js';
import { partyLevels, averageLevel, settleOpen } from './foes.js';
import { rng as seededRandom } from '../rng.js';
import { ambushOf, ambushRecord, ambushedClassic, carriedFrom } from './ambush.js';

export const RESULT_VERSION = 1;
/** The version of the dice scheme a payload asks for (`dice` in the payload of `rpg.resolve`): 2 = dice per action position. */
export const DICE_VERSION = 2;
/** The version of the rule a reply's exchanges stop by (`flow` in the payload of `rpg.resolve`): 2 = until won, lost, heavy, the cap or the budget (see the top). */
export const FLOW_VERSION = 2;
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
        who: character.who, stat, statBonus: statShare(value, rules),
        ...classTerm(rules, character), rank, edge,
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
export function prepare(plan, sheet, rules = STANDARD, options = {}) {
    if (isStandard(rules)) return prepareStandard(plan, sheet, rules, options);
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
        // The follow-up skill of mark 3 (plan.js `then:`): rounds 2 on roll with it; one that cannot be rolled (no stat on the sheet) is left out, and says nothing.
        const next = options.then && act.then ? skillFor(actor.character, act.then, act) : null;
        const later = next && !statOf(actor.character, next.stat, next.statHidden).refusal ? { skill: next.skill, pc: side(actor.character, next.stat, next.rank, edge, rules, next.statHidden) } : null;
        out.acts.push({ at, kind: 'act', skill: skill.skill, ...(act.why ? { why: act.why } : {}), pc: side(actor.character, skill.stat, skill.rank, edge, rules, skill.statHidden), ...(later ? { then: later } : {}), foe });
    }
    for (const [at, entry] of (plan.foes ?? []).entries()) {
        if (entry.hold) continue;
        const foe = (sheet.foes ?? []).find(slot => slot.slot === entry.slot && slot.filled);
        const label = `${foe?.name ?? `Foe ${entry.slot}`} attacks ${entry.target}`;
        if (!foe) { refuse(`foe${entry.slot}`, `${label}: not rolled (that foe slot is empty).`); continue; }
        const defender = ready(entry.target);
        if (defender.refusal) { refuse(entry.target, `${label}: not rolled (${defender.refusal}).`); continue; }
        // A skill the defender has counts like an act's: its own stat wins over `defend`, its rank adds, an Empty resource rolls without it.
        const skill = skillFor(defender.character, entry.skill, { stat: entry.defend });
        const stat = statOf(defender.character, skill.stat, skill.statHidden);
        if (stat.refusal) { refuse(entry.target, `${label}: not rolled (${stat.refusal}).`, `${label}: not rolled (${stat.plain ?? stat.refusal}).`); continue; }
        if (skill.refused) refuse(entry.target, skill.refused, skill.refusedPlain);
        out.foes.push({ at, kind: 'foe', skill: skill.skill, pc: side(defender.character, skill.stat, skill.rank, 0, rules, skill.statHidden), foe });
    }
    for (const [at, check] of (plan.checks ?? []).entries()) {
        const actor = ready(check.who);
        const label = `${check.who} — ${check.skill ?? check.stat?.toUpperCase() ?? 'check'}`;
        if (actor.refusal) { refuse(check.who, `${label}: not rolled (${actor.refusal}).`); continue; }
        const skill = skillFor(actor.character, check.skill, check);
        const stat = statOf(actor.character, skill.stat, skill.statHidden);
        if (stat.refusal) { refuse(check.who, `${label}: not rolled (${stat.refusal}).`, `${label}: not rolled (${stat.plain ?? stat.refusal}).`); continue; }
        if (skill.refused) refuse(check.who, skill.refused, skill.refusedPlain);
        out.checks.push({ at, kind: 'check', skill: skill.skill, ...(check.ambush === true ? { ambush: true } : {}), difficulty: check.difficulty, dc: LIMITS.dc[check.difficulty], pc: side(actor.character, skill.stat, skill.rank, 0, rules, skill.statHidden) });
    }
    // (From a roll of the Levels rules, `options.lv`, a foe adds floor(level / divisor); else classWeight × class, as it did.)
    const foeSide = foe => (options.lv
        ? { slot: foe.slot, name: foe.name, base: rules.foeBase, classValue: foe.level, classBonus: levelBonus(foe.level, rules.levelDivisor) }
        : { slot: foe.slot, name: foe.name, base: rules.foeBase, classValue: foe.class, classBonus: rules.classWeight * foe.class });
    for (const entry of [...out.acts, ...out.foes]) entry.foe = foeSide(entry.foe);
    // (Where an action stands in the plan is for its dice; the witness is the sheet numbers only, as it always was.)
    // Whether a stat is hidden is not a sheet number: it changes what the cue says, never the dice (review 164).
    const bare = list => list.map(({ at: _, ...entry }) => ({ ...entry, pc: (({ statHidden: _hidden, ...pc }) => pc)(entry.pc) }));
    out.witness = { acts: bare(out.acts).map(entry => (entry.then ? { ...entry, then: { ...entry.then, pc: (({ statHidden: _hidden, ...pc }) => pc)(entry.then.pc) } } : entry)), foes: bare(out.foes), checks: bare(out.checks), refused: out.refused };
    // The flow of stage 49 stops by the bars, so the roll depends on them: they join the witness (a roll of the earlier flow has none, as it never did).
    if (options.flow === FLOW_VERSION) {
        out.roster = classicRoster(sheet);
        out.witness = { ...out.witness, roster: { characters: out.roster.characters.map(({ id, name, value, size }) => ({ id, name, value, size })), foes: out.roster.foes.map(({ id, name, value, size }) => ({ id, name, value, size })) } };
    }
    return out;
}

// The sheet as bars for Classic's stop count (flow 2): the characters (a dead one is Down) and the filled foe groups, at their Health as the sheet has it.
// A Classic block's Health is 0 to 5 stages (a Standard block under Classic rules has its own number of blocks); a Health that cannot be read counts as full.
function classicRoster(sheet) {
    const held = (value, size) => (Number.isInteger(value) ? Math.max(0, Math.min(size, value)) : size);
    return {
        characters: sheet.characters.map(character => {
            const size = character.size?.health ?? 5;
            return { id: `c:${character.key}`, name: character.who, value: character.alive === false ? 0 : held(character.health, size), size };
        }),
        foes: sheet.foes.filter(foe => foe.filled).map(foe => {
            const size = foe.size ?? 5;
            return { id: `f:${foe.slot}`, slot: foe.slot, name: foe.name, value: held(foe.hurt, size), size };
        }),
    };
}

// From round 2 an act with a `then:` skill rolls with it (Classic): the dice are the entry's own, drawn before this is asked.
const laterOf = (entry, round) => (round > 1 && entry.then ? (({ then, ...rest }) => ({ ...rest, ...then }))(entry) : entry);

const rolled = (entry, pcDie, foeDie, rules) => {
    const pcTotal = pcDie + entry.pc.statBonus + entry.pc.classBonus + entry.pc.rank + entry.pc.edge;
    const line = { kind: entry.kind, skill: entry.skill, ...(entry.ambush === true ? { ambush: true } : {}), ...(entry.why ? { why: entry.why } : {}), pc: { ...entry.pc, die: pcDie, total: pcTotal } };
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
    // (`init` and `open`: the Standard formula's turn order and opening action; Classic never draws them.)
    const KIND = { act: 1, foe: 2, check: 3, init: 4, open: 5 };
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
export function rollPrepared(plan, prepared, source, rules = STANDARD, { earlier = false, carried = null, flow = 1, wearOf = null, drop = null, opened = null, fix = false, then = false } = {}) {
    // (`fix`: a roll of stage 65, FIX_VERSION; `then`: of mark 3; without it the cue is told exactly as before, because its length decides how many rounds are told)
    if (isStandard(rules)) return rollStandard(plan, prepared, source, rules, { carried, flow, wearOf, drop, opened, fix, then });
    const own = new Map();
    const diceOf = entry => {
        if (source.positional !== true) return source;
        if (!own.has(entry)) own.set(entry, source(entry.kind, entry.at ?? 0));
        return own.get(entry);
    };
    const checks = prepared.checks.map(entry => { const roll = diceOf(entry); return rolled(entry, roll(), 0, rules); });
    const fight = [...prepared.acts, ...prepared.foes];
    if (flow === FLOW_VERSION && source.positional === true && prepared.roster) return rollClassicFlow(plan, prepared, checks, fight, diceOf, rules, wearOf, drop, opened, fix);
    const most = fight.length ? Math.min(PACE[plan.pace], rules.roundCap) : 0;
    const all = [];
    const ambush = ambushOf(checks, drop, fight.some(entry => entry.kind === 'act'));
    for (let n = 1; n <= most; n += 1) {
        const lines = fight.map(entry => { const roll = diceOf(entry); return rolled(ambushedClassic(laterOf(entry, n), n, ambush), roll(), roll(), rules); });
        const decisive = lines.some(line => line.decisive);
        all.push({ n, decisive, lines: lines.map(({ decisive: _, ...line }) => line) });
        if (decisive) break;
    }
    const refused = prepared.refused.map(entry => entry.text);
    const cue = fitCue({ checks, rounds: all, refused, plainRefused: prepared.plainRefused, decisive: all.length > 0 && all.at(-1).decisive, ...(wearOf ? { wearOf } : {}), ...(fix && opened?.length && !earlier ? { opened } : {}), ...(fix && ambush?.carried ? { carriedDrop: true } : {}), ...(fix ? {} : { legacy: true }) }, undefined, { earlier });
    const fits = cue.count;
    const rounds = all.slice(0, fits);
    const decisive = rounds.length > 0 && rounds.at(-1).decisive;
    const stop = !rounds.length ? 'none' : fits < all.length ? 'budget' : decisive ? 'decisive' : rounds.length === PACE[plan.pace] ? 'pace' : 'cap';
    const text = cue.text;
    return { checks, rounds, stop, text, shape: cue.shape, summary: summaryOf(checks, rounds, prepared.refused), ...ambushRecord(ambush, checks, fight) };
}

// Classic under the flow of stage 49: the rounds go on until the fight is won, lost or heavy, the cap or the careful pace (see the top). `checks` and `fight`
// are already made; `diceOf` gives an action's stream. The bars are a count for the stop only (nothing is written): a hit by the party member (success or at
// a cost) takes 1 stage from the foe group, one by the foe (the defender fails) 1 from the defender, 2 when the winner's natural 20, the loser's natural 1 or
// a lead of the decisive margin made it (Standard's judge). An action whose party member or foe group is Down does not act (its dice are drawn all the same).
function rollClassicFlow(plan, prepared, checks, fight, diceOf, rules, wearOf = null, drop = null, opened = null, fix = false) {
    const bars = new Map([...prepared.roster.characters, ...prepared.roster.foes].map(bar => [bar.id, { ...bar }]));
    const chars = prepared.roster.characters, foesHere = prepared.roster.foes;
    const charOf = who => chars.find(bar => bar.name === who);
    const standing = id => (bars.get(id)?.value ?? 0) > 0;
    const most = fight.length ? (plan.pace === 'careful' ? 1 : rules.roundCap) : 0;
    const all = [];
    const ambush = ambushOf(checks, drop, fight.some(entry => entry.kind === 'act'));
    for (let n = 1; n <= most; n += 1) {
        const lines = [], idle = [];
        const said = (id, who, kind, why) => { if (!idle.some(item => item.id === id && item.why === why)) idle.push({ n, id, who, kind, why }); };
        for (const entry of fight) {
            const roll = diceOf(entry), pcDie = roll(), foeDie = roll();
            const me = charOf(entry.pc.who), mine = bars.get(me?.id), theirs = bars.get(`f:${entry.foe.slot}`);
            if (!mine || !theirs) continue;
            if (entry.kind === 'act') {
                if (!standing(mine.id)) { said(mine.id, mine.name, 'char', 'down'); continue; }
                if (!standing(theirs.id)) { said(mine.id, mine.name, 'char', 'no-target'); continue; }
            } else {
                if (!standing(theirs.id)) { said(theirs.id, theirs.name, 'foe', 'beaten'); continue; }
                if (!standing(mine.id)) { said(theirs.id, theirs.name, 'foe', 'no-target'); continue; }
            }
            const line = rolled(ambushedClassic(laterOf(entry, n), n, ambush), pcDie, foeDie, rules);
            const pcTotal = line.pc.total, foeTotal = line.foe.total;
            const hit = entry.kind === 'act' ? line.outcome !== 'fail' : line.outcome === 'fail';
            if (hit) {
                const strong = entry.kind === 'act' ? pcDie === FORMULA.die || foeDie === 1 || pcTotal - foeTotal >= rules.decisiveMargin
                    : foeDie === FORMULA.die || pcDie === 1 || foeTotal - pcTotal >= rules.decisiveMargin;
                const target = entry.kind === 'act' ? theirs : mine;
                target.value = Math.max(0, target.value - (strong ? 2 : 1));
            }
            lines.push(line);
        }
        const lost = !chars.some(bar => standing(bar.id)), won = !foesHere.some(bar => standing(bar.id));
        const heavy = chars.some(bar => bar.value > 0 && (bar.value - bars.get(bar.id).value >= 2 || !standing(bar.id)));
        const end = lost ? 'lost' : won ? 'won' : heavy ? 'heavy' : null;
        all.push({ n, decisive: lines.some(line => line.decisive), ...(end ? { end } : {}), lines: lines.map(({ decisive: _, ...line }) => line), ...(idle.length ? { idle } : {}) });
        if (end) break;
    }
    const refused = prepared.refused.map(entry => entry.text);
    const cue = fitCue({ checks, rounds: all, refused, plainRefused: prepared.plainRefused, decisive: false, flow: FLOW_VERSION, end: all.at(-1)?.end ?? null, ...(wearOf ? { wearOf } : {}), ...(fix && opened?.length ? { opened } : {}), ...(fix && ambush?.carried ? { carriedDrop: true } : {}), ...(fix ? {} : { legacy: true }) });
    const told = all.slice(0, cue.count);
    const rounds = told.map(({ end: _, ...round }) => round);
    const stop = !told.length ? 'none' : cue.count < all.length ? 'budget' : told.at(-1).end ?? (plan.pace === 'careful' ? 'pace' : 'cap');
    return { checks, rounds, stop, text: cue.text, shape: cue.shape, summary: summaryStd(checks, rounds, prepared.refused), ...ambushRecord(ambush, checks, fight) };
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

// The most a block's own field holds (the pinned definition's `max`): a Classic block under the Standard formula holds at most 5 Health stages.
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
// The flow a payload asks for: FLOW_VERSION only when it says so and the dice are by position (a roll of the earlier dice scheme stops as it did).
const flowOf = (asked, positional) => (asked === FLOW_VERSION && positional ? FLOW_VERSION : 1);

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
    const order = orderOf(payload.order);
    // A drop an earlier reply's ambush check gave (precall.js carries it in the payload, as it does a fight's turn order): spent on this roll's acts.
    const drop = carriedFrom(payload.ambush);
    // The numbers this roll is made with are the ones the payload carries (chosen when it was planned, from the settings of that
    // moment); a Re-read, a rebuild and a reload run the same payload, so they roll with them again. The settings are never read here.
    const rules = levelledRules(rulesOfPayload(payload.rules), payload.lv);
    const lv = hasLevels(rules) ? LV_VERSION : undefined;
    // The flow of stage 49 is asked for by the payload (precall.js) and needs the dice by position; a roll made before has none and stops as it did.
    const std = isStandard(rules);
    const flow = flowOf(payload.flow, payload.dice === DICE_VERSION || std);
    // A fight the pre-call opened (open.js): its foes are put in free slots of the Foes block first, through the block's own set-slot kind, and the
    // roll is made on the sheet that leaves. A plan with no `open` reads the block as it stands, as ever.
    // From the Levels rules (`lv` in the payload) each foe has a level: the one the plan gave, or one drawn inside a rank's band or near the party's average level,
    // from the reply's own seed (the first number it gives, which the dice by position then use as well), so a swipe draws anew and a Re-read keeps it.
    const positional = payload.dice === DICE_VERSION || std;
    const base = positional ? Math.floor(ctx.rng() * 4294967296) >>> 0 : null;
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
    if (!prepared.acts.length && !prepared.foes.length && !prepared.checks.length) ctx.fail('NO_LONGER_DONE', 'Nothing is left to roll on this sheet.');
    if (!ctx.claim(claimKey(key))) ctx.fail('CLAIMED', 'This message has already been rolled for.');
    // A roll that asks for the dice version draws one number from the seed, and each action's dice come from that and its place in
    // the plan; one made before has no version and draws its dice in one sequence, as it did.
    const source = positional ? positionalDice(base) : () => ctx.roll(`d${FORMULA.die}`).total;
    const dice = rollPrepared(plan, prepared, source, rules, { earlier: payload.dice !== DICE_VERSION && !std, carried: order, drop, opened: opened ?? null, fix: fix >= 2, then: fix >= 3, flow, wearOf: gear ? (rounds, opening) => wearGear(ctx, gear, { opening, rounds, rules, condWord, stepDown }) : null });
    // From stage 50 a payload may carry the practice per skill use (practice.js); a roll made before has none and gives none.
    const practice = practiceOf(payload.practice) ?? undefined;
    // Gear: each told line names what it rolled with, and a decisive hit taken or miss made wears a piece (gear.js); the wear is part of the roll's receipt.
    let wear = [], legend = false;
    if (gear) {
        noteGear([...dice.checks, ...(dice.opening ?? []), ...dice.rounds.flatMap(round => round.lines)], gear);
        wear = wearGear(ctx, gear, { opening: dice.opening ?? [], rounds: dice.rounds, rules, condWord });
        legend = earnedLegend(dice, sheet, lv === LV_VERSION);
    }
    const predicate = { kind: RESOLVE, key, plan: ctx.hash(plan), rules: ctx.hash(rules), ...(order ? { order: ctx.hash(order) } : {}), ...(drop ? { ambush: ctx.hash(drop) } : {}), ...(flow === FLOW_VERSION ? { flow } : {}), ...(fix ? { fix } : {}), ...(practice ? { practice } : {}), ...(lv ? { lv } : {}), ...(settled ? { levels: ctx.hash(levelsOf(settled)) } : {}), ...(gear ? { gear: ctx.hash(gear) } : {}) };
    ctx.replayGuard(guardOf(ctx, predicate, prepared.witness), { key, plan, rules, ...(order ? { order } : {}), ...(drop ? { ambush: drop } : {}), ...(flow === FLOW_VERSION ? { flow } : {}), ...(fix ? { fix } : {}), ...(practice ? { practice } : {}), ...(lv ? { lv } : {}), ...(settled ? { levels: levelsOf(settled) } : {}), ...(gear ? { gear } : {}) });
    const result = {
        v: RESULT_VERSION, key, pace: plan.pace, rules, ...(flow === FLOW_VERSION ? { flow } : {}), ...(fix ? { fix } : {}), ...(practice ? { practice } : {}), ...(lv ? { lv } : {}), ...(gear ? { gear } : {}), stop: dice.stop, checks: dice.checks, rounds: dice.rounds,
        refused: prepared.refused, summary: dice.summary, ...(dice.ambush ? { ambush: dice.ambush } : {}), ...(opening ? { opened } : {}), ...(wear.length ? { wear } : {}), ...(legend ? { legend: 1 } : {}),
        ...(std ? { order: dice.order, quickStart: dice.quickStart, opening: dice.opening, idle: dice.idle, hurts: dice.hurts } : {}),
    };
    if (std) writeBars(ctx, dice.hurts);
    // From stage 51 the receipt keeps no copy of the cue text: it is rebuilt from the record (cue.js cueOfResult) wherever it is told or shown. The text is
    // kept as it always was only if the record would not give back exactly the same bytes (so what is told never changes).
    // (with gear the wear lines were fitted into the cue's budget with the dice (cue.js fitCue `wearOf`); what was really worn is in the record, so the text is the record's)
    if (gear) dice.text = cueOfResult(result, dice.shape);
    const text = cueOfResult(result, dice.shape) === dice.text ? '' : dice.text;
    // (the shape the cue was fitted to is kept beside the record, not in it: a roll made before it is replanned without its record changing)
    return { summary: text, narrate: true, replan: true, data: { v2: { key: claimKey(key), result, ...(dice.shape ? { shape: dice.shape } : {}) } } };
}

/**
 * The replay guard (docs/v2/REPLAY.md): the roll stands while the sheet numbers it used are what the prefix holds. Pure:
 * the state before the block and what it recorded, nothing else.
 */
export function leanRpgGuard({ state, hash }, { guard, source, recorded }) {
    const bad = reason => ({ ok: false, reason });
    if (guard?.predicate?.kind === FIGHT) return fightGuard({ state, hash }, { guard, source, recorded });
    if (guard?.predicate?.kind === PRACTICE_STEP) return practiceGuard({ state, hash }, { guard, source, recorded });
    try {
        const predicate = guard?.predicate;
        if (guard?.version !== 2 || guard.rulesHash !== null || !isObject(predicate) || predicate.kind !== RESOLVE) return bad('Malformed roll guard.');
        if (!isObject(recorded) || !validatePlan(recorded.plan).ok || hash(recorded.plan) !== predicate.plan || recorded.key !== predicate.key) return bad('The roll\'s plan was damaged.');
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
        // The turn order a Standard roll was given (carried from the fight's earlier reply) is hashed with it; Classic has none.
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
