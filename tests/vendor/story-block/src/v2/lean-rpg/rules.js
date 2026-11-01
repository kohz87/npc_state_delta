// The numbers a roll is made with, and the odds they give (Settings → RPG, mockup section 6).
//
// A roll uses six numbers: the foe's base, what a Soul Class adds (×1, ×2 or ×3), how much of a stat counts (half, or a
// third, or the stat − 5: "full above 10"), how far short a total may fall and still be "success at a cost", the margin that makes a round decisive, and
// the most exchanges one reply may hold. Standard is the formula as it always was (names.js FORMULA and LIMITS); Gentle and
// Harsh move the foe's base and the "at a cost" window; Custom is what the reader typed (each number held to its range).
//
// REPLAY RULE: the numbers in force are chosen here, once, when the roll is planned (precall.js), and travel inside the
// `rpg.resolve` payload (`rules`). The payload is what a Re-read, a rebuild and a reload run again, so a roll is always
// made again with the numbers it was first made with, never with today's settings. Changing a setting changes new rolls only.
//
// The Standard stat formula (formula.js) is a second set of numbers: `formula: 'standard'` plus its nine numbers travel in the same
// payload. A payload with no `formula` is Classic and is read exactly as before, so every old roll replays unchanged; Classic's
// own normalised numbers never carry the key.
import { FORMULA, LIMITS } from './names.js';
import { DEFAULT_FORMULA, STANDARD_NUMBERS, foeBonus, statPart } from './formula.js';

/** The numbers, in the order they are stored and shown. */
export const RULE_KEYS = Object.freeze(['foeBase', 'classWeight', 'statDivisor', 'costMargin', 'decisiveMargin', 'roundCap']);

/**
 * What each number may be: whole numbers, `min` to `max`. A stat divisor is 2 or 3 (or STAT_ABOVE, below), a Soul Class weight 1, 2 or 3.
 */
export const RULE_RANGES = Object.freeze({
    foeBase: Object.freeze({ min: 0, max: 15 }),
    classWeight: Object.freeze({ min: 1, max: 3 }),
    statDivisor: Object.freeze({ min: 2, max: 3 }),
    costMargin: Object.freeze({ min: 0, max: 5 }),
    decisiveMargin: Object.freeze({ min: 4, max: 15 }),
    roundCap: Object.freeze({ min: 1, max: 8 }),
});

/**
 * The stat divisor that stands for "full above 10": the stat adds its value − 5 (10 → +5, 14 → +9, 20 → +15, 8 → +3). It is a value of
 * `statDivisor`, so a set of numbers still has the same six keys and one recorded before it existed reads exactly as it did.
 */
export const STAT_ABOVE = 0;
export const STAT_ABOVE_FROM = 5;

/** What a stat of `value` adds under `rules`: half or a third of it (rounded down), or, for STAT_ABOVE, the stat − 5. */
export const statShare = (value, rules) => (rules.statDivisor === STAT_ABOVE ? value - STAT_ABOVE_FROM : Math.floor(value / rules.statDivisor));

const preset = (foeBase, costMargin) => Object.freeze({
    foeBase, classWeight: 2, statDivisor: 2, costMargin, decisiveMargin: LIMITS.decisiveMargin, roundCap: LIMITS.roundCap,
});

/** The three presets. Standard is today's formula. */
export const PRESETS = Object.freeze({
    gentle: preset(3, 3),
    standard: preset(FORMULA.foeBase, FORMULA.costMargin),
    harsh: preset(7, 1),
});
export const STANDARD = PRESETS.standard;

/** The choices the reader sees, in order. */
export const DIFFICULTIES = Object.freeze(['gentle', 'standard', 'harsh', 'custom']);

/** The settings (Story Block's own bucket): the difficulty word, the Custom numbers and the roll planner's extra instructions. */
export const DIFFICULTY_SETTING = 'rpgDifficulty';
export const CUSTOM_SETTING = 'rpgCustom';
export const NOTE_SETTING = 'rpgPlannerNote';
export const NOTE_MAX = 400;

// ---- the Standard formula's numbers ------------------------------------------------------------------------------------

