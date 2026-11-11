// The [Rolls] cue (SPEC_RPG_v1 §4.5.3 step 5): what the narrator is told under [Happened], and what a refused action
// says. Short lines, one per roll; the numbers are always "the party member's total vs the foe's (or the difficulty)".
// Model-facing text, kept to the cue budget (names.js LIMITS.cueTokens).
import { BATTLE_MARKER, DICE, FORMULA, LIMITS, RESOLVE, ROLL_KIND, STAGES, STATS, stageWord } from './names.js';

const signed = value => (value >= 0 ? `+${value}` : `${value}`);
/**
 * The prompt note, told from the reply's dice record (`rpg.dice`: the dice, the rules and difficulty numbers it was rolled with, and each party member's exact
 * bonus for every stat and skill, level or class term included, so the narrator's outcome and code's agree).
 */
export function offerLine(record) {
    const dice = Array.isArray(record?.list) ? record.list : [];
    const dc = record?.dc ?? LIMITS.dc, margin = Number.isInteger(record?.rules?.costMargin) ? record.rules.costMargin : FORMULA.costMargin;
    const table = (Array.isArray(record?.table) ? record.table : []).map(row => `${row.who}: ${STATS.map((stat, at) => `${stat.toUpperCase()}${signed(row.stats[at])}`).join(' ')}${row.skills.length ? `; ${row.skills.map(([name, bonus]) => `${name}${signed(bonus)}`).join(', ')}` : ''}`).join('. ');
    const first = Array.isArray(record?.table) ? record.table[0] : null;
    const example = `? ${ROLL_KIND} ${first?.who ?? 'Astra'} | ${first?.skills?.[0]?.[0] ?? 'Obscure'} | normal | ${dice[0] ?? 14}`;
    return `Dice for this reply, in order: ${dice.join(', ')}. Use one for each attempt that can fail (yours or a party member's): total = die + bonus, against easy ${dc.easy} (routine for a trained person), normal ${dc.normal} (a real chance to fail), hard ${dc.hard} (a skilled person often fails), very hard ${dc['very hard']} (rarely done). Total at the number or over: success; up to ${margin} short: success at a cost; less: fail; a natural 20 always succeeds and a natural 1 always fails.${table ? ` Bonus by stat or skill (level included): ${table}.` : ''} The story must follow each result strictly. Tell only what happens: dice, bonuses, totals and difficulty numbers go only in the ? roll lines, never in the story text. Report each: ? ${ROLL_KIND} Who | skill or stat | difficulty | die, where Who is the person rolling (the reader's character or a party member, by name), never the action; for example ${example}.`;
}

export const wearLine = ({ item, to }) => `${item} ${to === 'broken' ? 'breaks' : 'is worn'} (${to[0].toUpperCase() + to.slice(1)})`;
export const OUTCOME_WORD = Object.freeze({ success: 'SUCCESS', cost: 'SUCCESS AT A COST', fail: 'FAIL' });

/** Tokens as the prompt budget counts them (§5): about four characters each. */
export const cueTokens = text => Math.ceil(String(text ?? '').length / 4);

// An ambush check's result (ambush.js).
const ambushNote = line => (line.ambush !== true ? '' : `; ambush ${line.outcome === 'success' ? (line.ambushDrop === true ? 'works: you have the drop' : 'works, the party strikes first') : line.outcome === 'cost' ? 'only half works: no surprise' : 'fails, no surprise'}`);
const numbers = line => `(${line.pc.total} vs ${line.kind === 'check' ? line.dc : line.foe.total})`;

// Names are cut at this many characters only as the last way to fit the cue (shape 3 below).
const NAME_CUT = 20;
const TAIL_FROM = 4;
const cut = (text, max) => (max && text.length > max ? `${text.slice(0, max - 1)}…` : text);
const headTail = (text, max, tail) => `${text.slice(0, max - 1 - tail)}…${tail ? text.slice(-tail) : ''}`;

/**
 * The shown form of each name when names are cut to `max` characters, so that no two names show alike: a name is cut to its head,
 * and where that makes it look like another name, to a shorter head and the tail of the name ("Captain Rare L…pc3"), the shortest
 * tail (four characters or more, enough to be a word) that tells it apart. A name no cut can tell apart stays as written. → Map(name → shown).
 */
