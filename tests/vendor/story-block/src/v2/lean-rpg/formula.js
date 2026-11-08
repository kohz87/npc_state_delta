// The Standard stat formula (agreed 1 Nov): the pure numbers shared by the roll math, the bars and the turn order.
//
// Standard pairs a main stat
// with half of a second one and halves the sum, rounded down once at the end: (main + second/2)/2 = floor((2·main + second)/4).
// A skill puts its own stat in the main slot; nothing is added on top. Pure: no DOM, no state, no randomness.

/** The seven stats, in sheet order. */
export const STAT_KEYS = Object.freeze(['str', 'vit', 'agi', 'dex', 'int', 'luk', 'cha']);

/** What a roll is for. A support action (healing, a buff) rolls its skill's type against a difficulty. */
export const ROLL_TYPES = Object.freeze(['physical', 'magic', 'defence', 'social', 'check']);

/** Standard's numbers. Packs may set their own (the build reads them from the rules payload, never from today's settings on replay). */
export const STANDARD_NUMBERS = Object.freeze({
    startStat: 5,          // every stat at creation
    createPoints: 10,      // points to spend at creation
    createMin: 3,          // lowest a stat may go at creation
    createMax: 10,         // highest a stat may go at creation
    pointsPerSoul: 4,      // points with each Soul Class rise
    statMax: 20,           // highest a stat may ever be
    foeBase: 3,            // foe: d20 + foeBase + foeClassWeight × class (tuned by simulation in the build)
    foeClassWeight: 3,
    quickStartMargin: 10,  // turn-order lead over a foe that earns one opening action against it
});

const num = value => (Number.isFinite(value) ? Math.trunc(value) : 0);
const statOf = (stats, key) => num(stats?.[key]);

/** (main + second/2)/2, rounded down once. */
export const pair = (main, second) => Math.floor((2 * num(main) + num(second)) / 4);

/** The default main and second stat of each roll type (defence is decided by the stats: see statPart). */
export const TYPE_STATS = Object.freeze({
    physical: Object.freeze({ main: 'str', second: 'dex' }),
    magic: Object.freeze({ main: 'int', second: 'dex' }),
    social: Object.freeze({ main: 'cha', second: 'int' }),
    check: Object.freeze({ main: 'str', second: 'dex' }),
});

/**
 * The stat part of a Standard roll.
 * - `skillStat`: a skill's own stat takes the main slot (the second stays the type's).
 * - defence: the higher of AGI and VIT leads (a tie leads with AGI), the other is the second; `style` is 'dodge' (AGI) or
 *   'block' (VIT). Against magic (`againstMagic`) it is the higher of INT and VIT ('ward' or 'block').
 * - check: `fittingStat` (STR climb/force, AGI sneak, DEX locks, INT lore/notice, VIT endure) is the main stat.
 * Returns { value, main, second, style } with stat keys; an unknown type reads as physical.
 */
export function statPart(type, stats, { skillStat = null, fittingStat = null, againstMagic = false } = {}) {
    const known = key => (STAT_KEYS.includes(key) ? key : null);
    if (type === 'defence') {
        const [a, b] = againstMagic ? ['int', 'vit'] : ['agi', 'vit'];
        const lead = known(skillStat) ?? (statOf(stats, a) >= statOf(stats, b) ? a : b);
        const other = lead === a ? b : lead === b ? a : (statOf(stats, a) >= statOf(stats, b) ? a : b);
        const style = lead === 'agi' ? 'dodge' : lead === 'int' ? 'ward' : 'block';
        return { value: pair(statOf(stats, lead), statOf(stats, other)), main: lead, second: other, style };
    }
    const base = TYPE_STATS[type] ?? TYPE_STATS.physical;
    const main = known(skillStat) ?? (type === 'check' ? known(fittingStat) : null) ?? base.main;
    return { value: pair(statOf(stats, main), statOf(stats, base.second)), main, second: base.second, style: null };
}

/**
 * Luck is a window on the edge, by LUK (stats start at 5): LUK 3–4 −3..+3, 5–6 −2..+3, 7–8 −1..+3, 9–10 −1..+3, 11–12 0..+3, 13–14 +1..+4,
 * 15–16 +2..+4, 17–18 +2..+5, 19–20 +3..+5 (below 3 is the same as 3). → { min, max }
 */
export function luckWindow(luk) {
    const step = Math.max(0, Math.min(8, Math.floor((Math.max(3, num(luk)) - 3) / 2)));
    return { min: [-3, -2, -1, -1, 0, 1, 2, 2, 3][step], max: [3, 3, 3, 3, 3, 4, 4, 5, 5][step] };
}

/** The LUK values at which the window changes (the next one is what the Party line and the steppers name). */
export const LUCK_STEPS = Object.freeze([5, 7, 11, 13, 15, 17, 19]);

/**
 * The situation's edge (−3 to +3) held inside LUK's window: never below its low end, and a best-case situation (+3) reaches its high end.
 * Anything between stays as the situation made it (raised to the low end when that is higher). The result is within the window.
 */