/** The setting that picks the stat formula (Settings → RPG): 'standard' (the default for a chat that never chose) or 'classic'. */
export const FORMULA_SETTING = 'rpgFormula';
/** The Custom numbers of the Standard formula (an object of STANDARD_RULE_KEYS). */
export const STANDARD_SETTING = 'rpgStandard';

/**
 * The formula the settings say: what the reader chose, else the one the story's pack asks for (`pack`, packRulesOf), else Standard. Classic
 * is only ever a choice: a chat the reader never touched is on Standard.
 */
export const formulaOf = (values, pack = null) => {
    const chosen = values?.[FORMULA_SETTING];
    if (chosen === 'classic' || chosen === 'standard') return chosen;
    return pack?.formula === 'classic' ? 'classic' : DEFAULT_FORMULA;
};

/**
 * What a pack asks for, from its `content.rpg` records (packs/validate.js keeps `formula` and `numbers` as one record with the slug `formula`):
 * `{ formula?, numbers? }`, or null. The reader's own choices win over it: it is the default of a story whose reader has not chosen.
 */
export function packRulesOf(records) {
    const found = (Array.isArray(records) ? records : []).find(record => record && typeof record === 'object' && record.slug === 'formula' && (record.formula || record.numbers));
    if (!found) return null;
    return { ...(typeof found.pack === 'string' ? { pack: found.pack } : {}), ...(found.formula === 'standard' || found.formula === 'classic' ? { formula: found.formula } : {}),
        ...(found.numbers && typeof found.numbers === 'object' && !Array.isArray(found.numbers) ? { numbers: { ...found.numbers } } : {}) };
}

/** Standard's numbers in the order they are stored and shown (the first is the formula itself). */
export const STANDARD_RULE_KEYS = Object.freeze(['formula', 'foeBase', 'foeClassWeight', 'classWeight', 'costMargin', 'decisiveMargin', 'roundCap',
    'startStat', 'createPoints', 'createMin', 'createMax', 'pointsPerSoul', 'statMax', 'quickStartMargin']);

/** What each of Standard's numbers may be (whole numbers, `min` to `max`). */
export const STANDARD_RANGES = Object.freeze({
    foeBase: Object.freeze({ min: 0, max: 15 }),
    foeClassWeight: Object.freeze({ min: 1, max: 5 }),
    classWeight: Object.freeze({ min: 1, max: 3 }),
    costMargin: Object.freeze({ min: 0, max: 5 }),
    decisiveMargin: Object.freeze({ min: 4, max: 15 }),
    roundCap: Object.freeze({ min: 1, max: 8 }),
    startStat: Object.freeze({ min: 1, max: 10 }),
    createPoints: Object.freeze({ min: 0, max: 30 }),
    createMin: Object.freeze({ min: 1, max: 10 }),
    createMax: Object.freeze({ min: 3, max: 20 }),
    pointsPerSoul: Object.freeze({ min: 0, max: 10 }),
    statMax: Object.freeze({ min: 10, max: 20 }),
    quickStartMargin: Object.freeze({ min: 1, max: 30 }),
});

const standardPreset = foeBase => {
    const all = { formula: 'standard', ...STANDARD_NUMBERS, foeBase, classWeight: FORMULA.classWeight, costMargin: FORMULA.costMargin, decisiveMargin: LIMITS.decisiveMargin, roundCap: LIMITS.roundCap };
    return Object.freeze(Object.fromEntries(STANDARD_RULE_KEYS.map(key => [key, all[key]])));
};

/**
 * Standard's three presets: only the foe's base moves (simulation, scripts/sim-standard.mjs: a focused build against a foe of its own
 * Soul Class succeeds about 65 to 80 times in a hundred across Soul Classes I to IX at Standard, a spread build 45 to 60).
 */
export const STANDARD_PRESETS = Object.freeze({
    gentle: standardPreset(2),
    standard: standardPreset(4),
    harsh: standardPreset(6),
});
export const STANDARD_FORMULA = STANDARD_PRESETS.standard;

/** Whether numbers are the Standard formula's. */
export const isStandard = rules => rules?.formula === 'standard';

const whole = (value, range, fallback) => (Number.isSafeInteger(value) && value >= range.min && value <= range.max ? value : fallback);