export function shortNames(names, max = NAME_CUT) {
    const all = [...new Set(names)];
    const shown = new Map(all.filter(name => name.length <= max).map(name => [name, name]));
    const used = new Set(shown.values());
    const open = all.filter(name => name.length > max);
    for (let tail = 0; tail <= max - 7 && open.some(name => !shown.has(name)); tail = tail ? tail + 1 : TAIL_FROM) {
        const forms = new Map(open.filter(name => !shown.has(name)).map(name => [name, headTail(name, max, tail)]));
        const counts = new Map();
        for (const form of forms.values()) counts.set(form, (counts.get(form) ?? 0) + 1);
        for (const [name, form] of forms) if (counts.get(form) === 1 && !used.has(form)) { shown.set(name, form); used.add(form); }
    }
    for (const name of open) if (!shown.has(name)) shown.set(name, name);
    return shown;
}

/**
 * One roll as one line: "Wessel → Sluice Rat A (Iron Breath): SUCCESS (26 vs 16)". `compact`: a check without its skill and stat;
 * `names`: the longest a skill's name may be (0: as written); `shown`: how a character's or a foe's name is written (shortNames; as given);
 * `plain`: name a hidden stat all the same (only to measure the cue, fitCue).
 */
export function lineText(line, { compact = false, names = 0, shown = name => name, plain = false, legacy = false } = {}) {
    const word = OUTCOME_WORD[line.outcome];
    const who = shown(line.pc.who);
    if (line.type && line.kind !== 'check') return standardLine(line, { names, shown, word, who, legacy });
    if (line.type && line.support) return `${who} → ${shown(line.target)}${line.skill ? ` (${cut(line.skill, names)}, support)` : ' (support)'}: ${word} ${numbers(line)}${line.damage ? `, heals${line.decisive ? ' well' : ''}` : ''}`;
    if (line.kind === 'check') {
        if (compact) return `${who} — ${line.difficulty} check: ${word} ${numbers(line)}${ambushNote(line)}`;
        // a stat the pack hides is not named (review 163)
        if (line.pc.statHidden && !plain) return `${who} — ${line.skill ? cut(line.skill, names) : 'check'}, ${line.difficulty}: ${word} ${numbers(line)}${ambushNote(line)}`;
        return `${who} — ${cut(line.skill ?? line.pc.stat.toUpperCase(), names)} (${line.pc.stat.toUpperCase()}), ${line.difficulty}: ${word} ${numbers(line)}${ambushNote(line)}`;
    }
    if (line.kind === 'foe') return `${shown(line.foe.name)} attacks ${who}${line.skill ? ` (${cut(line.skill, names)})` : ''}: ${word} for ${who} ${numbers(line)}`;
    return `${who} → ${shown(line.foe.name)}${line.skill ? ` (${cut(line.skill, names)})` : ''}: ${word} ${numbers(line)}`;
}

// The Standard formula's act and foe attack: the verdict first, as in the log, then what the roll did to the bars.
function standardLine(line, { names, shown, word, who, legacy = false }) {
    // (`legacy`: a roll before `fix: 2` is told as 2.20.0 told it)
    const foe = line.kind === 'foe', d = line.decisive;
    const verdict = legacy || !d ? word : line.outcome === 'fail' ? `${word}, DECISIVE` : `DECISIVE ${word}`;
    const hit = line.damage ? (foe ? `, hits ${who}${d ? ' hard' : ''}` : legacy ? `, a ${d ? 'decisive ' : ''}hit` : ', a hit') : (legacy && d ? ', decisive' : '');
    // A spent skill: its `else:` skill is named, else a plain weapon attack (`otherUp`: the other pool is not empty).
    const gone = cut(line.without ?? '', names), resource = line.withoutUses ? `${gone}'s ${line.withoutUses === 'mana' ? 'Mana' : 'Stamina'} is spent${line.otherUp ? `, ${line.withoutUses === 'mana' ? 'Stamina' : 'Mana'} is not` : ''}` : `${gone} unavailable: resource spent`;
    const bare = !line.without ? '' : legacy ? ` (${resource})` : line.skill ? ` (${resource}; ${cut(line.skill, names)} instead)` : ` (no skill: ${resource}; a plain weapon attack \u2014 name no skill)`;
    const by = line.skill ? ` (${cut(line.skill, names)})` : '';
    if (foe) return `${shown(line.foe.name)} attacks ${who}${by}${bare}: ${verdict} for ${who} ${numbers(line)}${hit}`;
    return `${who} \u2192 ${shown(line.foe.name)}${by}${bare}${line.area ? (line.reduced ? ' (area, reduced)' : ' (area)') : ''}: ${verdict} ${numbers(line)}${hit}`;
}