export function edgeWithLuck(edge, luk) {
    const { min, max } = luckWindow(luk), e = Math.max(-3, Math.min(3, num(edge)));
    return e >= 3 ? max : Math.max(min, e);
}

/**
 * How many blocks each bar has. Scale 1 (every pin made before the scale mark, kept forever): Health 4 + VIT/5, Stamina 3 + AGI/5, Mana 3 + INT/5 (rounded down).
 * Scale 2 (a pin with `scale: 2` on its bars): each bar is 2 × (4 + stat/5), so VIT 5, AGI 10, INT 5 give 10 / 12 / 10.
 */
export function blocksFor(stats, scale = 1) {
    if (scale === 2) {
        return {
            health: 2 * (4 + Math.floor(statOf(stats, 'vit') / 5)),
            stamina: 2 * (4 + Math.floor(statOf(stats, 'agi') / 5)),
            mana: 2 * (4 + Math.floor(statOf(stats, 'int') / 5)),
        };
    }
    return {
        health: 4 + Math.floor(statOf(stats, 'vit') / 5),
        stamina: 3 + Math.floor(statOf(stats, 'agi') / 5),
        mana: 3 + Math.floor(statOf(stats, 'int') / 5),
    };
}

/**
 * What a level adds to a roll (names.js LEVEL): floor(level / divisor), the divisor 5 by default (3 to 8 when the reader's Custom numbers say so). A level is
 * held to 1..99 and a divisor outside 3..8 reads as 5.
 */
export const levelBonus = (level, divisor = 5) => Math.floor(Math.max(1, Math.min(99, num(level))) / (Number.isInteger(divisor) && divisor >= 3 && divisor <= 8 ? divisor : 5));

/** The level a Soul Class stands for where only the class is known (a character block made before levels): class n → level 10n − 5 (I → 5 … IX → 85). */
export const levelOfClass = soul => 10 * Math.max(1, Math.min(9, num(soul))) - 5;

/** The Soul Class (1..9) a level stands for where only a class is asked (the `+ party` line's class): the inverse of levelOfClass (10n - 5), floor(level / 10) + 1 (levels 1-9 are class I, 10-19 II ... 80+ IX). */
export const classOfLevel = level => Math.max(1, Math.min(9, Math.floor(Math.max(1, num(level)) / 10) + 1));

/** A foe's Health blocks: 4 + class/3 (Classes I–II 4, III–V 5, VI–VIII 6, IX 7). */
export const foeHealthBlocks = foeClass => 4 + Math.floor(Math.max(1, num(foeClass)) / 3);

/** What a foe adds to its roll: foeBase + foeClassWeight × class. */
export const foeBonus = (foeClass, numbers = STANDARD_NUMBERS) => num(numbers.foeBase) + num(numbers.foeClassWeight) * Math.max(1, num(foeClass));

/** Turn order: a character adds classBonus + AGI/2; a foe adds 2 × class. (The die is the caller's.) */
export const initiativeBonus = (stats, classBonus) => num(classBonus) + Math.floor(statOf(stats, 'agi') / 2);
export const foeInitiativeBonus = foeClass => 2 * Math.max(1, num(foeClass));

/** One opening action against a foe whose turn-order total is `margin` or more below the character's. */
export const quickStart = (characterTotal, foeTotal, margin = STANDARD_NUMBERS.quickStartMargin) => num(characterTotal) - num(foeTotal) >= num(margin);

/**
 * Turn order for one fight: highest total first; ties go to the higher AGI, then to the party.
 * `entries`: [{ id, total, agi, party: boolean }]. Returns the ids in order.
 */
export function turnOrder(entries) {
    return [...entries]
        .sort((a, b) => num(b.total) - num(a.total) || num(b.agi) - num(a.agi) || Number(Boolean(b.party)) - Number(Boolean(a.party)))
        .map(entry => entry.id);
}

/**
 * A companion the story adds on the Standard scale: every stat 5, the best stat 9, then one point for every third level
 * (floor(level / 3), the same as the Character's own rise) spent one at a time on the best stat and DEX in turn (each up to statMax); once both are full, the rest
 * go to VIT, then AGI, INT, CHA, LUK and STR in that order, so no point is left unspent.
 */
export function companionStats(best, level, numbers = STANDARD_NUMBERS) {
    const max = num(numbers.statMax);
    const stats = Object.fromEntries(STAT_KEYS.map(key => [key, num(numbers.startStat)]));
    const lead = STAT_KEYS.includes(best) ? best : 'str';
    stats[lead] = Math.min(max, num(numbers.startStat) + 4);
    const pairKeys = lead === 'dex' ? ['dex', 'agi'] : [lead, 'dex'];
    const spill = ['vit', 'agi', 'int', 'cha', 'luk', 'str'].filter(key => !pairKeys.includes(key));
    let points = Math.floor(Math.max(0, num(level)) / 3);
    for (let turn = 0; points > 0; turn += 1) {
        const first = pairKeys[turn % 2], second = pairKeys[(turn + 1) % 2];
        const target = [first, second, ...spill].find(key => stats[key] < max);
        if (!target) break;
        stats[target] += 1; points -= 1;
    }
    return stats;
}
