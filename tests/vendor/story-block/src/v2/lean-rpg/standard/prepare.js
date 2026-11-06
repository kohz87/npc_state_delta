// The Standard formula's preparation: prepareStandard and its helpers turn a plan and sheet into acts, foe sides, checks,
// refusals and the witness. It reads the bars from roster.js; the roll itself is roll.js.
import { edgeWithLuck, levelBonus, luckWindow, statPart } from '../formula.js';
import { FORMULA, LIMITS, STAGES } from '../names.js';
import { matchCharacter, matchFoe, matchSkill } from '../read.js';
import { classTerm, hasLevels } from '../rules.js';
import { prepareFoes } from '../standard-foes.js';
import { charId, rosterOf } from './roster.js';

const cap = word => word.charAt(0).toUpperCase() + word.slice(1);

// ---- preparing --------------------------------------------------------------------------------------------------------

const TYPE_FREE = ['social', 'check'];

// A skill phrase on a character's sheet: { skill, rank, stat, uses, refused? }. A skill the character has brings its own stat (when it has one)
// and resource; a skill they lack, or one whose resource is Empty, is rolled untrained: no skill, rank 0, the type's own stat.
function skillStd(character, phrase, planned) {
    if (!phrase) return { skill: null, rank: 0, stat: null, uses: null };
    const found = matchSkill(character, phrase);
    const say = (fields, text) => ({ ...fields, refused: text(false), refusedPlain: text(true) });
    if (!found) return say({ skill: null, rank: 0, stat: null, uses: null }, () => `${character.who} has no skill called ${phrase}: rolled untrained.`);
    const resource = found.uses ?? (planned.uses === 'mana' ? 'mana' : 'stamina');
    const hiddenStat = found.stat && (found.hidden ?? []).includes('stat') ? { statHidden: true } : {};
    if (character[resource] === 0) {
        const hidden = Boolean(found.uses) && (found.hidden ?? []).includes('uses');
        return say({ skill: null, rank: 0, stat: null, uses: resource, spentName: found.name }, plain => `${character.who} cannot use ${found.name}${hidden && !plain ? '' : ` (${cap(resource)} ${STAGES[resource][0]})`}: rolled without it.`);
    }
    return { skill: found.name, rank: found.rank, stat: found.stat ?? null, uses: resource, ...hiddenStat };
}

// The type an action rolls: the plan's social, check or defence; otherwise the skill's resource decides (mana is magic, stamina physical);
// with no skill the plan's physical or magic, else physical.
function typeOf(planned, skill) {
    if (TYPE_FREE.includes(planned.type)) return planned.type;
    if (skill.skill && skill.uses) return skill.uses === 'mana' ? 'magic' : 'physical';
    return planned.type === 'magic' ? 'magic' : 'physical';
}

// The party member's side of a roll (no die yet): statPart's pair, the Soul Class, the rank and the edge after luck.
function sideStd(character, type, skill, { fit = null, edge = 0, againstMagic = false } = {}, rules) {
    const part = statPart(type, character.stats, { skillStat: skill.stat, fittingStat: fit, againstMagic });
    const situation = Math.max(-FORMULA.edgeMax, Math.min(FORMULA.edgeMax, edge ?? 0));
    const window = luckWindow(character.stats.luk);
    return {
        who: character.who, type, stat: part.main, second: part.second, mainValue: character.stats[part.main] ?? null, secondValue: character.stats[part.second] ?? null,
        statBonus: part.value, ...(part.style ? { style: part.style } : {}), ...classTerm(rules, character),
        rank: skill.rank, window, situation, edge: edgeWithLuck(situation, character.stats.luk),
        ...(skill.statHidden || (character.hidden ?? []).includes(part.main) ? { statHidden: true } : {}),
    };
}

/**
 * The plan against the sheet under Standard `rules`: what can be rolled, what is refused, the witness (every sheet number the roll
 * depends on, which the replay guard asks again) and the roster (the bars). → { acts, foes, checks, refused, plainRefused, witness, roster }
 */