const IDLE_WHY = Object.freeze({ down: 'Down', beaten: 'beaten', 'no-target': 'no target left', 'no-resource': 'the skill\'s resource is Empty' });

/** The bars the told lines moved, from `start` (id → bar): [{ id, kind, name, module, field, from, to, size }] (one per bar). */
export function hurtsOf(start, lines) {
    const moved = new Map();
    for (const line of lines) {
        // (a hit or a heal moves Health; a skill's cost moves Stamina or Mana)
        for (const damage of [line.damage, line.cost]) {
            if (!damage) continue;
            const before = start.get(damage.id), seen = moved.get(damage.id);
            moved.set(damage.id, { id: damage.id, kind: damage.kind, name: damage.name, module: before.module, field: before.field, from: seen?.from ?? damage.from, to: damage.to, size: damage.size });
        }
    }
    return [...moved.values()].filter(item => item.from !== item.to);
}

// "Wessel Hurt; Sluice Rats Wounded": where the bars the told lines moved stand now, as words.
const barsLine = (start, lines) => hurtsOf(start, lines).map(item => {
    const own = item.field === 'stamina' || item.field === 'mana';
    return `${item.name} ${own ? `${item.field === 'mana' ? 'Mana' : 'Stamina'} ` : ''}${stageWord(own ? STAGES[item.field] : STAGES.health, item.to, item.size)}`;
}).join('; ');

const STOP_POINTS = 'Stop earlier at the first stop point (a foe falls, flees or yields; anyone on your side is Down or Badly wounded; new foes arrive).';

// How the cue ends from the flow of stage 49 (resolve.js FLOW_VERSION): the last line says what stopped the rolls.
// A won fight tells the narrator code gives the XP (fight.js) and the beaten groups stay on the Foes block.
const FLOW_ENDS = Object.freeze({
    won: 'every foe is Down: the fight is won. Stop there and tell it as the end of the fight. Code gives the party its XP for it: write no XP line for this fight, and leave the beaten groups on the Foes block (Down).',
    lost: 'everyone on your side is Down. Stop there and tell it.',
    heavy: 'a party member is badly hurt or Down. Stop there at the latest.',
});
const flowEnd = (n, end, noXp) => (end ? `Round ${n} ends the rolls: ${end === 'won' && noXp ? 'every foe is Down: the fight is won. Stop there and tell it as the end of the fight, and leave the beaten groups on the Foes block (Down).' : FLOW_ENDS[end]}` : `Round ${n} is the last rolled: stop there at the latest. ${STOP_POINTS}`);

// A refusal in fewer words: without its bracketed reason, and cut.
const shortRefusal = text => cut(String(text).replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(), 70);

/**
 * The cue for `rounds` (the first `count` of them) and the checks: `{ checks: [line], rounds: [{ n, decisive, lines }],
 * refused: [text], plainRefused?: [text], decisive }` (`plainRefused`: the refusals as if nothing were hidden, used only when `plain`). `decisive`: whether the last round told is the one that settles the fight. `shape` (0 to 3)
 * is how much it is shortened to fit the budget: 0 as written; 1 checks without their skill and refusals without their
 * reasons; 2 the refusals as one count; 3 names cut as well.
 */
