// The Standard formula's roll (formula.js has the numbers; resolve.js dispatches here when the recorded rules say `formula: 'standard'`).
//
// What is different from Classic (resolve.js):
// - a roll is typed: physical, magic, defence, social or check (plan.js). The stat part is formula.js statPart: a skill's stat takes the
//   main slot, half of the type's second stat is added, the sum is halved once. Class = the level bonus (floor(level / divisor); before levels classWeight × Soul Class), then the skill's rank,
//   then the situation's edge held inside LUK's window (formula.js luckWindow, edgeWithLuck).
// - a foe adds foeBonus(class, rules) = foeBase + foeClassWeight × class.
// - a fight has a turn order (rolled once, kept across replies, carried in the payload), an opening action for a character who leads a
//   foe by the quick-start margin, and bars: a hit takes 1 block (2 when decisive) from the target's Health, a heal gives 1 (2). A foe
//   group or a character who is beaten before their turn does not act. Area attacks roll once against each target. Support rolls
//   against a difficulty.
// - the blocks the told rolls take or give are recorded on the roll (`hurts`) and written to the bars by resolve.js.
//
// The record (extends resolve.js's): result.formula 'standard'; each Line has `type`, and pc = { who, die, type, stat (the main stat),
// second, mainValue, secondValue, statBonus (the pair), style ('dodge'|'block'|'ward'|null), classValue, classBonus, rank, window { min, max } (what LUK allows the edge),
// situation (the edge asked for), edge (after luck), total }, foe = { slot, name, die, base, classValue, classBonus, total }; contested lines
// have `decisive` and, where a bar moved, `damage` = { id, kind: 'char'|'foe', name, blocks (+ hurt, − healed), from, to, size };
// `area`, `support` (target = the one healed) and `opening` mark those lines. The result adds `order` = [{ id, name, total, die, bonus,
// agi, party, fresh }] (the turn order for the fight), `quickStart` = [{ who, against }], `opening` = [Line], `idle` = [{ n, id, who,
// kind, why }] and `hurts` = [{ id, kind, name, module, field, from, to, size }].
import { ambushOf, ambushRecord, ambushedStandard } from './ambush.js';
import { blocksFor, edgeWithLuck, foeBonus, foeHealthBlocks, foeInitiativeBonus, initiativeBonus, levelBonus, luckWindow, quickStart, statPart, turnOrder } from './formula.js';
import { FOE_SLOTS, FORMULA, LIMITS, PACE, STAGES } from './names.js';
import { matchCharacter, matchFoe, matchSkill } from './read.js';
import { fitCue, hurtsOf } from './cue.js';
import { foeBlocksByLevel } from './foes.js';
import { classTerm, hasLevels } from './rules.js';

const DIE = FORMULA.die;
const cap = word => word.charAt(0).toUpperCase() + word.slice(1);
export const charId = character => `c:${character.key}`;
export const foeId = slot => `f:${slot}`;
const hurtField = slot => `hurt${((slot - 1) % FOE_SLOTS) + 1}`;

/** The outcome of the party member's die and total against `against` (resolve.js outcomeOf, with the rules' cost margin). */
export function outcomeStd(die, total, against, rules) {
    if (die === DIE) return 'success';
    if (die === 1) return 'fail';
    if (total >= against) return 'success';
    return total >= against - rules.costMargin ? 'cost' : 'fail';
}

// ---- the sheet, as bars -----------------------------------------------------------------------------------------------