export function prepareStandard(plan, sheet, rules, { maxOf = () => Infinity, lv = false, fix = false, then = false, memberRolls = null } = {}) {
    // (`then`: the mark of the follow-up skill, plan.js; without it an act's `then:` is not read.) (`fix`: the stage-65 fallback of a spent skill, see FIX_VERSION in open.js; a roll made before keeps the plain roll it had: the plan's own type, the skill's area, no `else:`)
    const out = { acts: [], foes: [], checks: [], refused: [], plainRefused: [] };
    const roster = rosterOf(sheet, maxOf);
    // A foe's side of the roll: from a roll of the Levels rules (`lv`) the foe adds floor(level / divisor), else foeClassWeight × class, as it did.
    const foeSide = foe => (lv
        ? { slot: foe.slot, name: foe.name, base: rules.foeBase, classValue: foe.level, classBonus: levelBonus(foe.level, rules.levelDivisor) }
        : { slot: foe.slot, name: foe.name, base: rules.foeBase, classValue: foe.class, classBonus: rules.foeClassWeight * foe.class });
    if (lv) for (const bar of roster.foes) bar.initiative = levelBonus(bar.foe.level, rules.levelDivisor);
    const refuse = (who, text, plain = text) => { out.refused.push({ who, text }); out.plainRefused.push(plain); };
    const ready = who => {
        const character = matchCharacter(sheet, who);
        if (!character) return { refusal: `no character called ${who}` };
        if (character.alive === false || character.health === 0) return { refusal: `${character.who} is Down` };
        return { character };
    };
    // Both stats of the roll must be on the sheet.
    const statsOf = (character, side) => {
        const missing = [side.stat, side.second].find(key => !Number.isInteger(character.stats[key]));
        if (!missing) return {};
        const plain = `${character.who} has no ${missing.toUpperCase()} on the sheet`;
        return { refusal: side.statHidden && missing === side.stat ? `${character.who} lacks the skill's stat` : plain, plain };
    };
    const skillSide = (character, skill, type, extra) => {
        const side = sideStd(character, type, skill, extra, rules);
        return { side, check: statsOf(character, side) };
    };
    // What the action rolls if its skill's resource runs out before its turn: no skill, rank 0, the type's own stat.
    const NONE = { skill: null, rank: 0, stat: null, uses: null };
    // (a plain roll is a weapon attack on one foe: `area: false`; its type is physical unless the plan asked for a social or check one, because a magic type
    // the planner wrote for a mana skill belonged to the skill, which is spent)
    const plainType = (planned, skill) => (skill.skill ? (TYPE_FREE.includes(planned.type) ? planned.type : 'physical') : typeOf(planned, NONE));
    const withSkill = (skill, character, type, extra, typeBare = type, alt = null) => (skill.skill
        ? { uses: skill.uses, plain: { type: typeBare, skill: null, uses: null, ...(fix ? { area: false } : {}), pc: sideStd(character, typeBare, NONE, extra, rules) }, ...(alt && fix ? { alt } : {}) } : {});
    // The act's `else:` skill (plan.js), used when the first skill's resource is spent and this one's is not: its own type, stat, rank and resource.
    const altOf = (character, act, extra) => {
        if (!act.else) return null;
        const skill = skillStd(character, act.else, {});
        if (!skill.skill) return null;
        const type = typeOf({}, skill);
        return { type, skill: skill.skill, uses: skill.uses, area: false, pc: sideStd(character, type, skill, extra, rules) };
    };
    // The act's `then:` skill (plan.js), the one rounds 2 on use: prepared like the first skill (its own type, stat, rank and resource; spent at the start it
    // goes on with the `else:` skill or a plain attack), but with no refusal text, as it is not told before its round. → the entry's changing fields, or null.
    const laterOf = (character, act) => {
        // (the follow-up rolls as the skill itself does, as an `else:` skill does: its own type, stat and resource, one foe; the act's area, type and resource hints belong to the first skill)
        const own = { edge: act.edge }, extra = { edge: act.edge };
        const skill = skillStd(character, act.then, own);
        const gone = !skill.skill && skill.spentName ? skill : null;
        const swap = gone ? altOf(character, act, extra) : null;
        const type = swap ? swap.type : gone ? 'physical' : typeOf({}, skill);
        const { side, check } = skillSide(character, skill, type, extra);
        if (check.refusal) return null;
        return { type, skill: swap ? swap.skill : skill.skill, ...(swap ? { uses: swap.uses } : {}), ...(gone ? { without: gone.spentName, withoutUses: gone.uses } : {}),
            ...withSkill(swap ? { skill: swap.skill, uses: swap.uses } : skill, character, type, extra, 'physical', altOf(character, act, extra)), area: false, pc: swap ? swap.pc : side };
    };
    for (const [at, act] of (plan.acts ?? []).entries()) {
        const actor = ready(act.who);
        const label = `${act.who} → ${act.target}`;
        if (actor.refusal) { refuse(act.who, `${label}: not rolled (${actor.refusal}).`); continue; }
        const support = act.support === true;
        const mate = support ? matchCharacter(sheet, act.target) : null;
        const foe = support ? null : matchFoe(sheet, act.target);
        if (support ? !mate : !foe) { refuse(act.who, `${label}: not rolled (no ${support ? 'character' : 'foe'} called ${act.target}).`); continue; }
        const skill = skillStd(actor.character, act.skill, act);
        // A skill whose resource is already empty before the reply (stage 65, `fix`): the action goes on with its `else:` skill when that one's resource is not empty,
        // else as a plain physical single-target attack; its refusal text is told only for the plain attack (an `else:` skill needs none).
        const spent = fix && !skill.skill && skill.spentName ? skill : null;
        const swap = spent ? altOf(actor.character, act, { fit: act.fit ?? act.stat, edge: act.edge }) : null;
        const type = swap ? swap.type : spent ? plainType(act, { skill: spent.spentName }) : typeOf(act, skill);
        const { side: ownSide, check } = skillSide(actor.character, skill, type, { fit: act.fit ?? act.stat, edge: act.edge });
        const side = swap ? swap.pc : ownSide;
        if (check.refusal) { refuse(act.who, `${label}: not rolled (${check.refusal}).`, `${label}: not rolled (${check.plain ?? check.refusal}).`); continue; }
        if (skill.refused && !swap) refuse(act.who, skill.refused, skill.refusedPlain);
        const entry = { at, kind: 'act', actor: charId(actor.character), type, skill: swap ? swap.skill : skill.skill, ...(swap ? { uses: swap.uses } : {}), ...(spent ? { without: spent.spentName, withoutUses: spent.uses, ...(swap ? {} : { area: false }) } : {}), ...withSkill(swap ? { skill: swap.skill, uses: swap.uses } : skill, actor.character, type, { fit: act.fit ?? act.stat, edge: act.edge }, fix ? plainType(act, skill) : typeOf(act, NONE), altOf(actor.character, act, { fit: act.fit ?? act.stat, edge: act.edge })), ...(act.why ? { why: act.why } : {}), pc: side };
        if (support) {
            out.acts.push({ ...entry, support: true, difficulty: act.difficulty, dc: LIMITS.dc[act.difficulty], target: { id: charId(mate), name: mate.who } });
        } else {
            const later = then && act.then ? laterOf(actor.character, act) : null;
            out.acts.push({ ...entry, ...(act.area === true && !spent ? { area: true } : {}), ...(act.group !== undefined ? { group: act.group } : {}),
                ...(later ? { then: later } : {}), foe: foeSide(foe) });
        }
    }
    prepareFoes({ plan, out, sheet, ready, refuse, skillStd, skillSide, withSkill, foeSide, charId, memberRolls });
    for (const [at, entry] of (plan.checks ?? []).entries()) {
        const actor = ready(entry.who);
        const label = `${entry.who} — ${entry.skill ?? entry.fit?.toUpperCase() ?? entry.stat?.toUpperCase() ?? 'check'}`;
        if (actor.refusal) { refuse(entry.who, `${label}: not rolled (${actor.refusal}).`); continue; }
        const skill = skillStd(actor.character, entry.skill, entry);
        const type = TYPE_FREE.includes(entry.type) ? entry.type : 'check';
        const { side, check } = skillSide(actor.character, skill, type, { fit: entry.fit ?? entry.stat });
        if (check.refusal) { refuse(entry.who, `${label}: not rolled (${check.refusal}).`, `${label}: not rolled (${check.plain ?? check.refusal}).`); continue; }
        if (skill.refused) refuse(entry.who, skill.refused, skill.refusedPlain);
        out.checks.push({ at, kind: 'check', actor: charId(actor.character), type, skill: skill.skill, ...(entry.ambush === true ? { ambush: true } : {}), ...withSkill(skill, actor.character, type, { fit: entry.fit ?? entry.stat }), difficulty: entry.difficulty, dc: LIMITS.dc[entry.difficulty], pc: side });
    }
    const noHidden = ({ statHidden: _hidden, ...pc }) => pc;
    const bare = list => list.map(({ at: _, ...entry }) => ({ ...entry, pc: noHidden(entry.pc), ...(entry.then ? { then: { ...entry.then, pc: noHidden(entry.then.pc) } } : {}) }));
    const standing = bar => ({ id: bar.id, name: bar.name, value: bar.value, size: bar.size });
    out.roster = roster;
    // The witness: the sheet numbers the roll depends on (the entries as prepared, and every bar and agility that decides who stands and in
    // what order). Whether a stat is hidden changes what the cue says, never the dice.
    out.witness = {
        formula: 'standard', acts: bare(out.acts), foes: bare(out.foes), checks: bare(out.checks), refused: out.refused,
        roster: { characters: roster.characters.map(bar => ({ ...standing(bar), agi: bar.character.stats.agi, soul: bar.character.soul, ...(hasLevels(rules) ? { level: bar.character.level } : {}), alive: bar.character.alive })),
            foes: roster.foes.map(bar => ({ ...standing(bar), class: bar.foe.class, ...(lv ? { level: bar.foe.level } : {}) })), resources: roster.resources.map(standing) },
    };
    return out;
}
