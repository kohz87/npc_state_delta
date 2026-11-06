// Classic sheet preparation and the roll primitives shared with Standard; resolve.js keeps the roll flow, record and guard.
// The plan against the sheet, its Classic stop bars, one dice stream per planned action and the flow version.

import { FORMULA, LIMITS, STAGES } from '../names.js';
import { prepareStandard } from '../standard.js';
import { classTerm, isStandard, STANDARD, statShare } from '../rules.js';
import { matchCharacter, matchFoe, matchSkill, strongestStat } from '../read.js';
import { levelBonus } from '../formula.js';
import { rng as seededRandom } from '../../rng.js';

/** The version of the rule a reply's exchanges stop by (`flow` in the payload of `rpg.resolve`): 2 = until won, lost, heavy, the cap or the budget (see the top). */
export const FLOW_VERSION = 2;
const cap = word => word.charAt(0).toUpperCase() + word.slice(1);

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
export const laterOf = (entry, round) => (round > 1 && entry.then ? (({ then, ...rest }) => ({ ...rest, ...then }))(entry) : entry);

export const rolled = (entry, pcDie, foeDie, rules) => {
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