// Every character and foe group as a bar: { id, kind, name, module, field, value, size }. A bar that cannot be read (no number) counts as full.
// `maxOf(module, field)`: the most the block's own field holds (a Classic block under the Standard formula holds at most 5).
function rosterOf(sheet, maxOf) {
    const characters = sheet.characters.map((character, at) => {
        const size = Math.max(1, Math.min(blocksFor(character.base ?? character.stats).health, maxOf(character.module, 'health')));
        const value = Number.isInteger(character.health) ? Math.max(0, Math.min(size, character.health)) : size;
        return { at, id: charId(character), kind: 'char', character, name: character.who, module: character.module, field: 'health', value, size };
    });
    const foes = sheet.foes.filter(foe => foe.filled).map(foe => {
        const field = hurtField(foe.slot), size = Math.max(1, Math.min(foe.levelled ? foe.size ?? foeBlocksByLevel(foe.level) : foeHealthBlocks(foe.class), maxOf(foe.module, field)));
        const value = Number.isInteger(foe.hurt) ? Math.max(0, Math.min(size, foe.hurt)) : size;
        return { at: foe.slot, id: foeId(foe.slot), kind: 'foe', foe, name: foe.name, module: foe.module, field, value, size, slot: foe.slot };
    });
    // Stamina and Mana: a skill spends a block of its resource each use (the bars are named `c:<key>:stamina` and `c:<key>:mana`).
    const resources = characters.flatMap(({ character, name, module }) => ['stamina', 'mana'].map(field => {
        const size = Math.max(1, Math.min(blocksFor(character.base ?? character.stats)[field], maxOf(module, field)));
        const value = Number.isInteger(character[field]) ? Math.max(0, Math.min(size, character[field])) : size;
        return { id: `${charId(character)}:${field}`, kind: 'char', name, module, field, value, size };
    }));
    return { characters, foes, resources };
}

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
export function prepareStandard(plan, sheet, rules, { maxOf = () => Infinity, lv = false, fix = false, then = false } = {}) {
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
            out.acts.push({ ...entry, ...(act.area === true && !spent ? { area: true } : {}), ...(later ? { then: later } : {}), foe: foeSide(foe) });
        }
    }
    for (const [at, entry] of (plan.foes ?? []).entries()) {
        if (entry.hold) continue;
        const foe = sheet.foes.find(slot => slot.slot === entry.slot && slot.filled);
        const label = `${foe?.name ?? `Foe ${entry.slot}`} attacks ${entry.target}`;
        if (!foe) { refuse(`foe${entry.slot}`, `${label}: not rolled (that foe slot is empty).`); continue; }
        const defender = ready(entry.target);
        if (defender.refusal) { refuse(entry.target, `${label}: not rolled (${defender.refusal}).`); continue; }
        const skill = skillStd(defender.character, entry.skill, {});
        const { side, check } = skillSide(defender.character, skill, 'defence', { againstMagic: entry.againstMagic === true });
        if (check.refusal) { refuse(entry.target, `${label}: not rolled (${check.refusal}).`, `${label}: not rolled (${check.plain ?? check.refusal}).`); continue; }
        if (skill.refused) refuse(entry.target, skill.refused, skill.refusedPlain);
        out.foes.push({ at, kind: 'foe', actor: charId(defender.character), type: 'defence', skill: skill.skill, ...withSkill(skill, defender.character, 'defence', { againstMagic: entry.againstMagic === true }), pc: side, foe: foeSide(foe) });
    }
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

// ---- rolling ----------------------------------------------------------------------------------------------------------

/**
 * How a contest ends: the party member's die and total against the other side's. → { outcome ('success' | 'cost' | 'fail'), pcWins (success or at a
 * cost), decisive }. Decisive is the winner's natural 20, the loser's natural 1, or a lead of `decisiveMargin`; it is what a hit takes two blocks on.
 */
export function judge(pcDie, pcTotal, foeDie, foeTotal, rules) {
    const outcome = outcomeStd(pcDie, pcTotal, foeTotal, rules);
    const pcWins = outcome !== 'fail';
    const decisive = pcWins ? pcDie === DIE || foeDie === 1 || pcTotal - foeTotal >= rules.decisiveMargin
        : foeDie === DIE || pcDie === 1 || foeTotal - pcTotal >= rules.decisiveMargin;
    return { outcome, pcWins, decisive };
}

// A contested line: the dice of both sides made into totals and judged.
function contested(entry, pcDie, foeDie, rules) {
    const pcTotal = pcDie + entry.pc.statBonus + entry.pc.classBonus + entry.pc.rank + entry.pc.edge;
    const foeTotal = foeDie + entry.foe.base + entry.foe.classBonus;
    return { ...judge(pcDie, pcTotal, foeDie, foeTotal, rules), pc: { ...entry.pc, die: pcDie, total: pcTotal }, foe: { ...entry.foe, die: foeDie, total: foeTotal } };
}