/**
 * Any value as a full set of numbers: each one a whole number inside its range, else Standard's. Always the same six keys in
 * the same order (so the same numbers always hash the same), whatever was given, including nothing.
 */
export function normalizeRules(value) {
    const given = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (given.formula === 'standard') return normalizeStandard(given);
    return Object.fromEntries(RULE_KEYS.map(key => [key, key === 'statDivisor' && given[key] === STAT_ABOVE ? STAT_ABOVE : whole(given[key], RULE_RANGES[key], STANDARD[key])]));
}

/**
 * Any value as Standard's full set of numbers: each one a whole number inside its range, else the Standard preset's; the creation numbers
 * must also agree (lowest ≤ start ≤ highest at creation ≤ the stat maximum), else all four are the preset's. Always the same keys in the same order.
 */
export function normalizeStandard(value) {
    const given = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = Object.fromEntries(STANDARD_RULE_KEYS.map(key => [key, key === 'formula' ? 'standard' : whole(given[key], STANDARD_RANGES[key], STANDARD_FORMULA[key])]));
    if (!(out.createMin <= out.startStat && out.startStat <= out.createMax && out.createMax <= out.statMax)) {
        for (const key of ['startStat', 'createMin', 'createMax', 'statMax']) out[key] = STANDARD_FORMULA[key];
    }
    return out;
}

/** The difficulty the settings say: a known word, else Standard. */
export const difficultyOf = values => (DIFFICULTIES.includes(values?.[DIFFICULTY_SETTING]) ? values[DIFFICULTY_SETTING] : 'standard');

/** The numbers the settings give now: the preset, or the Custom numbers (held to their ranges); `pack` (packRulesOf) fills in what the reader has not chosen. */
export function rulesFromSettings(values, pack = null) {
    const difficulty = difficultyOf(values), standard = formulaOf(values, pack) === 'standard';
    if (difficulty === 'custom') return standard ? normalizeStandard({ ...values?.[STANDARD_SETTING], formula: 'standard' }) : normalizeRules(values?.[CUSTOM_SETTING]);
    const preset = standard ? { ...STANDARD_PRESETS[difficulty] } : { ...PRESETS[difficulty] };
    // A pack's numbers are the defaults of a reader who never picked a difficulty, and only for the formula the pack named (its numbers are on that
    // formula's scale); a picked difficulty is the reader's.
    const asked = pack?.numbers && (!pack.formula || (pack.formula === 'standard') === standard) && !DIFFICULTIES.includes(values?.[DIFFICULTY_SETTING]) ? pack.numbers : null;
    return asked ? (standard ? normalizeStandard({ ...preset, ...asked, formula: 'standard' }) : normalizeRules({ ...preset, ...asked })) : preset;
}

/**
 * What of a pack's ask is in force now: `{ formula, numbers }` booleans. The formula is the pack's when the reader has not chosen one; the numbers are
 * the pack's when the reader has not picked a difficulty and they are on the scale of the formula in force (the rules of rulesFromSettings).
 */
export function packInForce(values, pack) {
    if (!pack) return { formula: false, numbers: false };
    const chosen = values?.[FORMULA_SETTING] === 'classic' || values?.[FORMULA_SETTING] === 'standard';
    const standard = formulaOf(values, pack) === 'standard';
    return { formula: Boolean(pack.formula) && !chosen,
        numbers: Boolean(pack.numbers) && (!pack.formula || (pack.formula === 'standard') === standard) && !DIFFICULTIES.includes(values?.[DIFFICULTY_SETTING]) && difficultyOf(values) !== 'custom' };
}

/** The extra instructions for the roll planner: text, tidied, at most NOTE_MAX characters. */
export function plannerNoteOf(values) {
    const raw = typeof values?.[NOTE_SETTING] === 'string' ? values[NOTE_SETTING] : '';
    return [...raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()].slice(0, NOTE_MAX).join('').trim();
}

/** Whether two sets of numbers are the same numbers. */
export const sameRules = (a, b) => {
    const [x, y] = [normalizeRules(a), normalizeRules(b)];
    return isStandard(x) === isStandard(y) && Object.keys(x).every(key => x[key] === y[key]);
};