export function cueText(parts, shape = 0, { plain = false } = {}) {
    const { checks, rounds, refused, plainRefused, decisive } = parts;
    const fight = rounds.length > 0;
    const std = parts.standard ?? null;
    const head = fight
        ? `[Rolls] Code rolled these${std ? ' and has already moved the bars they hit, heal or spend (Health, and the Stamina or Mana a skill uses; the last line says where those stand): never set those yourself' : ''}. Tell them in this order and as given${parts.legacy ? ', and' : '. Name only the skill a line names, and'} never invent a roll; write ${BATTLE_MARKER} on its own line where the fight is told.`
        : '[Rolls] Code rolled these. Tell them as given, and never invent a roll.';
    // Shape 3 cuts every name, and each stays different from the others, so the narrator can tell who earned which result.
    const options = { compact: shape >= 1, names: shape >= 3 ? NAME_CUT : 0, plain, legacy: !!parts.legacy };
    if (shape >= 3) {
        const told = [...checks, ...rounds.flatMap(round => round.lines)];
        const map = shortNames(told.flatMap(line => [line.pc.who, ...(line.foe ? [line.foe.name] : [])]));
        options.shown = name => map.get(name) ?? name;
    }
    const lines = [head];
    if (parts.opened?.length) lines.push(`New foes: ${parts.opened.map(entry => `${options.shown ? options.shown(entry.name) : entry.name} \u00d7${entry.count}${Number.isInteger(entry.level) ? ` (Lv ${entry.level})` : ''}`).join(', ')}.`);
    if (parts.carriedDrop) lines.push('Ambush from last time: the party strikes first.');
    for (const line of checks) lines.push(lineText(line, options));
    if (std && fight) {
        // (names only; a quick start and its opening action come before round 1)
        if (shape < 2 && std.order.length) lines.push(`Turn order: ${std.order.map(entry => options.shown ? options.shown(entry.name) : entry.name).join(', ')}.`);
        for (const item of std.quick) lines.push(`${item.who} is quick enough to act first against ${item.against} (an opening action).`);
        for (const line of std.opening) lines.push(`Opening: ${lineText(line, options)}`);
    }
    for (const round of rounds) {
        for (const line of round.lines) lines.push(`Round ${round.n}: ${lineText(line, options)}`);
        for (const item of round.idle ?? []) lines.push(`Round ${round.n}: ${item.who} does not act: ${IDLE_WHY[item.why] ?? item.why}.`);
    }
    // measuring (`plain`), each refusal as if nothing were hidden (`plainRefused`, the same count; review 166)
    const notes = plain && plainRefused?.length === refused.length ? plainRefused : refused;
    if (shape >= 2 && notes.length) lines.push(`${notes.length} more ${notes.length === 1 ? 'action was' : 'actions were'} not rolled as planned.`);
    else for (const text of notes) lines.push(shape >= 1 ? shortRefusal(text) : text);
    if (std && fight) {
        const standing = barsLine(std.start, [...std.opening, ...rounds.flatMap(round => round.lines)]);
        if (standing) lines.push(`Bars now: ${standing}.`);
    }
    if (fight && parts.flow === 2) lines.push(flowEnd(rounds.at(-1).n, parts.end ?? null, parts.noXp === true));
    else if (fight) lines.push(`Round ${rounds.at(-1).n} is ${decisive ? (rounds.at(-1).decisive || !std ? 'decisive' : 'the end of the fight') : 'the last rolled'}: stop there at the latest. ${STOP_POINTS}`);
    for (const event of parts.wear ?? []) lines.push(`Round ${event.n}: ${wearLine(event)}.`);
    return lines.join('\n');
}

// No foe on the Foes block and nothing rolled: if a fight starts now, the narrator sets the Foes line and stops at the first clash.
export const OPEN_FIGHT_LINE = 'No foes are set and no rolls this reply: if a fight starts now, set the Foes line and stop at the first clash; the dice decide from the next reply.';

export const NO_ROLLS_LINE = 'No rolls this reply: keep the fight undecided, one exchange, nobody goes Down.';

/**
 * The cue that fits the budget, by shortening (SPEC_RPG_v1 §4.5.3): all of `parts.rounds`, then fewer (never fewer than one);
 * if one round is still too long, the checks and refusals in fewer words, then the refusals as a count, then the names cut.
 * → { count, shape, text } (`count` rounds told; the last shape is used even when nothing fits, which only a plan of
 * unusually long names could come to, and those are cut there). `earlier`: the rule of a roll made before the shortening existed (a
 * payload with no `dice` version): only fewer rounds, never fewer than one, as written; so a Re-read of it tells what it told.
 */
