// The [Rolls] cue (SPEC_RPG_v1 §4.5.3 step 5): what the narrator is told under [Happened], and what a refused action
// says. Short lines, one per roll; the numbers are always "the party member's total vs the foe's (or the difficulty)".
// Model-facing text, kept to the cue budget (names.js LIMITS.cueTokens).
import { BATTLE_MARKER, LIMITS, STAGES, stageWord } from './names.js';

export const OUTCOME_WORD = Object.freeze({ success: 'SUCCESS', cost: 'SUCCESS AT A COST', fail: 'FAIL' });

/** Tokens as the prompt budget counts them (§5): about four characters each. */
export const cueTokens = text => Math.ceil(String(text ?? '').length / 4);

const numbers = line => `(${line.pc.total} vs ${line.kind === 'check' ? line.dc : line.foe.total})`;

// Names are cut at this many characters only as the last way to fit the cue (shape 3 below).
const NAME_CUT = 20;
const TAIL_FROM = 4;
const cut = (text, max) => (max && text.length > max ? `${text.slice(0, max - 1)}…` : text);
const headTail = (text, max, tail) => `${text.slice(0, max - 1 - tail)}…${tail ? text.slice(-tail) : ''}`;

/**
 * The shown form of each name when names are cut to `max` characters, so that no two names show alike: a name is cut to its head,
 * and where that makes it look like another name, to a shorter head and the tail of the name ("Captain Rare L…pc3"), the shortest
 * tail (four characters or more, enough to be a word) that tells it apart. A name that no cut can tell apart from the others is left as written. → Map(name → shown).
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
export function lineText(line, { compact = false, names = 0, shown = name => name, plain = false } = {}) {
    const word = OUTCOME_WORD[line.outcome];
    const who = shown(line.pc.who);
    if (line.type && line.kind !== 'check') return standardLine(line, { names, shown, word, who });
    if (line.type && line.support) return `${who} → ${shown(line.target)}${line.skill ? ` (${cut(line.skill, names)}, support)` : ' (support)'}: ${word} ${numbers(line)}${line.damage ? `, heals${line.decisive ? ' well' : ''}` : ''}`;
    if (line.kind === 'check') {
        if (compact) return `${who} — ${line.difficulty} check: ${word} ${numbers(line)}`;
        // a stat the pack hides is not named (review 163)
        if (line.pc.statHidden && !plain) return `${who} — ${line.skill ? cut(line.skill, names) : 'check'}, ${line.difficulty}: ${word} ${numbers(line)}`;
        return `${who} — ${cut(line.skill ?? line.pc.stat.toUpperCase(), names)} (${line.pc.stat.toUpperCase()}), ${line.difficulty}: ${word} ${numbers(line)}`;
    }
    if (line.kind === 'foe') return `${shown(line.foe.name)} attacks ${who}${line.skill ? ` (${cut(line.skill, names)})` : ''}: ${word} for ${who} ${numbers(line)}`;
    return `${who} → ${shown(line.foe.name)}${line.skill ? ` (${cut(line.skill, names)})` : ''}: ${word} ${numbers(line)}`;
}

// The Standard formula's act and foe attack: Classic's wording, then what the roll did to the bars in words (the narrator reads no block counts).
function standardLine(line, { names, shown, word, who }) {
    const hit = line.damage
        ? (line.kind === 'foe' ? `, hits ${who}${line.decisive ? ' hard' : ''}` : `, a ${line.decisive ? 'decisive ' : ''}hit`)
        : (line.decisive ? ', decisive' : '');
    // (a skill whose Stamina or Mana ran out in the fight is rolled without it)
    const bare = line.without ? ` (${cut(line.without, names)} unavailable: resource spent)` : '';
    if (line.kind === 'foe') return `${shown(line.foe.name)} attacks ${who}${line.skill ? ` (${cut(line.skill, names)})` : ''}${bare}: ${word} for ${who} ${numbers(line)}${hit}`;
    const kind = line.area ? ' (area)' : '';
    return `${who} → ${shown(line.foe.name)}${line.skill ? ` (${cut(line.skill, names)})` : ''}${bare}${kind}: ${word} ${numbers(line)}${hit}`;
}

const IDLE_WHY = Object.freeze({ down: 'Down', beaten: 'beaten', 'no-target': 'no target left' });

/** The bars the told lines moved, from `start` (id → bar): [{ id, kind, name, module, field, from, to, size }] (one per bar, its first `from` to its last `to`). */
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
        ? `[Rolls] Code rolled these${std ? ' and has already moved the bars they hit, heal or spend (Health, and the Stamina or Mana a skill uses; the last line says where those stand): never set those yourself' : ''}. Tell them in this order and as given, and never invent a roll; write ${BATTLE_MARKER} on its own line where the fight is told.`
        : '[Rolls] Code rolled these. Tell them as given, and never invent a roll.';
    // Shape 3 cuts every name, and each stays different from the others, so the narrator can tell who earned which result.
    const options = { compact: shape >= 1, names: shape >= 3 ? NAME_CUT : 0, plain };
    if (shape >= 3) {
        const told = [...checks, ...rounds.flatMap(round => round.lines)];
        const map = shortNames(told.flatMap(line => [line.pc.who, ...(line.foe ? [line.foe.name] : [])]));
        options.shown = name => map.get(name) ?? name;
    }
    const lines = [head];
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
    if (fight) lines.push(`Round ${rounds.at(-1).n} is ${decisive ? (rounds.at(-1).decisive || !std ? 'decisive' : 'the end of the fight') : 'the last rolled'}: stop there at the latest. ${STOP_POINTS}`);
    return lines.join('\n');
}

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
            const told = { ...parts, rounds: parts.rounds.slice(0, count), decisive: parts.decisive && count === total };
            last = { count, shape, text: cueText(told, shape) };
            // Measured as if no stat were hidden, so whether a stat is hidden never changes how many rounds are told (review
            // 164); the text that is sent is never longer than the one measured.
            if (cueTokens(cueText(told, shape, { plain: true })) <= budget) return last;
        }
    }
    return last;
}