/** The preset these numbers are exactly, else 'custom'. */
export const presetOf = rules => DIFFICULTIES.slice(0, 3).find(name => sameRules(isStandard(rules) ? STANDARD_PRESETS[name] : PRESETS[name], rules)) ?? 'custom';

/**
 * The exact chances of one roll under `rules`: the party member's d20 + `bonus` against a foe's d20 + the foe's base + the
 * Soul Class weight × `foeClass`, the outcome rule of resolve.js (a natural 20 succeeds, a natural 1 fails, a total that
 * reaches the foe's succeeds, one within `costMargin` short is a success at a cost). Counts all 400 pairs of dice.
 * → { success, cost, fail }, whole percentages each rounded on its own (they may add up to 99 or 101).
 */
export function oddsFor(rules, { bonus, foeClass }) {
    const r = normalizeRules(rules), die = FORMULA.die;
    let success = 0, cost = 0, fail = 0;
    for (let mine = 1; mine <= die; mine += 1) {
        for (let theirs = 1; theirs <= die; theirs += 1) {
            const total = mine + bonus, against = theirs + (isStandard(r) ? foeBonus(foeClass, r) : r.foeBase + r.classWeight * foeClass);
            if (mine === die || (mine !== 1 && total >= against)) success += 1;
            else if (mine !== 1 && total >= against - r.costMargin) cost += 1;
            else fail += 1;
        }
    }
    const percent = count => Math.round((count * 100) / (die * die));
    return { success: percent(success), cost: percent(cost), fail: percent(fail) };
}

/**
 * Who the odds are shown for: the reader's own character (by name, else the first Character block), the skill they are best
 * at (highest rank, the first on a tie; none: their best stat untrained), against a foe of their own Soul Class.
 * `sheet` is readSheet's answer, `own` the reader's name, `names` = { rank: [...], soul: [...] } the words for ranks and classes; `standard`
 * adds the character's stats and the skill's resource, which the Standard formula needs.
 * → null (no character), else { who, label, stat, statValue, soul, rank, rankName, soulName (the Character block's own word for it), skill, bonus (under `rules`), foeClass }.
 */
export function oddsSubject(sheet, own, { rankNames, soulNames, fold, standard = false }) {
    const characters = sheet?.characters ?? [];
    const mine = own ? characters.find(entry => fold(entry.who) === fold(own)) : null;
    const who = mine ?? characters[0];
    if (!who) return null;
    const best = who.skills.reduce((top, skill) => (!top || skill.rank > top.rank ? skill : top), null);
    const strongest = Object.entries(who.stats).filter(([, value]) => Number.isInteger(value)).reduce((top, entry) => (!top || entry[1] > top[1] ? entry : top), null);
    // (Standard: a skill with no stat of its own, or no skill, rolls the type's own: INT for a mana skill, else STR.)
    const fallback = standard ? (best?.uses === 'mana' ? 'int' : 'str') : strongest?.[0] ?? null;
    const stat = best?.stat && Number.isInteger(who.stats[best.stat]) ? best.stat : fallback;
    if (!stat || !Number.isInteger(who.stats[stat])) return null;
    const rank = best?.rank ?? 0;
    return {
        who: who.who, stat, statValue: who.stats[stat], soul: who.soul, rank, skill: best?.name ?? null, foeClass: who.soul,
        ...(standard ? { stats: who.stats, uses: best?.uses ?? null } : {}),
        rankName: best ? rankNames[rank] ?? String(rank) : '', soulName: who.soulWord ?? soulNames[who.soul - 1] ?? String(who.soul),
    };
}

/** The bonus the subject rolls with under `rules` (the stat's share, the Soul Class and the skill rank), and the odds against a foe of their class. */
export function subjectOdds(rules, subject) {
    const r = normalizeRules(rules);
    // Standard: the skill's stat in the main slot with half of DEX (a stamina skill is physical, a mana skill magic), halved.
    const stat = isStandard(r) ? statPart(subject.uses === 'mana' ? 'magic' : 'physical', subject.stats ?? { [subject.stat]: subject.statValue }, { skillStat: subject.stat }).value : statShare(subject.statValue, r);
    const bonus = stat + r.classWeight * subject.soul + subject.rank;
    return { bonus, ...oddsFor(r, { bonus, foeClass: subject.foeClass }) };
}