export function fitCue(parts, budget = LIMITS.cueTokens, { earlier = false } = {}) {
    const total = parts.rounds.length;
    let last = null;
    for (let shape = 0; shape <= (earlier ? 0 : 3); shape += 1) {
        for (let count = total; count >= Math.min(1, total); count -= 1) {
            const told = { ...parts, rounds: parts.rounds.slice(0, count), decisive: parts.decisive && count === total, end: count === total ? parts.end ?? null : null };
            // Gear's wear lines (gear.js `wearOf`) count in the budget.
            if (typeof parts.wearOf === 'function') told.wear = parts.wearOf(told.rounds, parts.standard?.opening ?? []);
            last = { count, shape, text: cueText(told, shape) };
            // Measured as if no stat were hidden, so whether a stat is hidden never changes how many rounds are told (review
            // 164); the text that is sent is never longer than the one measured.
            if (cueTokens(cueText(told, shape, { plain: true })) <= budget) return last;
        }
    }
    return last;
}

/**
 * The cue text of a recorded roll (`data.v2.result` of an `rpg.resolve` receipt), built again from what the record holds: the lines, the refusals,
 * the standard parts, the shape it was fitted to (`shape`, kept beside the record in `data.v2.shape`, absent = 0) and how it stopped. `rpg.resolve` stores no copy of it (stage 51), and keeps the text
 * only if this would not give the same bytes. → text, or '' for a record that is not a roll.
 */
export function cueOfResult(result, shape = 0) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.rounds) || !Array.isArray(result.checks)) return '';
    try {
        const rounds = result.rounds, flow2 = result.flow === 2;
        const std = Array.isArray(result.order) ? {
            order: result.order, opening: result.opening ?? [], quick: result.quickStart ?? [],
            // the bars the told lines moved: only a bar's field is read, and its id says which
            start: { get: id => hurts.get(id) ?? { field: /:(stamina|mana)$/.exec(id)?.[1] ?? 'health' } },
        } : null;
        const hurts = new Map((result.hurts ?? []).map(item => [item.id, item]));
        const decisive = !flow2 && (result.stop === 'decisive' || result.stop === 'over');
        const end = flow2 && ['won', 'lost', 'heavy'].includes(result.stop) ? result.stop : null;
        return cueText({
            checks: result.checks, rounds, refused: (result.refused ?? []).map(entry => entry.text), decisive,
            ...(std ? { standard: std } : {}), ...(flow2 ? { flow: 2, end } : {}), ...(result.noXp === true ? { noXp: true } : {}), ...(result.wear ? { wear: result.wear } : {}), ...(result.fix >= 2 ? { opened: result.opened, carriedDrop: result.ambush?.spent === true } : { legacy: true }),
        }, Number.isInteger(shape) ? shape : 0);
    } catch { return ''; }
}

/** A receipt with its cue as `summary` (an `rpg.resolve` receipt stores none from stage 51 on): readers get the same text the prompt does. */
export const receiptWithCue = receipt => (receipt?.type === RESOLVE && !receipt.summary ? { ...receipt, summary: receiptCue(receipt) } : receipt);
/** The same over the store's `{ index, receipt }` entries. */
export const entriesWithCue = list => (Array.isArray(list) ? list.map(entry => (entry?.receipt ? { ...entry, receipt: receiptWithCue(entry.receipt) } : entry)) : list);

/** The cue a receipt tells: its own `summary`, else (an `rpg.resolve` receipt of stage 51 on) the one its record gives back. */
export function receiptCue(receipt) {
    if (typeof receipt?.summary === 'string' && receipt.summary) return receipt.summary;
    if (receipt?.type === DICE) return offerLine(receipt.data?.v2?.dice);
    return receipt?.type === RESOLVE ? cueOfResult(receipt.data?.v2?.result, receipt.data?.v2?.shape) : (receipt?.summary ?? '');
}