// Moves a bar by `blocks` (+ hurt, − healed) and returns the record, or null when nothing moved.
function move(bar, blocks) {
    const to = Math.max(0, Math.min(bar.size, bar.value - blocks));
    if (to === bar.value) return null;
    const record = { id: bar.id, kind: bar.kind, name: bar.name, blocks: bar.value - to, from: bar.value, to, size: bar.size };
    bar.value = to;
    return record;
}

/**
 * Rolls a prepared plan under Standard `rules`. `source` is positionalDice's answer (kinds act, foe, check, init, open). `carried`: the turn
 * order of the fight this reply goes on with ([{ id, name, total, agi, party }]), else the fight starts here (the order is rolled, a quick
 * start can happen). → { checks, rounds, opening, order, quickStart, idle, hurts, stop, text, summary }; the rounds are already cut to the stop
 * and the cue budget, and the hurts hold only what the told rolls did to the bars.
 */
export function rollStandard(plan, prepared, source, rules, { carried = null, flow = 1, wearOf = null, drop = null, opened = null, fix = false, then = false } = {}) {
    const own = new Map();
    // (An action's dice belong to its place in the plan: the entry as prepared, even when it is rolled without its skill.)
    const diceOf = entry => {
        const key = entry.base ?? entry;
        if (!own.has(key)) own.set(key, source(key.kind, key.at ?? 0));
        return own.get(key);
    };
    const { characters, foes, resources } = prepared.roster;
    const fight = [...prepared.acts, ...prepared.foes];
    const bars = new Map([...characters, ...foes, ...resources].map(bar => [bar.id, { ...bar }]));
    const standing = id => (bars.get(id)?.value ?? 0) > 0;
    // A skill costs a block of its resource (Stamina or Mana) each time it is used; with the resource empty an action is rolled without the skill.
    // With the resource empty an action goes on with its `else:` skill when that one's resource is not empty, else as a plain attack (single foe, no skill).
    const usable = entry => {
        const bar = entry.skill && entry.plain ? bars.get(`${entry.actor}:${entry.uses}`) : null;
        if (!(bar && bar.value === 0)) return entry;
        const spentOn = { without: entry.skill, ...(fix ? { withoutUses: entry.uses } : {}), base: entry.base ?? entry };
        const backup = entry.alt ? bars.get(`${entry.actor}:${entry.alt.uses}`) : null;
        if (entry.alt && backup && backup.value > 0) return { ...entry, ...entry.alt, plain: undefined, alt: undefined, ...spentOn };
        return { ...entry, ...entry.plain, alt: undefined, ...spentOn };
    };
    // The action done (`done.lines`): its skill, if it used one, spends a block, and a roll made without its skill says which.
    const spent = (use, lines) => {
        if (!lines.length) return lines;
        // (from the mark of `then:`, a line rolled without its skill also says when the actor's other pool is not empty, read from the bars as this line is
        // rolled, before its own cost: so the cue never blames the wrong pool)
        const other = then && use.without && use.withoutUses ? bars.get(`${use.actor}:${use.withoutUses === 'mana' ? 'stamina' : 'mana'}`) : null;
        const otherUp = Boolean(other && other.value > 0);
        const cost = use.skill && use.uses ? damageOf(bars.get(`${use.actor}:${use.uses}`), 1) : undefined;
        return [{ ...lines[0], ...(use.without ? { without: use.without, ...(use.withoutUses ? { withoutUses: use.withoutUses } : {}), ...(otherUp ? { otherUp: true } : {}) } : {}), ...(cost ? { cost } : {}) }, ...lines.slice(1)];
    };
    const damageOf = (bar, blocks) => (blocks === 0 ? undefined : move(bar, blocks) ?? undefined);
    const checks = prepared.checks.map(base => {
        const entry = usable(base), roll = diceOf(entry), die = roll();
        const total = die + entry.pc.statBonus + entry.pc.classBonus + entry.pc.rank + entry.pc.edge;
        const [line] = spent(entry, [{ kind: 'check', type: entry.type, skill: entry.skill, ...(entry.ambush === true ? { ambush: true } : {}), pc: { ...entry.pc, die, total }, difficulty: entry.difficulty, dc: entry.dc, outcome: outcomeStd(die, total, entry.dc, rules) }]);
        return line;
    });
    const ambush = ambushOf(checks, drop, fight.some(entry => entry.kind === 'act'));
    const most = fight.length ? Math.min(flow === 2 && plan.pace !== 'careful' ? rules.roundCap : PACE[plan.pace], rules.roundCap) : 0;

    // The turn order: kept when the fight goes on (a foe of the carried order is still there), else rolled here. A late arrival rolls on entry.
    const here = [...characters.filter(bar => standing(bar.id)), ...foes.filter(bar => standing(bar.id))];
    const old = new Map((Array.isArray(carried) ? carried : []).map(entry => [entry.id, entry]));
    // The same group goes on only if it is no healthier than the fight left it (`left`, the blocks it had when that reply ended): a group that
    // arrives full after that fight was beaten, or fled, or yielded, is a new one, and rolls a new order.
    const same = bar => (old.get(bar.id)?.name === bar.name && !(Number.isSafeInteger(old.get(bar.id)?.left) && bar.value > old.get(bar.id).left) ? old.get(bar.id) : null);
    const goesOn = foes.some(bar => same(bar));
    const entries = here.map(bar => {
        const kept = goesOn ? same(bar) : null;
        const party = bar.kind === 'char', agi = party ? bar.character.stats.agi ?? 0 : 0;
        if (kept) return { id: bar.id, name: bar.name, total: kept.total, die: kept.die ?? null, bonus: kept.bonus ?? null, agi, party, fresh: false };
        const die = source('init', party ? bar.at : 16 + bar.at)();
        const bonus = party ? initiativeBonus(bar.character.stats, classTerm(rules, bar.character).classBonus) : bar.initiative ?? foeInitiativeBonus(bar.foe.class);
        return { id: bar.id, name: bar.name, total: die + bonus, die, bonus, agi, party, fresh: true };
    });
    const order = turnOrder(entries).map(id => entries.find(entry => entry.id === id));
    const owner = entry => (entry.kind === 'foe' ? foeId(entry.foe.slot) : entry.actor);

    const actOf = entry => {
        const roll = diceOf(entry), pcDie = roll(), foeDie = roll();
        // (an area attack: the foe die already drawn is the first foe's, one more is drawn for each other foe group)
        const areaDice = entry.area ? foes.map((_, at) => (at === 0 ? foeDie : roll())) : [];
        const me = bars.get(owner(entry));
        if (!standing(me.id)) return { idle: 'down' };
        if (entry.support) {
            const mate = bars.get(entry.target.id);
            const total = pcDie + entry.pc.statBonus + entry.pc.classBonus + entry.pc.rank + entry.pc.edge;
            const outcome = outcomeStd(pcDie, total, entry.dc, rules);
            const decisive = outcome !== 'fail' && (pcDie === DIE || total - entry.dc >= rules.decisiveMargin);
            const damage = outcome === 'fail' ? undefined : damageOf(mate, decisive ? -2 : -1);
            return { lines: [{ kind: 'check', type: entry.type, support: true, target: entry.target.name, skill: entry.skill, ...(entry.why ? { why: entry.why } : {}), pc: { ...entry.pc, die: pcDie, total },
                difficulty: entry.difficulty, dc: entry.dc, outcome, decisive, ...(damage ? { damage } : {}) }] };
        }
        const hit = (foeBar, dice) => {
            const rolled = contested(entry, dice.pcDie, dice.foeDie, rules);
            const damage = rolled.pcWins && ['physical', 'magic'].includes(entry.type) ? damageOf(foeBar, rolled.decisive ? 2 : 1) : undefined;
            return { kind: 'act', type: entry.type, skill: entry.skill, ...(entry.why ? { why: entry.why } : {}), ...(entry.area ? { area: true } : {}),
                pc: rolled.pc, foe: { ...rolled.foe, name: foeBar.name, slot: foeBar.slot }, outcome: rolled.outcome, decisive: rolled.decisive, ...(damage ? { damage } : {}) };
        };
        if (entry.area) {
            const targets = foes.filter(bar => standing(bar.id));
            if (!targets.length) return { idle: 'no-target' };
            return { lines: targets.map(bar => hit(bars.get(bar.id), { pcDie, foeDie: areaDice[foes.indexOf(bar)] })) };
        }
        const target = bars.get(foeId(entry.foe.slot));
        if (!standing(target.id)) return { idle: 'no-target' };
        return { lines: [hit(target, { pcDie, foeDie })] };
    };
    const foeOf = entry => {
        const roll = diceOf(entry), pcDie = roll(), foeDie = roll();
        const foeBar = bars.get(foeId(entry.foe.slot)), me = bars.get(entry.actor);
        if (!standing(foeBar.id)) return { idle: 'beaten' };
        if (!standing(me.id)) return { idle: 'no-target' };
        const rolled = contested(entry, pcDie, foeDie, rules);
        const damage = rolled.pcWins ? undefined : damageOf(me, rolled.decisive ? 2 : 1);
        return { lines: [{ kind: 'foe', type: 'defence', skill: entry.skill, pc: rolled.pc, foe: rolled.foe, outcome: rolled.outcome, decisive: rolled.decisive, ...(damage ? { damage } : {}) }] };
    };

    const withUse = (base, run) => {
        const use = usable(base), done = run(use);
        return done.lines ? { lines: spent(use, done.lines) } : done;
    };
    // (an ambush that worked: the party's acts of round 1, and their opening actions, roll with the edge)
    // (from round 2 an act with a `then:` skill rolls with it: the same dice, the entry's own place in the plan)
    const laterOf = base => {
        if (!base.then) return base;
        const { without: _w, withoutUses: _u, uses: _s, area: _a, plain: _p, alt: _l, then: later, ...rest } = base;
        return { ...rest, ...later, base: base.base ?? base };
    };
    const doAct = (base, round = 0) => withUse(ambushedStandard(round > 1 ? laterOf(base) : base, round, ambush), actOf);
    const doFoe = base => withUse(base, foeOf);

    // The opening action: a character who leads a foe by the margin acts once against it before the first round.
    const opening = [], quick = [];
    if (fight.length && !goesOn) {
        for (const base of prepared.acts) {
            if (base.support || base.area) continue;
            const entry = usable(ambushedStandard(base, 1, ambush));
            const mine = entries.find(item => item.id === owner(entry)), theirs = entries.find(item => item.id === foeId(entry.foe.slot));
            // (an ambush that worked is the lead: the party strikes first without the margin)
            if (!mine || !theirs || !(ambush?.success || quickStart(mine.total, theirs.total, rules.quickStartMargin))) continue;
            if (quick.some(item => item.who === entry.pc.who)) continue;
            const roll = source('open', base.at ?? 0), pcDie = roll(), foeDie = roll();
            const me = bars.get(owner(entry)), target = bars.get(foeId(entry.foe.slot));
            quick.push({ who: entry.pc.who, against: entry.foe.name });
            if (!standing(me.id) || !standing(target.id)) continue;
            const rolled = contested(entry, pcDie, foeDie, rules);
            const damage = rolled.pcWins && ['physical', 'magic'].includes(entry.type) ? damageOf(target, rolled.decisive ? 2 : 1) : undefined;
            opening.push(...spent(entry, [{ kind: 'act', type: entry.type, skill: entry.skill, opening: true, ...(entry.why ? { why: entry.why } : {}), pc: rolled.pc, foe: { ...rolled.foe, name: target.name, slot: target.slot },
                outcome: rolled.outcome, decisive: rolled.decisive, ...(damage ? { damage } : {}) }]));
        }
    }

    const all = [];
    for (let n = 1; n <= most; n += 1) {
        const roundLines = [], roundIdle = [];
        for (const { id } of order) {
            const bar = bars.get(id);
            if (bar.kind === 'char') {
                const mine = prepared.acts.filter(entry => owner(entry) === id);
                let said = false;
                for (const entry of mine) {
                    const done = doAct(entry, n);
                    if (done.idle) { if (!said) { roundIdle.push({ n, id, who: bar.name, kind: 'char', why: standing(id) ? done.idle : 'down' }); said = true; } continue; }
                    roundLines.push(...done.lines);
                }
            } else {
                const mine = prepared.foes.find(entry => entry.foe.slot === bar.slot);
                if (!mine) continue;
                const done = doFoe(mine);
                if (done.idle) roundIdle.push({ n, id, who: bar.name, kind: 'foe', why: done.idle }); else roundLines.push(...done.lines);
            }
        }
        const decisive = roundLines.some(line => line.decisive);
        const lost = !characters.some(bar => standing(bar.id)), won = !foes.some(bar => standing(bar.id));
        const over = won || lost;
        // From the flow of stage 49 a decisive result no longer ends the reply: the rolls go on until the fight is won or lost, a party member is badly
        // hurt (lost 2 or more Health blocks in this reply, or went Down), the cap or the careful pace (resolve.js).
        const heavy = flow === 2 && characters.some(bar => bar.value > 0 && (bar.value - bars.get(bar.id).value >= 2 || !standing(bar.id)));
        const end = flow === 2 ? (lost ? 'lost' : won ? 'won' : heavy ? 'heavy' : null) : null;
        all.push({ n, decisive, over, ...(end ? { end } : {}), lines: roundLines, ...(roundIdle.length ? { idle: roundIdle } : {}) });
        if (flow === 2 ? end : decisive || over) break;
    }

    // The cue, fitted to its budget; the rounds told decide the bars.
    const refused = prepared.refused.map(entry => entry.text);
    const start = new Map([...characters, ...foes, ...resources].map(bar => [bar.id, bar]));
    const cueParts = { checks, rounds: all, refused, plainRefused: prepared.plainRefused, decisive: all.length > 0 && (all.at(-1).decisive || all.at(-1).over), standard: { order, opening, quick, start },
        ...(flow === 2 ? { flow, end: all.at(-1)?.end ?? null } : {}), ...(wearOf ? { wearOf } : {}), ...(fix && opened?.length ? { opened } : {}), ...(fix && ambush?.carried ? { carriedDrop: true } : {}), ...(fix ? {} : { legacy: true }) };
    const cue = fitCue(cueParts);
    const rounds = all.slice(0, cue.count).map(({ over: _, end: _end, ...round }) => round);
    const told = all.slice(0, cue.count);
    const hurts = hurtsOf(start, [...opening, ...checks, ...told.flatMap(round => round.lines)]);
    // Where each foe group stands when this reply ends, kept with the order for the fight's next reply.
    for (const entry of order) if (!entry.party) entry.left = hurts.find(item => item.id === entry.id)?.to ?? start.get(entry.id).value;
    const decisive = told.length > 0 && told.at(-1).decisive;
    const over = told.length > 0 && told.at(-1).over;
    const stop = !told.length ? 'none' : cue.count < all.length ? 'budget'
        : flow === 2 ? told.at(-1).end ?? (plan.pace === 'careful' ? 'pace' : 'cap') : decisive ? 'decisive' : over ? 'over' : told.length === most ? 'pace' : 'cap';
    const toldIdle = told.flatMap(round => round.idle ?? []);
    return {
        checks, rounds, stop, text: cue.text, shape: cue.shape, opening, order, quickStart: quick, idle: toldIdle, hurts,
        summary: summaryStd(checks, rounds, prepared.refused), ...ambushRecord(ambush, checks, fight),
    };
}

// "Rolled for you: N exchanges": one entry per action of the plan with its outcome in each round told.
export function summaryStd(checks, rounds, refused) {
    const acts = [];
    const entry = (line, target) => ({ kind: line.kind, who: line.kind === 'foe' ? line.foe.name : line.pc.who, target, skill: line.skill, stat: line.pc.stat, outcomes: [] });
    for (const line of checks) acts.push({ ...entry(line, null), outcomes: [line.outcome] });
    const index = new Map();
    for (const round of rounds) for (const line of round.lines) {
        const key = `${line.kind}:${line.kind === 'foe' ? line.foe.slot : line.pc.who}:${line.support ? line.target : line.foe?.slot ?? ''}`;
        if (!index.has(key)) { index.set(key, acts.length); acts.push(entry(line, line.kind === 'foe' ? line.pc.who : line.support ? line.target : line.foe.name)); }
        acts[index.get(key)].outcomes.push(line.outcome);
    }
    return { exchanges: rounds.length, acts, refused: refused.length };
}
