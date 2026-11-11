// The Standard formula's roll: rollStandard (turn order, opening, rounds, acts, area and outcomes), with outcomeStd, judge,
// the contested line and bar moves, and summaryStd. Prepare supplies its acts and roster first.
import { ambushOf, ambushRecord, ambushedStandard } from '../ambush.js';
import { foeInitiativeBonus, initiativeBonus, quickStart, turnOrder } from '../formula.js';
import { FORMULA, PACE } from '../names.js';
import { fitCue, hurtsOf } from '../cue.js';
import { classTerm } from '../rules.js';
import { soakOf, soaked } from '../soak.js';
import { foeId } from './roster.js';

const DIE = FORMULA.die;

/** The outcome of the party member's die and total against `against` (resolve.js outcomeOf, with the rules' cost margin). */
export function outcomeStd(die, total, against, rules) {
    if (die === DIE) return 'success';
    if (die === 1) return 'fail';
    if (total >= against) return 'success';
    return total >= against - rules.costMargin ? 'cost' : 'fail';
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
export function rollStandard(plan, prepared, source, rules, { carried = null, flow = 1, wearOf = null, drop = null, opened = null, fix = false, then = false, board = false, scaled = false, soak = false, memberRolls = null, noXp = false } = {}) {
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
    // (a fight with the doubled bars, `scaled`: an area skill costs 2, so with 1 left it is rolled without the skill as an empty pool would be)
    const need = entry => (scaled && entry.area ? 2 : 1);
    const usable = entry => {
        if (entry.paid === true) return entry;
        const pool = entry.skill && entry.plain ? bars.get(`${entry.actor}:${entry.uses}`) : null;
        if (!(pool && pool.value < need(entry))) return entry;
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
        const cost = use.skill && use.uses && use.paid !== true ? damageOf(bars.get(`${use.actor}:${use.uses}`), need(use)) : undefined;
        return [{ ...lines[0], ...(use.without ? { without: use.without, ...(use.withoutUses ? { withoutUses: use.withoutUses } : {}), ...(otherUp ? { otherUp: true } : {}) } : {}), ...(cost ? { cost } : {}) }, ...lines.slice(1)];
    };
    // A hit takes 1 Health block, 2 when decisive; in a fight with the doubled bars a hit made with a skill on one target takes 2, 3 when decisive. (Area damage stays as it was.)
    const hitBlocksOf = (entry, decisive) => (decisive ? 2 : 1) + (scaled && entry.skill && !entry.area ? 1 : 0);
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
        const die = source('init', party ? bar.at : 16 + (bar.foe.group ?? bar.at))();
        const bonus = party ? initiativeBonus(bar.character.stats, classTerm(rules, bar.character).classBonus) : bar.initiative ?? foeInitiativeBonus(bar.foe.class);
        return { id: bar.id, name: bar.name, total: die + bonus, die, bonus, agi, party, fresh: true };
    });
    const order = turnOrder(entries).map(id => entries.find(entry => entry.id === id));
    const owner = entry => (entry.kind === 'foe' ? foeId(entry.foe.slot) : entry.actor);

    const actOf = entry => {
        const roll = diceOf(entry), pcDie = roll(), foeDie = roll();
        // (an area attack: the foe die already drawn is the first target's, one more for each other target. An old act has no group
        // and keeps drawing for every foe bar, as it always did; a grouped act draws only for its standing group.)
        const areaBars = entry.area && !entry.aoe ? (entry.group === undefined ? foes
            : foes.filter(bar => standing(bar.id) && (bar.foe.group ?? bar.at) === entry.group)) : [];
        const areaDice = areaBars.map((_, at) => (at === 0 ? foeDie : roll()));
        const me = bars.get(owner(entry));
        if (!standing(me.id)) return { idle: 'down' };
        if (entry.support) {
            if (board && scaled && !entry.skill) return { idle: 'no-resource' };
            const mate = bars.get(entry.target.id);
            const total = pcDie + entry.pc.statBonus + entry.pc.classBonus + entry.pc.rank + entry.pc.edge;
            const outcome = outcomeStd(pcDie, total, entry.dc, rules);
            const decisive = outcome !== 'fail' && (pcDie === DIE || total - entry.dc >= rules.decisiveMargin);
            const damage = outcome === 'fail' ? undefined : damageOf(mate, decisive ? -2 : -1);
            return { lines: [{ kind: 'check', type: entry.type, support: true, target: entry.target.name, skill: entry.skill, ...(entry.why ? { why: entry.why } : {}), pc: { ...entry.pc, die: pcDie, total },
                difficulty: entry.difficulty, dc: entry.dc, outcome, decisive, ...(damage ? { damage } : {}) }] };
        }
        const hit = (foeBar, dice, reduced = false) => {
            const rolled = contested(entry, dice.pcDie, dice.foeDie, rules);
            const blocks = memberRolls?.hitBlocks(entry, foeBar, rolled.decisive, reduced) ?? hitBlocksOf(entry, rolled.decisive);
            const damage = rolled.pcWins && ['physical', 'magic'].includes(entry.type) ? damageOf(foeBar, blocks) : undefined;
            return { kind: 'act', type: entry.type, skill: entry.skill, ...(entry.why ? { why: entry.why } : {}), ...(entry.area ? { area: true } : {}), ...(reduced ? { reduced: true } : {}),
                pc: rolled.pc, foe: { ...rolled.foe, name: foeBar.name, slot: foeBar.slot }, outcome: rolled.outcome, decisive: rolled.decisive, ...(damage ? { damage } : {}) };
        };
        if (entry.area && entry.aoe && entry.areaAll) {
            // (the area rule with `areaAll`: ONE roll, no main group; every standing group's bars take the same full effect. The first line carries the roll, the others are marked as followups for the log's grouping.)
            const all = foes.filter(bar => standing(bar.id));
            if (!all.length) return { idle: 'no-target' };
            return { lines: all.map((bar, at) => ({ ...hit(bars.get(bar.id), { pcDie, foeDie }), aoe: true, aoeGroup: bar.foe.group ?? bar.at, aoeAgainst: entry.foe.name,
                ...(Number.isFinite(bar.foe.level) ? { aoeLevel: bar.foe.level } : {}), ...(at ? { aoeFollowup: true } : {}) })) };
        }
        if (entry.area && entry.aoe) {
            // (the newer area rule, record `aoe: 1`: ONE roll, the main group's. Its group's bars take the full effect, every other standing group's bars
            // the same roll at one Health block less. The old path below is kept for records without `aoe`.)
            const all = foes.filter(bar => standing(bar.id)), mainOf = bar => (bar.foe.group ?? bar.at) === entry.group;
            if (!all.length) return { idle: 'no-target' };
            const main = all.filter(mainOf), down = !main.length;
            // If an earlier action cleared the main group, its contest still decides the other standing groups, without hitting the Down target.
            const targets = [...(down ? [bars.get(foeId(entry.foe.slot))] : main), ...all.filter(bar => !mainOf(bar))];
            return { lines: targets.map((bar, at) => ({ ...hit(bars.get(bar.id), { pcDie, foeDie }, !mainOf(bar)), aoe: true,
                aoeGroup: bar.foe.group ?? bar.at, aoeAgainst: entry.foe.name, ...(Number.isFinite(bar.foe.level) ? { aoeLevel: bar.foe.level } : {}),
                ...(at ? { aoeFollowup: true } : {}), ...(down && !at ? { aoeNoTarget: true } : {}) })) };
        }
        if (entry.area) {
            const targets = entry.group === undefined ? foes.filter(bar => standing(bar.id)) : areaBars;
            if (!targets.length) return { idle: 'no-target' };
            return { lines: targets.map((bar, at) => hit(bars.get(bar.id), { pcDie, foeDie: areaDice[entry.group === undefined ? foes.indexOf(bar) : at] })) };
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
        // (a marked fight, `soak`: a hit that is not decisive and is within 2 + S of the defender's total glances off; the skill's cost is paid as ever)
        const s = soak && !rolled.pcWins ? soakOf(me.character.stats?.vit) : 0;
        const glance = soak && !rolled.pcWins && soaked(s, rolled.foe.total - rolled.pc.total, rolled.decisive);
        const damage = rolled.pcWins || glance ? undefined : damageOf(me, rolled.decisive ? 2 : 1);
        return { lines: [{ kind: 'foe', type: 'defence', skill: entry.skill, pc: rolled.pc, foe: rolled.foe, outcome: rolled.outcome, decisive: rolled.decisive, ...(glance ? { soaked: s } : {}), ...(damage ? { damage } : {}) }] };
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
            // (the board: the lead is only recorded; the reader's own first exchange is the first action, no action is rolled for them)
            if (board) continue;
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
        memberRolls?.startRound();
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
                const mine = memberRolls?.attacks(prepared.foes, bar) ?? (board ? prepared.foes.filter(entry => entry.foe.slot === bar.slot) : [prepared.foes.find(entry => entry.foe.slot === bar.slot)]);
                for (const base of mine) {
                    if (!base) continue;
                    const done = memberRolls ? memberRolls.foe(base, prepared, doFoe, standing) : doFoe(base);
                    if (done.idle) roundIdle.push({ n, id, who: bar.name, kind: 'foe', why: done.idle }); else roundLines.push(...done.lines);
                }
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
        ...(flow === 2 ? { flow, end: all.at(-1)?.end ?? null } : {}), ...(noXp ? { noXp: true } : {}), ...(wearOf ? { wearOf } : {}), ...(fix && opened?.length ? { opened } : {}), ...(fix && ambush?.carried ? { carriedDrop: true } : {}), ...(fix ? {} : { legacy: true }) };
    const cue = board ? { count: all.length, text: '', shape: 0 } : fitCue(cueParts);
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
